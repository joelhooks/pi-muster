import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMachines } from "./domain.ts";
import { agentLaunch, laneOpen, projectOpen, projectStatus } from "./ops.ts";
import { Comms, Herdr, MusterEnv, Proc, liveProc, noEmitPaneClose, type EnvShape, type ProcShape } from "./runtime.ts";
import { FakeHerdr, harness, makeRepo, sh } from "./test-support.ts";
import { load } from "./store.ts";

beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", ""); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup(options: { error?: string; paneTail?: string; readyAfter?: number; logUnreadable?: boolean; env?: Record<string, string> } = {}) {
  const h = harness();
  const dir = makeRepo(join(h.root, "source"));
  const bin = join(h.root, "bin"); mkdirSync(bin);
  const pi = join(bin, "pi");
  writeFileSync(pi, `#!/bin/sh\nprintf '%s\\n' '${(options.error ?? "Error: unknown option --bogus").replaceAll("'", "'\\''")}' >&2\nexit 1\n`);
  chmodSync(pi, 0o700);
  const remote = new FakeHerdr(h.home);
  const original = remote.handle.bind(remote);
  let command = "";
  let launchedPane: string | undefined;
  remote.paneTail = options.paneTail ?? "(pane unreadable)";
  remote.handle = (method, params) => {
    const result = original(method, params);
    if (method === "pane.send_input" && String(params.text).includes(" && exec ")) {
      command = String(params.text); launchedPane = String(params.pane_id);
      if (options.readyAfter === undefined && options.paneTail === undefined) {
        // A real failing executable and real redirection; the terminal vanishes after exec.
        try { execFileSync("sh", ["-c", command], { stdio: "pipe" }); } catch { /* expected Pi exit */ }
        remote.panes.delete(launchedPane);
      }
    }
    return result;
  };
  const proc: ProcShape = { run: (name, args, opts) => {
    if (name !== "ssh") return h.proc.run(name, args, opts);
    const script = args.at(-1)!;
    if (script.includes("muster-prerequisites")) return Effect.succeed({ code: 0, stdout: "", stderr: "" });
    if (options.logUnreadable && script.includes("'tail'")) return Effect.succeed({ code: 1, stdout: "", stderr: "unreadable" });
    return liveProc.run("sh", ["-c", script], { cwd: h.home, timeoutMs: opts.timeoutMs });
  } };
  const env: EnvShape = { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: h.workerWorktree,
    createId: () => "remote-id", emitPaneClose: noEmitPaneClose, startupLoad: () => ({ load: 0, cpus: 1 }),
    machines: decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/remote/muster", workerWorktree: h.workerWorktree,
      env: { PATH: `${bin}:${process.env.PATH}`, PRIVATE_REMOTE_TOKEN: "private-launch-value", ...options.env }, wrap: [] } }),
    remoteHerdr: () => Effect.succeed(remote.client()),
    sleep: ms => Effect.sync(() => {
      h.now = new Date(h.now.getTime() + ms);
      if (options.readyAfter !== undefined && launchedPane && h.now.getTime() - started >= options.readyAfter) {
        const args = [...command.matchAll(/'([^']*)'/g)].map(match => match[1]!);
        original("agent.start", { name: "pi", pane_id: launchedPane, args: args.slice(args.lastIndexOf("pi") + 1) });
      }
    }),
  };
  const started = h.now.getTime();
  const run = <A, E>(effect: Effect.Effect<A, E, Herdr | MusterEnv | Proc | Comms>) => Effect.runPromise(effect.pipe(
    Effect.provideService(MusterEnv, env), Effect.provideService(Proc, proc), Effect.provide(h.layer)));
  await run(projectOpen({ dir, slug: "probe", outcome: "remote launch evidence", reviewTrigger: "weekly", nextAction: "launch", criticalPath: [],
    space: "w1", sidebar: false, ephemeral: true, cadenceMinutes: 15, musterExtension: "/muster", deskExtension: null }));
  await run(laneOpen(dir, { slug: "work", label: "remote work", goal: "evidence", repo: dir }));
  const launch = () => run(agentLaunch(dir, { action: "launch", machine: "remote", name: "remote-w", role: "worker", lane: "work", label: "remote worker", cwd: dir, noSkills: true }));
  return { h, dir, remote, run, launch, command: () => command, row: async () => (await run(load(dir))).agents[0]! };
}

