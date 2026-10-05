import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { agentLaunch, laneOpen, projectOpen, type AgentLaunchInput } from "./ops.ts";
import { promptWithProof } from "./herdr.ts";
import { mutate } from "./store.ts";
import { FakeHerdr, harness, makeRepo, runWith } from "./test-support.ts";
import { MusterEnv, Proc, type EnvShape, type ProcShape } from "./runtime.ts";

async function setup(collision = false) {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "remote delivery", reviewTrigger: "weekly", nextAction: "launch", criticalPath: [], space: "w1", sidebar: false, ephemeral: true, cadenceMinutes: 15, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "remote delivery" }));
  const remote = new FakeHerdr(h.home);
  const holder = collision ? remote.addPane("w1", "t-holder", dir) : null;
  if (holder) { holder.agent = "pi"; holder.name = "remote-worker"; }
  const proc: ProcShape = { run: (command, args, options) => {
    if (command !== "ssh") return h.proc.run(command, args, options);
    const script = args.at(-1) ?? "";
    if (["'node' '-e'", "'git'", "'mkdir'", "'mktemp'"].some(part => script.includes(part))) return h.proc.run("sh", ["-c", script], { ...options, cwd: dir });
    return Effect.succeed({ code: 0, stdout: script.includes("'printenv' 'PATH'") ? "/usr/bin\n" : "", stderr: "" });
  } };
  const env: EnvShape = {
    home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/owner/muster", workerWorktree: h.workerWorktree,
    createId: () => "remote-id", sleep: ms => Effect.sync(() => h.sleep(ms)), emitPaneClose: h.emitPaneClose,
    machines: { remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/remote/muster", workerWorktree: h.workerWorktree, env: {}, wrap: [] } },
    remoteHerdr: () => Effect.succeed(remote.client()),
  };
  const launch = (extra: Partial<AgentLaunchInput> = {}) => runWith(h, agentLaunch(dir, {
    action: "launch", machine: "remote", name: "remote-worker", role: "worker", lane: "work", label: "remote worker", cwd: dir, noSkills: true, prompt: "Do the remote work.", ...extra,
  }).pipe(Effect.provideService(MusterEnv, env), Effect.provideService(Proc, proc)));
  return { h, dir, remote, holder, launch, proc };
}

