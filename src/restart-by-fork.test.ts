import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLaunchForeground as agentLaunch, finishRestart, laneOpen, packetReport, packetVerify, projectOpen, projectStatus, projectUpdate } from "./ops.ts";
import { load, mutate, projectPath } from "./store.ts";
import { FakeHerdr, harness, makeRepo, runWith } from "./test-support.ts";
import { Comms, MusterEnv, Proc, type EnvShape, type ProcShape } from "./runtime.ts";
import { appendOwnerItem, ingestOwnerItem } from "./owner-queue.ts";
import { ownerFeed } from "./owner-feed.ts";
import muster, { CARRIED_HEADER, registerRestartExit } from "./extension-main.ts";
import * as ops from "./ops.ts";
import { InputError } from "./errors.ts";
const sessionSuccessorsPath = (home: string) => join(home, ".local/state/muster/session-successors.jsonl");
import { snapshotRestartSession } from "./herdr.ts";
import { existsSync } from "node:fs";

beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_PROJECT", ""); vi.stubEnv("MUSTER_MACHINE", ""); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup(remote = false, role: "worker" | "desk" = "worker") {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "restart", reviewTrigger: "weekly", nextAction: "test", criticalPath: [], space: "w1", sidebar: false, ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "restart" }));
  const host = remote ? new FakeHerdr(h.home) : h.herdr;
  const proc: ProcShape = { run: (command, args, options) => {
    if (command === "ssh") {
      const script = args.at(-1) ?? "";
      if (script.includes("snapshotRestartSession")) return Effect.sync(() => {
        const quoted = [...script.matchAll(/'([^']*)'/g)].map(match => match[1]!);
        const at = quoted.map(arg => arg.endsWith(".jsonl")).lastIndexOf(true);
        snapshotRestartSession(quoted[at - 1]!, quoted[at]!, quoted[at + 1] || undefined);
        return { code: 0, stdout: "", stderr: "" };
      });
      if (script.includes("'muster-prerequisites'") || script.includes(" 'test'") || script.includes(" 'pi'")) return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      return h.proc.run("sh", ["-c", script], { ...options, cwd: dir });
    }
    if (command === "pi") return Effect.succeed({ code: 0, stdout: "", stderr: "" });
    return h.proc.run(command, args, options);
  } };
  const env: EnvShape = { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: dir, workerWorktree: h.workerWorktree,
    createId: () => "receipt", sleep: ms => Effect.sync(() => h.sleep(ms)), emitPaneClose: h.emitPaneClose,
    machines: { remote: { comms: { config: "/private/network.json" }, herdr: "remote", ssh: "remote", paths: {}, musterExtension: dir, workerWorktree: h.workerWorktree, env: { MUSTER_FLEET_COMPUTE: "off", HOME: h.home }, wrap: [] } },
    remoteHerdr: () => Effect.succeed(host.client()),
  };
  const run = <A, E>(effect: Effect.Effect<A, E, MusterEnv | Proc | import("./runtime.ts").Herdr | import("./runtime.ts").Comms>) => runWith(h, effect.pipe(Effect.provideService(MusterEnv, { ...env, sessionId: h.sessionId }), Effect.provideService(Proc, proc)));
  const launch = await run(agentLaunch(dir, { action: "launch", machine: remote ? "remote" : "local", name: "worker", role, lane: "work", label: "worker", cwd: dir, noSkills: true, prompt: "Initial work." }));
  return { h, dir, host, run, launch, env, proc };
}