describe("remote launch failure evidence", () => {
  it("quotes stderr after Pi exits and the pane disappears, and records the same evidence", async () => {
    const s = await setup({ error: "\u001b[31mError: unknown option --bogus\u001b[0m" });
    const before = sh(s.dir, "status", "--porcelain");
    await expect(s.launch()).rejects.toThrow("Error: unknown option --bogus");
    const row = await s.row(); expect(row.state).toBe("failed");
    expect(s.remote.panes.has(row.pane!.paneId)).toBe(false);
    const detail = row.events?.find(event => event.type === "LAUNCH_FAILED")?.detail;
    expect(detail).toContain("Error: unknown option --bogus"); expect(detail).not.toContain("\u001b");
    expect(detail).not.toContain("MUSTER_REMOTE_ROW"); expect(detail).not.toContain("private-launch-value");
    const logDir = sh(s.dir, "rev-parse", "--path-format=absolute", "--git-path", "muster-launch").trim();
    const logs = readdirSync(logDir).filter(file => file.startsWith("launch-"));
    expect(logs).toHaveLength(1);
    expect(readFileSync(join(logDir, logs[0]!), "utf8")).toContain("--bogus");
    expect(statSync(join(logDir, logs[0]!)).mode & 0o777).toBe(0o600);
    expect(sh(s.dir, "status", "--porcelain")).toBe(before);
  });

  it.each(["missing-model", "worker"])("classifies a model-error log for %s as model-proof and preserves MODEL_ERROR", async model => {
    const error = `Error: Unknown model ${model}`;
    const s = await setup({ error });
    const result = await s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "remote-w", role: "worker", lane: "work", label: "remote worker", cwd: s.dir, noSkills: true }).pipe(Effect.result));
    expect(result).toMatchObject({ failure: { _tag: "GuardFailed", guard: "model-proof", message: expect.stringContaining(error) } });
    const row = await s.row(); expect(row.state).toBe("failed"); expect(row.delivery).toBe("unproven");
    expect(row.events).toContainEqual(expect.objectContaining({ type: "MODEL_ERROR", detail: error }));
  });

  it("classifies auth errors before redacting short custom env values", async () => {
    const s = await setup({ error: "Error: HTTP 401 Unauthorized private-launch-value", env: { CUDA_VISIBLE_DEVICES: "1" } });
    const result = await s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "remote-w", role: "worker", lane: "work", label: "remote worker", cwd: s.dir, noSkills: true }).pipe(Effect.result));
    expect(result).toMatchObject({ failure: { _tag: "GuardFailed", guard: "model-proof", message: expect.stringContaining("Error: HTTP") } });
    const detail = (await s.row()).events?.find(event => event.type === "MODEL_ERROR")?.detail;
    expect(detail).toContain("Unauthorized"); expect(detail).not.toContain("private-launch-value");
  });

  it("keeps only the last 12 log lines", async () => {
    const s = await setup({ error: ["old evidence", ...Array.from({ length: 12 }, (_, i) => `line ${i}`)].join("\n") });
    await expect(s.launch()).rejects.toThrow("line 11");
    expect((await s.row()).events?.find(event => event.type === "LAUNCH_FAILED")?.detail).not.toContain("old evidence");
  });

  it("keeps a slow healthy launch ready and normal pane loss interrupted", async () => {
    const s = await setup({ readyAfter: 15_000, paneTail: "Creating a new session..." });
    const launched = await s.launch(); expect(launched.row.state).toBe("running");
    expect(launched.row.events?.some(event => event.type === "LAUNCH_FAILED")).not.toBe(true);
    expect(s.command()).toContain(" && exec ");
    s.remote.panes.delete(launched.row.pane!.paneId);
    await s.run(projectStatus(s.dir, { act: false })); expect((await s.row()).state).toBe("interrupted");
  });

  it("preserves the remote pending result after its startup budget", async () => {
    const s = await setup({ paneTail: "Creating a new session..." });
    await expect(s.launch()).rejects.toThrow("(pending)");
    expect((await s.row()).events?.find(event => event.type === "LAUNCH_FAILED")?.detail).toContain("Creating a new session...");
  });

  it("falls back to pane evidence when the log cannot be read", async () => {
    const s = await setup({ paneTail: "Error: unknown option --pane-only", logUnreadable: true });
    await expect(s.launch()).rejects.toThrow("Error: unknown option --pane-only");
  });

  it("never reports the echoed remote environment", async () => {
    const s = await setup({ paneTail: "export MUSTER_REMOTE_ROW='{private-launch-value}'\nError: unknown option --bogus", logUnreadable: true });
    await expect(s.launch()).rejects.toThrow("Error: unknown option --bogus");
    const detail = (await s.row()).events?.find(event => event.type === "LAUNCH_FAILED")?.detail;
    expect(detail).not.toContain("MUSTER_REMOTE_ROW"); expect(detail).not.toContain("private-launch-value");
  });
});