describe("remote launch argv delivery", () => {
  it("delivers by argv and names the detected Pi for watches without typing a prompt", async () => {
    const s = await setup();
    const result = await s.launch();
    expect(s.remote.typedPrompts).toEqual([]);
    expect(s.remote.initialPrompts).toEqual(["Do the remote work."]);
    expect(result.proof).toMatchObject({ state: "proven", via: "argv" });
    expect(s.remote.panes.get(result.row.pane!.paneId)?.name).toBe("remote-worker");
    const input = String(s.remote.calls.find(call => call.method === "pane.send_input")?.params.text);
    expect(input).toMatch(/^exec sh '/);
    expect(input.length).toBeLessThan(800);
    expect(s.remote.calls.some(call => call.method === "agent.prompt")).toBe(false);
    expect(s.h.herdr.calls.some(call => call.method === "agent.prompt" || call.method === "agent.rename")).toBe(false);
    expect(result.row.restore?.argv).not.toContain("--");
  });

  it("reports the name holder without stealing; delivery does not depend on naming", async () => {
    const s = await setup(true);
    const result = await s.launch();
    expect(result.notes.join("\n")).toContain("agent_name_taken");
    expect(result.notes.join("\n")).toContain(`pane_id=${s.holder!.pane_id}`);
    expect(s.holder!.name).toBe("remote-worker");
    expect(s.remote.panes.get(result.row.pane!.paneId)?.name).toBeNull();
    expect(s.remote.typedPrompts).toEqual([]);
    expect(s.remote.initialPrompts).toEqual(["Do the remote work."]);
    expect(result.proof).toMatchObject({ state: "proven", via: "argv" });
  });

  it("copies a complete long prompt and launcher privately; the typed line stays short", async () => {
    const s = await setup();
    const prompt = "A complete task.\n" + "quote ' $ ; --tools @file work ".repeat(500);
    const result = await s.launch({ prompt });
    const fileArg = result.argv.at(-1)!;
    expect(fileArg).toMatch(/^@\//);
    expect(readFileSync(fileArg.slice(1), "utf8")).toBe(prompt);
    expect(statSync(fileArg.slice(1)).mode & 0o777).toBe(0o600);
    expect(s.remote.initialPrompts[0]).toContain(prompt);
    expect(result.row.delivery).toBe("proven");
    const input = String(s.remote.calls.find(call => call.method === "pane.send_input")?.params.text);
    const script = /^exec sh '(.+)'$/.exec(input)![1]!;
    expect(statSync(script).mode & 0o777).toBe(0o600);
    expect(input.length).toBeLessThan(800);
    expect(input).not.toContain("export");
    expect(s.remote.typedPrompts).toEqual([]);
  });

  it("keeps a failed long-start repair small and points at the complete prompt", async () => {
    const s = await setup();
    s.remote.firstTurn = "error";
    const prompt = "Private complete task.\n" + "work ".repeat(1000);
    const result = await s.launch({ prompt });
    expect(result.row.delivery).toBe("unproven");
    expect(result.proof).toMatchObject({ state: "unproven", repairPrompt: expect.stringMatching(/^Read the complete work prompt at /) });
    if (!("repair" in result) || !result.repair) throw new Error("missing repair");
    expect(result.repair.args.prompt!.length).toBeLessThan(800);
    const file = result.argv.at(-1)!.slice(1);
    expect(result.repair.args.prompt).toContain(file);
    expect(readFileSync(file, "utf8")).toBe(prompt);
    expect(s.remote.typedPrompts).toEqual([]);
  });

  it("uses @brief alone as the complete first message", async () => {
    const s = await setup();
    const brief = join(s.dir, "brief.md");
    writeFileSync(brief, "Do this precise task. Report through owner_note.");
    const result = await s.launch({ brief, prompt: undefined });
    expect(result.argv).toContain(`@${brief}`);
    expect(s.remote.initialPrompts[0]).toContain("Do this precise task.");
    expect(s.remote.initialPrompts[0]).toContain("owner_note");
    expect(result.row.delivery).toBe("proven");
    expect(result.argv.slice(-2)).toEqual(["--", `@${brief}`]);
  });

  it("retains an extra prompt and the brief in one complete private prompt file", async () => {
    const s = await setup();
    const brief = join(s.dir, "brief.md");
    writeFileSync(brief, "Original brief contents.");
    const result = await s.launch({ brief, prompt: "Extra instructions." });
    const file = result.argv.at(-1)!.slice(1);
    expect(file).not.toBe(brief);
    expect(readFileSync(file, "utf8")).toContain("Extra instructions.");
    expect(readFileSync(file, "utf8")).toContain("Original brief contents.");
    expect(result.row.delivery).toBe("proven");
  });

  it("forks with an initial message but restores with no message or post-start typing", async () => {
    const s = await setup();
    await s.launch();
    const fork = await s.launch({ action: "fork", from: "remote-worker", name: "child", prompt: "New child work." });
    expect(fork.row.delivery).toBe("proven");
    expect(fork.argv).toContain("--fork");
    expect(fork.argv.slice(-2)).toEqual(["--", "New child work."]);
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => row.name === "child" ? { ...row, state: "failed" as const } : row) }, null] as const)));
    const restore = await s.launch({ action: "restore", name: "child", prompt: undefined });
    expect(restore.argv).not.toContain("--");
    expect(restore.proof).toBeNull();
    expect(restore.row.delivery).toBe("none");
    expect(s.remote.typedPrompts).toEqual([]);
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => row.name === "child" ? { ...row, state: "failed" as const } : row) }, null] as const)));
    const explicit = await s.launch({ action: "restore", name: "child", prompt: "Explicit new work." });
    expect(explicit.argv.slice(-2)).toEqual(["--", "Explicit new work."]);
    expect(explicit.row.restore?.argv).not.toContain("--");
    expect(explicit.row.delivery).toBe("proven");
  });

  it("does not prove a launch retry from an old matching user and assistant pair", async () => {
    const s = await setup();
    const parent = await s.launch();
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, state: "failed" as const })) }, null] as const)));
    s.remote.autoLaunch = false;
    s.h.sleep = ms => { s.h.now = new Date(s.h.now.getTime() + ms * 90); };
    const handle = s.remote.handle.bind(s.remote);
    s.remote.handle = (method, params) => {
      const result = handle(method, params);
      if (method === "pane.send_input") {
        const pane = s.remote.panes.get(String(params.pane_id))!;
        pane.agent = "pi";
        pane.agent_session = { agent: "pi", source: "pi", kind: "path", value: parent.row.sessionFile! };
      }
      return result;
    };
    const retry = await s.launch();
    expect(retry.row.sessionId).toBe(parent.row.sessionId);
    expect(retry.row.delivery).toBe("unproven");
    expect(retry.proof).toMatchObject({ state: "unproven", firstTurn: true, detail: "no matching user entry within 90 s" });
    expect(s.remote.initialPrompts).toHaveLength(1);
    expect(s.remote.typedPrompts).toEqual([]);
  });

  it.each(["pi", "claude"])("refuses a local start into a pane still hosting %s without typing", async agent => {
    const s = await setup();
    const pane = s.h.herdr.addPane("w1", "external", s.dir);
    pane.agent = agent;
    pane.name = "outsider";
    await expect(runWith(s.h, agentLaunch(s.dir, { action: "launch", name: "blocked", role: "worker", lane: "work", label: "blocked", cwd: s.dir, pane: pane.pane_id, prompt: "Do the work." }))).rejects.toThrow(`launch pane ${pane.pane_id} still hosts agent ${agent}`);
    expect(s.h.herdr.calls.some(call => call.method === "pane.send_input")).toBe(false);
  });

  it("does not prove a fork from its parent's identical old work message", async () => {
    const s = await setup();
    await s.launch();
    s.remote.firstTurn = "missing";
    s.h.sleep = ms => { s.h.now = new Date(s.h.now.getTime() + ms * 90); };
    const child = await s.launch({ action: "fork", from: "remote-worker", name: "child" });
    expect(child.proof).toMatchObject({ state: "unproven", firstTurn: true });
    expect(child.row.delivery).toBe("unproven");
    expect(s.remote.typedPrompts).toEqual([]);
  });

  it("proves the fresh turn with an inherited journal larger than 2 MiB", async () => {
    const s = await setup();
    const parent = await s.launch();
    appendFileSync(parent.row.sessionFile!, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "history ".repeat(400_000) }], stopReason: "stop" } })}\n`);
    const child = await s.launch({ action: "fork", from: "remote-worker", name: "large-child", prompt: "Fresh work after large history." });
    expect(statSync(child.row.sessionFile!).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(child.proof).toMatchObject({ state: "proven", via: "argv" });
    expect(child.row.delivery).toBe("proven");
  });

  it.each(["local", "remote"] as const)("waits for Pi's first journal write on a fresh %s launch instead of reporting the boundary unavailable", async machine => {
    const s = await setup();
    const fake = machine === "remote" ? s.remote : s.h.herdr;
    fake.lazyJournal = true;
    let sleeps = 0;
    s.h.sleep = () => { if (++sleeps === 3) fake.flushJournals(); };
    const result = machine === "remote" ? await s.launch() : await runWith(s.h, agentLaunch(s.dir, {
      action: "launch", name: "local-worker", role: "worker", lane: "work", label: "local worker", cwd: s.dir, noSkills: true, prompt: "Do the local work.",
    }));
    expect(sleeps).toBeGreaterThanOrEqual(3);
    expect(result.proof).toMatchObject({ state: "proven", via: "argv" });
    expect(result.row.delivery).toBe("proven");
    expect(fake.typedPrompts).toEqual([]);
  });

  it("reports a fresh launch whose journal never appears as unproven after the first-turn window", async () => {
    const s = await setup();
    s.remote.lazyJournal = true;
    const result = await s.launch();
    expect(result.proof).toMatchObject({ state: "unproven", detail: "no session journal entries within 90 s" });
  });

  it.each(["local", "remote"] as const)("executes the %s launcher end to end with exact env, cwd and argv", async machine => {
    const s = await setup();
    const bin = join(s.h.root, "bin");
    mkdirSync(bin);
    const record = join(s.h.root, "argv.json");
    const executable = join(bin, "pi");
    writeFileSync(executable, `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('1.0.3');process.exit(0)}require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),secret:process.env.TEST_LAUNCH_VALUE}));\n`);
    chmodSync(executable, 0o700);
    const prompt = "Exact quote ' dollar $ and newline\n" + "work ".repeat(200);
    const value = "spaces ' quotes $ and ;";
    const result = machine === "remote" ? await s.launch({ prompt, env: { PATH: `${bin}:${process.env.PATH}`, HOME: s.h.home, TEST_LAUNCH_VALUE: value } }) : await runWith(s.h, agentLaunch(s.dir, {
      action: "launch", name: "local-worker", role: "worker", lane: "work", label: "local worker", cwd: s.dir, noSkills: true, prompt,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: s.h.home, TEST_LAUNCH_VALUE: value },
    }));
    const fake = machine === "remote" ? s.remote : s.h.herdr;
    const typed = String(fake.calls.find(call => call.method === "pane.send_input")!.params.text);
    execFileSync("sh", ["-c", typed], { stdio: "pipe" });
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ argv: result.argv, cwd: s.dir, secret: value });
    expect(result.row.delivery).toBe("proven");
    expect(fake.typedPrompts).toEqual([]);
  });

  it("keeps unnamed re-prompt submission blocked by default", async () => {
    const h = harness();
    const pane = h.herdr.addPane("w1", "t1", h.root);
    h.herdr.handle("agent.start", { name: "worker", pane_id: pane.pane_id, args: [] });
    pane.name = null;
    const proof = await runWith(h, promptWithProof(pane.pane_id, "Do the local work."));
    expect(proof).toMatchObject({ state: "unproven", submission: "uncertain" });
    expect(h.herdr.typedPrompts).toEqual([]);
  });
});