describe("restart by fork", () => {
  it.each([false, true])("a non-owner restarts its own session from a moved pane (remote %s)", async remote => {
    const s = await setup(remote);
    const old = s.launch.row;
    s.h.sessionId = old.sessionId;
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, owner: "other-owner" })) }, undefined] as const)));
    s.host.panes.delete(old.pane!.paneId);
    const moved = s.host.addPane("w1", "moved-tab", s.dir);
    moved.agent = "pi"; moved.agent_session = { source: "pi", agent: "pi", kind: "path", value: old.sessionFile! };
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }));
    expect(result.row.owner).toBe("other-owner");
    expect(result.row.sessionId).not.toBe(old.sessionId);
    expect("endSession" in result ? result.endSession?.oldPane : undefined).toMatchObject({ paneId: moved.pane_id, terminalId: moved.terminal_id, openedByMuster: false });
    expect(s.host.calls.filter(call => ["pane.send_input", "pane.send_keys", "pane.close"].includes(call.method) && call.params.pane_id === moved.pane_id)).toEqual([]);
  });

  // Ernestine, 2026-10-17: rat-king 0b233bf renamed a restarted desk because a fork answering to its parent's name is a
  // sibling to pi-ratking. A restart says it succeeds the parent, for this launch only.
  it("restart keeps the row's Rat King name and names the session it succeeds, without saving that on the row", async () => {
    const s = await setup();
    const old = s.launch.row;
    const name = old.restore?.env.RATKING_NAME;
    expect(name).toMatch(/\/w1$|\//);
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name }));
    const script = s.host.launcherScripts.at(-1)!;
    expect(script).toContain(`RATKING_SUCCEEDS='${old.sessionId}'`);
    expect(script).toContain(`RATKING_NAME='${name}'`);
    expect(result.row.restore?.env.RATKING_NAME).toBe(name);
    expect(result.row.restore?.env).not.toHaveProperty("RATKING_SUCCEEDS");
  });

  // Switchboard, 2026-10-19: restoring a session that a restart forked claimed `<row>-<label>`, since pi-ratking reads
  // its resume as a fork. The restore names the parent it succeeds, and adds extensions instead of replacing them.
  it("a restore of a restarted session names the session it succeeds and keeps the row's extensions", async () => {
    const s = await setup();
    const old = s.launch.row;
    const restarted = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name }));
    // The journal Pi writes for the fork: its header names the restart snapshot, whose header is the old session.
    const snapshot = join(dirname(old.sessionFile!), "snapshot.jsonl");
    writeFileSync(snapshot, readFileSync(old.sessionFile!, "utf8"));
    const journal = join(dirname(old.sessionFile!), `fork_${restarted.row.sessionId}.jsonl`);
    writeFileSync(journal, `${JSON.stringify({ type: "session", version: 3, id: restarted.row.sessionId, parentSession: snapshot })}\n`);
    expect(JSON.parse(readFileSync(snapshot, "utf8").split("\n")[0]!).id).toBe(old.sessionId);
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === "worker" ? { ...row, sessionFile: journal, profile: { ...row.profile, extensions: ["/x/bridge.ts", "/x/ratking.ts"] } } : row) }, undefined] as const)));
    await s.run(ops.agentClose(s.dir, { name: "worker" }));
    const restored = await s.run(agentLaunch(s.dir, { action: "restore", name: "worker", extensions: ["/x/state.ts", "/x/ratking.ts"] }));
    const script = s.host.launcherScripts.at(-1)!;
    expect(script).toContain(`RATKING_SUCCEEDS='${s.launch.row.sessionId}'`);
    expect(restored.row.restore?.env).not.toHaveProperty("RATKING_SUCCEEDS");
    expect(restored.row.profile.extensions).toEqual(["/x/bridge.ts", "/x/ratking.ts", "/x/state.ts"]);
  });

  it("a restart adds named extensions and env to the row and the new pane's launch", async () => {
    const s = await setup();
    const old = s.launch.row;
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === old.name ? { ...row, profile: { ...row.profile, extensions: ["/x/bridge.ts"], env: { KEEP: "1" } } } : row) }, undefined] as const)));
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name, extensions: ["/x/peons", "/x/bridge.ts"], env: { PEONS_ON: "1" } }));
    expect(result.row.profile.extensions).toEqual(["/x/bridge.ts", "/x/peons"]);
    expect(result.row.profile.env).toEqual({ KEEP: "1", PEONS_ON: "1" });
    const script = s.host.launcherScripts.at(-1)!;
    expect(script).toContain("/x/peons");
    expect(script).toContain("PEONS_ON='1'");
    const dropped = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name, extensions: ["!/x/peons", "/x/peons/extensions/pi"] }));
    expect(dropped.row.profile.extensions).toEqual(["/x/bridge.ts", "/x/peons/extensions/pi"]);
    expect(s.host.launcherScripts.at(-1)!).not.toContain("'/x/peons'");
  });

  it("a session with no parent names no successor", () => {
    const root = mkdtempSync(join(tmpdir(), "succession-"));
    const lone = join(root, "lone.jsonl");
    writeFileSync(lone, `${JSON.stringify({ type: "session", id: "lone" })}\n`);
    const parent = join(root, "parent.jsonl");
    writeFileSync(parent, `${JSON.stringify({ type: "session", id: "old-session" })}\n{"type":"message"}\n`);
    const child = join(root, "child.jsonl");
    writeFileSync(child, `${JSON.stringify({ type: "session", id: "new-session", parentSession: parent })}\n`);
    expect(ops.resumeSuccession(lone)).toBeNull();
    expect(ops.resumeSuccession(child)).toBe("old-session");
    expect(ops.resumeSuccession(join(root, "missing.jsonl"))).toBeNull();
    expect(ops.resumeSuccession(null)).toBeNull();
  });

  // Ernestine SOP, 2026-10-12: a provider switch happens only by restart with model; restart used to ignore model.
  it("switches the model and thinking at the fork when restart names them, and keeps them on the row", async () => {
    const s = await setup();
    const old = s.launch.row;
    appendFileSync(old.sessionFile!, "\n" + JSON.stringify({ type: "model_change", provider: "claude-bridge", modelId: "claude-opus-5-5" }) + "\n");
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name, model: "openai-codex/gpt-6.1-sol", thinking: "medium" }));
    expect(result.argv).toContain("openai-codex/gpt-6.1-sol:medium");
    expect(result.row.profile).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "medium" });
    expect(result.notes.join("\n")).toContain("from explicit model");
  });

  // Ernestine, 2026-10-18: Pi kept a fork's launch thinking level in memory only, so the forked file still said high,
  // the clamp check warned falsely, and resuming the file went back to high.
  it("records the launch thinking level as the snapshot leaf when the parent recorded another", async () => {
    const s = await setup();
    const old = s.launch.row;
    appendFileSync(old.sessionFile!, "\n" + JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-10-15T00:00:00Z", thinkingLevel: "high" }) + "\n");
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name, thinking: "medium" }));
    const snapshot = readFileSync(result.argv[result.argv.indexOf("--fork") + 1]!, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const leaf = snapshot.at(-1);
    expect(leaf).toMatchObject({ type: "thinking_level_change", thinkingLevel: "medium" });
    expect(leaf.parentId).toBe([...snapshot].slice(0, -1).reverse().find(entry => typeof entry.id === "string")?.id);
    expect(result.notes.join("\n")).not.toContain("thinking clamped");
  });

  it("leaves the snapshot alone when the parent already records the launch level, or records none", () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-snapshot-thinking-"));
    const header = JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-10-18T00:00:00Z", cwd: dir });
    const level = JSON.stringify({ type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-10-18T00:00:00Z", thinkingLevel: "medium" });
    for (const [name, text] of [["same", `${header}\n${level}\n`], ["none", `${header}\n`]] as const) {
      writeFileSync(join(dir, `${name}.jsonl`), text);
      snapshotRestartSession(join(dir, `${name}.jsonl`), join(dir, `${name}-snap.jsonl`), "medium");
      expect(readFileSync(join(dir, `${name}-snap.jsonl`), "utf8")).toBe(text);
    }
  });

  it("after a foreign adopt, restart forks the adopted session with the row's environment", async () => {
    const s = await setup();
    const old = s.launch.row;
    const foreign = "01a0ff19-c75d-74c5-85d6-c269a2c1e18e";
    const file = join(dirname(old.sessionFile!), `2026-10-12T00-00-00-000Z_${foreign}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: foreign, timestamp: "2026-10-12T00:00:00.000Z", cwd: s.dir }) + "\n");
    s.host.panes.get(old.pane!.paneId)!.agent_session!.value = file;
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, state: "interrupted" as const })) }, undefined] as const)));
    await s.run(agentLaunch(s.dir, { action: "adopt", name: old.name, pane: old.pane!.paneId, session: foreign, reason: "Joel: desk now" }));
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name }));
    expect(result.row.parentSessionFile).toBe(file);
    expect(result.row.sessionId).not.toBe(foreign);
    expect(readFileSync(result.argv[result.argv.indexOf("--fork") + 1]!, "utf8")).toContain(foreign);
  });

  it("restart forks the actual Herdr journal when its path changed", async () => {
    const s = await setup();
    const liveFile = join(dirname(s.launch.row.sessionFile!), `moved_${s.launch.row.sessionId}.jsonl`);
    copyFileSync(s.launch.row.sessionFile!, liveFile);
    s.host.panes.get(s.launch.row.pane!.paneId)!.agent_session!.value = liveFile;
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }));
    expect(result.row.parentSessionFile).toBe(liveFile);
    expect(result.row.sessionId).not.toBe(s.launch.row.sessionId);
  });

  it("a non-owner cannot restart another session", async () => {
    const s = await setup();
    s.h.sessionId = "outsider";
    await expect(s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }))).rejects.toThrow("belongs to owner");
    expect((await s.run(load(s.dir))).agents[0]?.sessionId).toBe(s.launch.row.sessionId);
  });

  it.each([false, true])("restore preserves another owner's row (remote %s)", async remote => {
    const s = await setup(remote);
    delete s.host.panes.get(s.launch.row.pane!.paneId)!.agent;
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, owner: "original-owner", state: "interrupted" as const })) }, undefined] as const)));
    const result = await s.run(agentLaunch(s.dir, { action: "restore", name: "worker", noSkills: true }));
    expect(result.row.owner).toBe("original-owner");
    expect((await s.run(load(s.dir))).agents[0]?.owner).toBe("original-owner");
  });
  ;

  ;

  it("failed rebind never writes the consumer activation marker", async () => {
    const s = await setup();
    const handle = s.host.handle.bind(s.host);
    let gate = "";
    vi.spyOn(s.host, "handle").mockImplementation((method, params) => {
      const result = handle(method, params);
      if (method === "pane.send_input" && String(params.text).startsWith("exec sh")) {
        gate = /MUSTER_RESTART_GATE='([^']+)'/.exec(s.host.launcherScripts.at(-1)!)![1]!;
        expect(existsSync(gate)).toBe(false);
        const p = JSON.parse(readFileSync(projectPath(s.dir), "utf8")); p.agents[0].owner = "other";
        writeFileSync(projectPath(s.dir), JSON.stringify(p));
      }
      return result;
    });
    await expect(s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }))).rejects.toThrow("row changed");
    expect(existsSync(gate)).toBe(false);
    expect(existsSync(sessionSuccessorsPath(s.h.home))).toBe(false);
  });
  it.each([false, true])("mid-turn restart tolerates only the empty startup placeholder (self %s)", async self => {
    const s = await setup(false, self ? "desk" : "worker");
    if (self) s.h.sessionId = s.launch.row.sessionId;
    const old = s.launch.row;
    const oldBytes = readFileSync(old.sessionFile!, "utf8");
    const handle = s.host.handle.bind(s.host);
    vi.spyOn(s.host, "handle").mockImplementation((method, params) => {
      if (method === "pane.send_input" && String(params.text).startsWith("exec sh")) {
        // The parent's live turn appends AFTER the immutable fork boundary.
        appendFileSync(old.sessionFile!, JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }) + "\n");
      }
      const result = handle(method, params);
      if (method === "pane.send_input" && String(params.text).startsWith("exec sh")) {
        const file = s.host.panes.get(String(params.pane_id))!.agent_session!.value;
        const lines = readFileSync(file, "utf8").trimEnd().split("\n");
        const index = lines.findIndex(line => line.includes("You continue worker after a restart"));
        lines.splice(index, 0, JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "stop" } }));
        writeFileSync(file, lines.join("\n") + "\n");
      }
      return result;
    });
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }));
    expect(result.proof?.state).toBe("proven");
    const snapshot = result.argv[result.argv.indexOf("--fork") + 1]!;
    // Pi migrates every .jsonl in its agent root into sessions/ at startup, before reading --fork.
    expect(dirname(snapshot).endsWith("/.pi/agent")).toBe(false);
    expect(readFileSync(snapshot, "utf8")).toBe(oldBytes.trimEnd().split("\n").slice(0, -1).join("\n") + "\n");
  });

  it("recovers a startup hook that consumed the argv prompt with an empty turn", async () => {
    const s = await setup(false, "desk"); s.h.sessionId = s.launch.row.sessionId;
    const handle = s.host.handle.bind(s.host);
    vi.spyOn(s.host, "handle").mockImplementation((method, params) => {
      const result = handle(method, params);
      if (method === "pane.send_input" && String(params.text).startsWith("exec sh")) {
        const file = s.host.panes.get(String(params.pane_id))!.agent_session!.value;
        const lines = readFileSync(file, "utf8").trimEnd().split("\n");
        const index = lines.findIndex(line => line.includes("You continue worker after a restart"));
        lines.splice(index, 2, JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "stop" } }));
        writeFileSync(file, lines.join("\n") + "\n");
      }
      return result;
    });
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }));
    expect(result.proof?.state).toBe("proven");
    expect(s.host.typedPrompts).toHaveLength(1);
    expect(result.notes.join("\n")).toContain("rechecked the original fork boundary");
  });

  it.each(["reply", "toolCall", "thinking", "error", "aborted"])("refuses real fresh assistant %s before the continuation", async kind => {
    const s = await setup();
    const before = await s.run(load(s.dir));
    const handle = s.host.handle.bind(s.host);
    vi.spyOn(s.host, "handle").mockImplementation((method, params) => {
      const result = handle(method, params);
      if (method === "pane.send_input" && String(params.text).startsWith("exec sh")) {
        const file = s.host.panes.get(String(params.pane_id))!.agent_session!.value;
        const lines = readFileSync(file, "utf8").trimEnd().split("\n");
        const index = lines.findIndex(line => line.includes("You continue worker after a restart"));
        lines.splice(index, 0, JSON.stringify({ type: "message", message: { role: "assistant", content: ["error", "aborted"].includes(kind) ? [] : [{ type: kind === "reply" ? "text" : kind, text: "real content" }], ...(["error", "aborted"].includes(kind) ? { stopReason: kind } : {}) } }));
        writeFileSync(file, lines.join("\n") + "\n");
      }
      return result;
    });
    await expect(s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }))).rejects.toThrow("wrong boundary");
    expect(await s.run(load(s.dir))).toEqual(before);
  });
  it.each([false, true])("replaces a worker on its own host (remote %s), never in place", async remote => {
    const s = await setup(remote);
    const old = s.launch.row;
    expect(old.sessionFile).not.toBeNull();
    appendFileSync(old.sessionFile!, '\n' + JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-6.1-sol" }) + '\n' + JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low" }) + '\n');
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name }));
    expect(result.proof).toMatchObject({ state: "proven", via: "argv" });
    expect(result.row.pane?.tabId).toBe(old.pane?.tabId);
    expect(result.row.pane?.paneId).not.toBe(old.pane?.paneId);
    expect(result.row.sessionId).not.toBe(old.sessionId);
    expect(result.row.parentSessionFile).toBe(old.sessionFile);
    expect(result.argv).toContain("--fork");
    const snapshot = result.argv[result.argv.indexOf("--fork") + 1]!;
    expect(snapshot).not.toBe(old.sessionFile);
    expect(readFileSync(snapshot, "utf8").split("\n").filter(Boolean)).toEqual(readFileSync(old.sessionFile!, "utf8").split("\n").filter(Boolean));
    expect(result.argv).toContain("openai-codex/gpt-6.1-sol:low");
    expect(result.row.restore?.argv).toContain(result.row.sessionFile);
    expect(result.row.restore?.argv).not.toContain(old.sessionFile);
    expect(result.row.events?.at(-1)).toMatchObject({ type: "RESTARTED", detail: expect.stringContaining(old.sessionId) });
    expect(s.host.panes.has(old.pane!.paneId)).toBe(false);
    expect(s.host.panes.get(result.row.pane!.paneId)?.name).toBe(old.name);
    expect(s.host.initialPrompts.at(-1)).toMatch(/You continue worker after a restart onto [a-f0-9]{40}/);
    expect(s.host.typedPrompts).toEqual([]);
    expect((await s.run(load(s.dir))).agents.filter(row => row.name === old.name)).toHaveLength(1);
  });

  it("self desk replacement moves all owned rows, root, restore env and scoped forward together", async () => {
    const s = await setup(false, "desk");
    const old = s.launch.row;
    s.h.sessionId = old.sessionId;
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: [...p.agents.map(row => ({ ...row, owner: old.sessionId })), { ...old, name: "child", role: "worker", sessionId: "child-session", owner: old.sessionId, pane: null, state: "planned" }] }, undefined] as const)));
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name }));
    const project = await s.run(load(s.dir));
    expect(project.agents.every(row => row.owner === result.row.sessionId)).toBe(true);
    expect(project.agents[1]?.restore?.env.MUSTER_OWNER).toBe(result.row.sessionId);
    expect(project.lanes.find(l => l.slug === "work")?.root).toEqual(result.row.pane);
    expect(existsSync(sessionSuccessorsPath(s.h.home))).toBe(false);
    expect(s.host.panes.has(old.pane!.paneId)).toBe(true); // no active-turn close
    expect("endSession" in result && result.endSession).toBeTruthy();
    if (!("endSession" in result) || !result.endSession) throw Error("missing shutdown receipt");
    await s.run(finishRestart(s.dir, result.endSession));
    expect(s.host.panes.has(old.pane!.paneId)).toBe(false);
  });

  it("a self-restart moves the two workers it owns, here and in another registered catalog, before any mail can name the old owner", async () => {
    const s = await setup(false, "desk");
    const old = s.launch.row;
    s.h.sessionId = old.sessionId;
    const worker = (name: string, sessionId: string) => ({ ...old, name, role: "worker" as const, sessionId, owner: old.sessionId, pane: null, state: "running" as const, restore: { cwd: old.cwd, argv: [], env: { MUSTER_OWNER: old.sessionId } } });
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: [...p.agents.map(row => ({ ...row, owner: old.sessionId })), worker("w1", "w1-session"), worker("w2", "w2-session")] }, undefined] as const)));
    const other = makeRepo(join(s.h.root, "other"));
    await s.run(projectOpen({ dir: other, slug: "other", outcome: "o", reviewTrigger: "weekly", nextAction: "n", criticalPath: [], space: "w1", sidebar: false, ephemeral: true }));
    // Only durable projects register; the old owner's rows there must still follow it.
    await s.run(mutate(other, p => Effect.succeed([{ ...p, ephemeral: false, agents: [{ ...worker("x1", "x1-session"), cwd: other }, { ...worker("x2", "x2-session"), cwd: other }, { ...worker("kept", "kept-session"), owner: "someone-else", cwd: other }] }, undefined] as const)));
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name }));
    const id = result.row.sessionId;
    const here = await s.run(load(s.dir));
    expect(here.agents.filter(row => row.name.startsWith("w")).map(row => [row.owner, row.restore?.env.MUSTER_OWNER])).toEqual([[id, id], [id, id], [id, id]]);
    const there = await s.run(load(other));
    expect(there.agents.map(row => [row.name, row.owner, row.restore?.env.MUSTER_OWNER])).toEqual([["x1", id, id], ["x2", id, id], ["kept", "someone-else", old.sessionId]]);
    expect(existsSync(sessionSuccessorsPath(s.h.home))).toBe(false);
    expect(result.notes.join("\n")).toContain("moved 2 row(s) in other to the new owner");
  });

  it("lists the parent's open pi-until watches in the receipt and the successor's prompt; finished ones are not listed", async () => {
    const s = await setup();
    const old = s.launch.row;
    const entry = (customType: string, data: unknown) => JSON.stringify({ type: "custom", customType, data, id: customType, parentId: null, timestamp: s.h.now.toISOString() });
    appendFileSync(old.sessionFile!, [
      entry("pi-until-started", { receipt: { id: "cad1", label: "owner pass", kind: "recurring", intervalMs: 600_000 }, snapshot: { quickRef: "project_status act" } }),
      entry("pi-until-started", { receipt: { id: "gate2", label: "gate done", kind: "until", intervalMs: 30_000 } }),
      entry("pi-until-finished", { id: "gate2", status: "done" }),
      // Days-old watches with no finish receipt (a timeout or cancel) are over too.
      entry("pi-until-started", { receipt: { id: "old3", label: "gate100", kind: "until", intervalMs: 30_000, expiresAt: new Date(s.h.now.getTime() - 60_000).toISOString() } }),
      // Cancelled with no session entry, possibly in an ancestor session: only pi-until's telemetry records it.
      entry("pi-until-started", { receipt: { id: "can4", label: "gate205 --main", kind: "until", intervalMs: 300_000 } }),
    ].join("\n") + "\n");
    const telemetry = join(s.h.home, ".pi/agent/pi-until/events.jsonl");
    mkdirSync(join(telemetry, ".."), { recursive: true });
    writeFileSync(telemetry, [JSON.stringify({ event: "started", id: "can4", sessionId: "desk-older" }), JSON.stringify({ event: "finished", id: "can4", status: "cancelled", sessionId: "desk-older" })].join("\n") + "\n");
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: old.name }));
    const receipt = result.notes.join("\n");
    expect(receipt).toContain("pi-until watches not carried into the fork");
    expect(receipt).toContain('cad1 "owner pass" (recurring, every 600 s; project_status act)');
    expect(receipt).not.toContain("gate2"); expect(receipt).not.toContain("old3"); expect(receipt).not.toContain("can4");
    expect(s.host.initialPrompts.at(-1)).toContain("re-arm the ones still needed: cad1");
  });

  // rats-nest-desk, 2026-10-14: a fork copies ancestors' entries, so a restart listed 12 watches for 2 live.
  it("leaves out watches started before the parent session began, and lists one line per label", () => {
    const at = (iso: string) => iso;
    const started = (id: string, label: string, timestamp: string) => JSON.stringify({ type: "custom", customType: "pi-until-started", timestamp, data: { receipt: { id, label, kind: "recurring", intervalMs: 7_200_000 } } });
    const journal = [
      JSON.stringify({ type: "session", id: "parent", timestamp: at("2026-10-14T12:00:00.000Z") }),
      started("anc1", "fleet health digest", "2026-10-13T08:00:00.000Z"),
      started("anc2", "seaweed memory", "2026-10-12T08:00:00.000Z"),
      started("live1", "fleet health digest", "2026-10-14T12:05:00.000Z"),
      started("live2", "seaweed memory", "2026-10-14T12:06:00.000Z"),
      started("live3", "seaweed memory", "2026-10-14T12:07:00.000Z"),
    ].join("\n");
    const watches = ops.openUntilWatches(journal, Date.parse("2026-10-14T13:00:00.000Z"));
    expect(watches).toEqual([`live1 "fleet health digest" (recurring, every 7200 s)`, `live3 "seaweed memory" (recurring, every 7200 s)`]);
  });

  it("refusals for another owner's row name project_status takeover, the only takeover restart and adopt have", async () => {
    const s = await setup();
    s.h.sessionId = "outsider";
    const restart = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }).pipe(Effect.result));
    const adopt = await s.run(agentLaunch(s.dir, { action: "adopt", name: "worker", pane: s.launch.row.pane!.paneId }).pipe(Effect.result));
    for (const outcome of [restart, adopt]) {
      expect(outcome).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("run project_status takeover: true") } });
      expect(outcome).not.toMatchObject({ failure: { message: expect.stringContaining("to this call") } });
    }
  });

  it.each([false, true])("failed fresh-turn proof keeps the original catalog and pane (remote %s)", async remote => {
    const s = await setup(remote);
    const before = await s.run(load(s.dir));
    const panes = [...s.host.panes.keys()];
    s.host.firstTurn = "error";
    const outcome = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }).pipe(Effect.result));
    expect(outcome._tag).toBe("Failure");
    expect(await s.run(load(s.dir))).toEqual(before);
    expect([...s.host.panes.keys()]).toEqual(panes);
    expect(s.host.calls.some(call => call.method === "pane.close" && call.params.pane_id === s.launch.row.pane?.paneId)).toBe(false);
  });

  it.each([false, true].flatMap(self => ["before", "after", "instead"].map(position => ({ self, position }))))("unmarked notice $position prompt preserves the old agent (self $self)", async ({ self, position }) => {
    const s = await setup(false, self ? "desk" : "worker");
    if (self) s.h.sessionId = s.launch.row.sessionId;
    const before = await s.run(load(s.dir));
    const oldBytes = readFileSync(s.launch.row.sessionFile!, "utf8");
    const panes = [...s.host.panes.keys()];
    const callBoundary = s.host.calls.length;
    const handle = s.host.handle.bind(s.host);
    vi.spyOn(s.host, "handle").mockImplementation((method, params) => {
      const result = handle(method, params);
      if (method === "pane.send_input" && String(params.text).startsWith("exec sh")) {
        const fresh = s.host.panes.get(String(params.pane_id));
        const path = fresh?.agent_session?.value;
        if (!path) throw Error("missing synthetic fork");
        const lines = readFileSync(path, "utf8").trimEnd().split("\n");
        const index = lines.findIndex(line => line.includes("You continue worker after a restart"));
        if (index < 0) throw Error("missing synthetic continuation");
        const notice = JSON.stringify({ type: "message", message: { role: "user", content: "instructions refreshed" } });
        if (position === "instead") lines.splice(index, 1, notice);
        else lines.splice(index + (position === "after" ? 1 : 0), 0, notice);
        writeFileSync(path, lines.join("\n") + "\n");
      }
      return result;
    });
    await expect(s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }))).rejects.toThrow("unverified user message");
    expect(await s.run(load(s.dir))).toEqual(before);
    expect(readFileSync(s.launch.row.sessionFile!, "utf8")).toBe(oldBytes);
    expect([...s.host.panes.keys()]).toEqual(panes);
    expect(s.host.calls.slice(callBoundary).some(call => ["pane.close", "agent.rename"].includes(call.method) && (call.params.pane_id === s.launch.row.pane?.paneId || call.params.target === s.launch.row.pane?.paneId))).toBe(false);
  });

  it("a changed owner refuses the rebind without forwarding or closing the old agent", async () => {
    const s = await setup();
    const handle = s.host.handle.bind(s.host);
    vi.spyOn(s.host, "handle").mockImplementation((method, params) => {
      const result = handle(method, params);
      if (method === "pane.send_input" && String(params.text).startsWith("exec sh")) {
        const p = JSON.parse(readFileSync(projectPath(s.dir), "utf8"));
        p.agents[0].owner = "other-owner";
        writeFileSync(projectPath(s.dir), JSON.stringify(p));
      }
      return result;
    });
    const outcome = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }).pipe(Effect.result));
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("row changed") } });
    expect((await s.run(load(s.dir))).agents[0]).toMatchObject({ sessionId: s.launch.row.sessionId, owner: "other-owner", pane: s.launch.row.pane });
    expect(s.host.panes.has(s.launch.row.pane!.paneId)).toBe(true);
  });

  it("a replacement desk verifies a pending packet and gets a worker reply once without taking boss-owned workers", async () => {
    const s = await setup(false, "desk");
    const old = s.launch.row;
    s.h.sessionId = old.sessionId;
    const child = await s.run(agentLaunch(s.dir, { action: "launch", name: "child", role: "worker", lane: "work", label: "child", cwd: s.dir, prompt: "child work" }));
    const artifact = join(s.h.root, "proof.txt"); writeFileSync(artifact, "evidence");
    const packet = await s.run(packetReport({ dir: s.dir, agent: "child", owner: old.sessionId, cwd: s.dir, artifact, summary: "pending", checks: [] }));
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: [...p.agents, { ...child.row, name: "boss-owned", sessionId: "boss-worker", owner: "live-boss", pane: null }] }, undefined] as const)));
    const reply = appendOwnerItem(old.sessionId, { author: child.row.sessionId, project: "probe", kind: "question", title: "worker reply" }, s.h.home);
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }));
    s.h.sessionId = result.row.sessionId;
    expect((await s.run(packetVerify(s.dir, packet.packet.id))).packet.state).toBe("verified");
    expect((await s.run(load(s.dir))).agents.find(r => r.name === "boss-owned")?.owner).toBe("live-boss");
    expect(ingestOwnerItem(old.sessionId, reply, s.h.home, "probe")).toBe(false);
    // Old queue history remains local; a new named message lands in the replacement's own queue.
    ingestOwnerItem(result.row.sessionId, { ...reply, facets: [{ index: { byteStart: 0, byteEnd: 1 }, features: [{ $type: "dev.muster.note.facet#mention", did: result.row.sessionId }] }] }, s.h.home, "probe");
    const send = vi.fn();
    const feed = ownerFeed({ session: result.row.sessionId, home: s.h.home, appendEntry: () => {}, sendMessage: send });
    expect(feed.flush()).toBeGreaterThanOrEqual(1); expect(feed.flush()).toBe(0);
    expect(send.mock.calls.filter(([note]) => String(note.content).includes("worker reply"))).toHaveLength(1);
    feed.dispose();
    await s.run(projectUpdate(s.dir, { policy: { wipLimit: 1 } }));
    const retro = await s.run(laneOpen(s.dir, { slug: "retro", label: "🔁 retro", goal: "Fresh retro at full work WIP", kind: "retro" }));
    expect(retro.lane.kind).toBe("retro");
    const fresh = await s.run(agentLaunch(s.dir, { action: "launch", name: "retro-reader", role: "judge", lane: "retro", label: "🔁 judge", cwd: s.dir, prompt: "Review the finished work." }));
    expect(fresh.proof?.state).toBe("proven");
  });

  it.each([false, true])("status silence restart uses the same proven replacement (remote %s)", async remote => {
    const s = await setup(remote);
    s.host.agentStatus = "working"; // replacements start working
    s.host.panes.get(s.launch.row.pane!.paneId)!.agent_status = "unknown"; // no turn running: Pi is gone, not busy
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, state: "nudged" })) }, undefined] as const)));
    s.h.now = new Date(Date.now() + 90 * 60_000);
    const result = await s.run(projectStatus(s.dir));
    expect(result.agents[0]?.action).toContain("restarted by fork");
    expect(result.agents[0]?.pane).not.toBe(s.launch.row.pane?.paneId);
    expect(s.host.calls.some(c => c.method === "pane.send_input" && c.params.text === "/new")).toBe(false);
  });

  it("a self silence restart returns the same exit receipt and stops the old owner's pass", async () => {
    const s = await setup(false, "desk");
    s.host.agentStatus = "working"; // replacements start working
    const old = s.launch.row;
    s.host.panes.get(old.pane!.paneId)!.agent_status = "unknown"; // no turn running: Pi is gone, not busy
    s.h.sessionId = old.sessionId;
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, owner: old.sessionId, state: "nudged" })) }, undefined] as const)));
    s.h.now = new Date(Date.now() + 90 * 60_000);
    const result = await s.run(projectStatus(s.dir));
    expect(result.endSession?.oldPane).toEqual(old.pane);
    expect(result.agents[0]?.action).toContain("restarted by fork");
    expect(s.host.panes.has(old.pane!.paneId)).toBe(true);
  });

  it("never closes a self desk pane Muster did not open", async () => {
    const s = await setup(false, "desk");
    const old = s.launch.row;
    s.h.sessionId = old.sessionId;
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, owner: old.sessionId, pane: row.pane ? { ...row.pane, openedByMuster: false } : null })) }, undefined] as const)));
    const result = await s.run(agentLaunch(s.dir, { action: "restart", name: "worker" }));
    if (!("endSession" in result) || !result.endSession) throw Error("missing exit");
    await s.run(finishRestart(s.dir, result.endSession));
    expect(s.host.panes.has(old.pane!.paneId)).toBe(true);
    expect(s.host.calls.some(c => c.method === "pane.close" && c.params.pane_id === old.pane!.paneId)).toBe(false);
  });

  it("a failed restart tool never arms agent_end shutdown", async () => {
    vi.stubEnv("MUSTER_ROLE", "desk");
    vi.spyOn(ops, "agentLaunch").mockReturnValue(Effect.fail(new InputError({ message: "rebind failed" })));
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    muster({ registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(t.name, t),
      on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), callback]),
      registerFlag: () => {}, registerCommand: () => {}, registerShortcut: () => {}, registerMessageRenderer: () => {}, getFlag: () => undefined,
      events: { on: () => () => {}, emit: () => {} } } as never);
    const shutdown = vi.fn();
    const ctx = { cwd: "/project", sessionManager: { getSessionId: () => "old", getBranch: () => [] }, shutdown };
    expect(await tools.get("agent_launch")?.execute("test", { action: "restart", name: "desk" }, undefined, undefined, ctx)).toMatchObject({ isError: true });
    for (const hook of hooks.get("agent_end") ?? []) await hook({}, ctx);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("handover waits for lease/fence release before close can kill the old pane", async () => {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>(); const order: string[] = [];
    let finish!: () => void;
    const released = new Promise<void>(resolve => { finish = resolve; });
    const close = vi.fn(async () => { order.push("close"); });
    const arm = registerRestartExit({ on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, callback) } as never,
      close, async () => { order.push("release-start"); await released; order.push("released"); });
    const binding = { paneId: "old", terminalId: "terminal", tabId: "tab", openedByMuster: true };
    const ctx = { sessionManager: { getSessionId: () => "old" }, shutdown: vi.fn() };
    arm({ sessionId: "old", dir: "/project", restart: { oldPane: binding, replacementPane: { ...binding, paneId: "replacement" }, name: "desk" } });
    hooks.get("agent_end")!({}, ctx);
    const shutdown = hooks.get("session_shutdown")!({}, ctx);
    expect(order).toEqual(["release-start"]); expect(close).not.toHaveBeenCalled();
    finish(); await shutdown; expect(order).toEqual(["release-start", "released", "close"]);
  });

  // mega-desk, 2026-10-12: Joel pressed Enter during the restart; Pi queued it, the old session answered "resend it" and quit.
  describe("operator text during a handover", () => {
    const rig = (forward = vi.fn(async (_pending: unknown, _text: string) => {})) => {
      const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>(); const order: string[] = [];
      const close = vi.fn(async () => { order.push("close"); });
      const carrier = vi.fn(async (pending: unknown, text: string) => { order.push(`carry:${text.split("\n").at(-1)}`); await forward(pending, text); });
      const hold = vi.fn(async (_pending: unknown, _texts: readonly string[]) => { order.push("hold"); }); const announce = vi.fn();
      const arm = registerRestartExit({ on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, callback); } } as never, close, async () => {}, () => {}, carrier as never, hold as never, announce);
      const binding = { paneId: "old", terminalId: "terminal", tabId: "tab", openedByMuster: true };
      const notify = vi.fn();
      const ctx = { sessionManager: { getSessionId: () => "old" }, shutdown: vi.fn(), ui: { notify } };
      const pending = { sessionId: "old", dir: "/project", restart: { oldPane: binding, replacementPane: { ...binding, paneId: "replacement" }, name: "desk" } };
      const input = (text: string, extra: object = {}) => hooks.get("input")!({ type: "input", text, source: "interactive", ...extra }, ctx);
      const delivered = (text: string) => hooks.get("message_end")!({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } }, ctx);
      const end = async () => { await hooks.get("agent_end")!({}, ctx); if (ctx.shutdown.mock.calls.length) await hooks.get("session_shutdown")!({}, ctx); };
      return { arm: () => arm(pending), input, delivered, end, order, carrier, notify, close, hold, announce, shutdown: ctx.shutdown, pending };
    };
    it("carries a steer queued before the arm and delivered after it, verbatim, before the old pane closes", async () => {
      const r = rig();
      expect(await r.input("open the browse page", { streamingBehavior: "steer" })).toEqual({ action: "continue" });
      r.arm(); r.delivered("open the browse page"); await r.end();
      expect(r.order).toEqual(["carry:open the browse page", "close"]);
      expect(r.carrier.mock.calls[0]![1]).toBe(`${CARRIED_HEADER}\n\nopen the browse page`);
    });
    it("sends input typed after the arm straight to the replacement, so the old model never sees it", async () => {
      const r = rig();
      r.arm();
      expect(await r.input("line one\nline two")).toEqual({ action: "handled" });
      expect(r.carrier.mock.calls[0]![1]).toBe(`${CARRIED_HEADER}\n\nline one\nline two`);
      expect(r.notify).toHaveBeenCalledWith("Carried to the replacement pane replacement.", "info");
      await r.end(); expect(r.carrier).toHaveBeenCalledOnce();
    });
    it("holds the old Pi open and posts a blocked item when typed text cannot be carried", async () => {
      const r = rig(vi.fn(async () => { throw new Error("agent_not_found"); }));
      r.arm();
      expect(await r.input("hello")).toEqual({ action: "continue" });
      expect(r.notify).toHaveBeenCalledWith("NOT CARRIED to replacement: agent_not_found. Type it again there.", "error");
      await r.end();
      expect(r.shutdown).not.toHaveBeenCalled(); expect(r.close).not.toHaveBeenCalled();
      expect(r.hold).toHaveBeenCalledWith(r.pending, ["hello"], expect.anything());
    });
    it("holds the old Pi open when a queued turn cannot be carried at agent_end", async () => {
      const r = rig(vi.fn(async () => { throw new Error("gone"); }));
      await r.input("queued", { streamingBehavior: "followUp" }); r.arm(); r.delivered("queued"); await r.end();
      expect(r.shutdown).not.toHaveBeenCalled();
      expect(r.order).toEqual(["carry:queued", "hold"]);
    });
    it("labels the old pane as moved the moment the restart is armed", () => {
      const r = rig(); r.arm(); r.arm();
      expect(r.announce).toHaveBeenCalledOnce(); expect(r.announce).toHaveBeenCalledWith(r.pending);
    });
    it("leaves extension input, turns delivered before the arm and unarmed sessions alone", async () => {
      const r = rig();
      expect(await r.input("before", { streamingBehavior: "steer" })).toEqual({ action: "continue" });
      r.delivered("before");
      expect(await r.input("not armed")).toEqual({ action: "continue" });
      r.arm();
      expect(await r.input("wake", { source: "extension" })).toEqual({ action: "continue" });
      r.delivered("wake"); await r.end();
      expect(r.carrier).not.toHaveBeenCalled(); expect(r.order).toEqual(["close"]);
    });
  });

  // A lingering old Pi read the name's mail into the dying session; arming retires pi-ratking's reader at once.
  it("arming a restart retires the reader once, before the turn ends", () => {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const retire = vi.fn();
    const arm = registerRestartExit({ on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, callback); } } as never, vi.fn(async () => {}), async () => {}, retire);
    const binding = { paneId: "p1", terminalId: "terminal", tabId: "tab", openedByMuster: true };
    const pending = { sessionId: "old", dir: "/project", restart: { oldPane: binding, replacementPane: { ...binding, paneId: "p2" }, name: "desk" } };
    expect(retire).not.toHaveBeenCalled();
    arm(pending); arm(pending);
    expect(retire).toHaveBeenCalledOnce();
  });

  it("unarmed, wrong-session and repeated agent_end cannot quit a process", async () => {
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const close = vi.fn(async () => {});
    const arm = registerRestartExit({ on: (name: string, callback: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, callback); } } as never, close);
    const shutdown = vi.fn();
    const ctx = { sessionManager: { getSessionId: () => "old" }, shutdown };
    hooks.get("agent_end")?.({}, ctx); expect(shutdown).not.toHaveBeenCalled();
    await hooks.get("session_shutdown")?.({}, ctx); expect(close).not.toHaveBeenCalled();
    const binding = { paneId: "p1", terminalId: "terminal", tabId: "tab", openedByMuster: true };
    arm({ sessionId: "old", dir: "/project", restart: { oldPane: binding, replacementPane: { ...binding, paneId: "p2" }, name: "desk" } });
    hooks.get("agent_end")?.({}, { ...ctx, sessionManager: { getSessionId: () => "other" } });
    expect(shutdown).not.toHaveBeenCalled();
    hooks.get("agent_end")?.({}, ctx); hooks.get("agent_end")?.({}, ctx);
    expect(shutdown).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    await hooks.get("session_shutdown")?.({}, ctx); await hooks.get("session_shutdown")?.({}, ctx);
    expect(close).toHaveBeenCalledOnce();
  });
});
