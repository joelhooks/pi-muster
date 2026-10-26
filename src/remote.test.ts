import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync, utimesSync, statSync, chmodSync, unlinkSync, rmdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { HerdrApiError } from "@joelhooks/pi-bellwether/herdr-client";
import { sessionDirFor } from "./argv.ts";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMachines, decodeProject, type MachineConfig } from "./domain.ts";
import { remotePullReceipt, remoteBindingPath, stderrClass, sidecarRoots, sidecarRootsScript, mapPath, mapWorkerPath, machinesPath, machineConfig, sshProc, remoteClient, prerequisites, withMachineLaunchLock, readyForRemoteLaunch, syncRemoteBrief, cleanupRemoteBrief, transferredBriefSource, herdrSocketFor } from "./remote.ts";
import { Comms, Herdr, MusterEnv, Proc, liveProc, noEmitPaneClose, type EnvShape, type ProcShape } from "./runtime.ts";
import { agentLaunchForeground as agentLaunch, agentLaunch as queuedAgentLaunch, runLaunchJob, agentClose, packetReport, packetVerify, packetLand, projectOpen, laneOpen, projectStatus, ingestRemotePackets, pullRemoteOwnerInbox, sessionChain } from "./ops.ts";
import { FakeHerdr, forkHarness, harness, makeRepo, sh, type Harness } from "./test-support.ts";
import { load, mutate, projectPath } from "./store.ts";
import { ProcError } from "./errors.ts";
import { agentRewind } from "./rewind.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendOwnerItem, deliverOwnerItem, ownerPath, readOwnerQueue, wakeKind } from "./owner-queue.ts";
import { fakeRatking } from "./ratking-fake.ts";
import { ownerFeed } from "./owner-feed.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";

const config = (patch: Partial<MachineConfig> = {}): MachineConfig => decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/remote/muster", workerWorktree: "/remote/worker-worktree.sh", env: { CUDA_VISIBLE_DEVICES: "", MUSTER_FLEET_COMPUTE: "off" }, wrap: [], ...patch } }).remote!;
beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", ""); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// An already-launched remote worker is built once and copied per case, so each case skips ~40 ssh-wrapped shells.
type Fork = { h: Harness; dir: string; remote: FakeHerdr };
function setup(fork?: Fork) {
  const h = fork?.h ?? harness();
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs?: number }> = [];
  const remote = fork?.remote ?? new FakeHerdr(h.home);
  let missing = false;
  const base = h.proc;
  // A test can hold a command until another launch reaches a point, to force an interleaving.
  let before: (command: string, args: readonly string[]) => Promise<void> | undefined = () => undefined;
  const proc: ProcShape = { run: (command, args, options) => {
    const hold = before(command, args);
    return hold ? Effect.promise(() => hold).pipe(Effect.andThen(Effect.suspend(() => direct(command, args, options)))) : direct(command, args, options);
  } };
  const direct: ProcShape["run"] = (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    if (command === "ssh") {
      const script = args.at(-1)!;
      if (script.includes("muster-prerequisites")) return Effect.succeed({ code: missing ? 1 : 0, stdout: "", stderr: missing ? "no rift" : "" });
      return liveProc.run("sh", ["-c", script], { cwd: h.home, timeoutMs: options.timeoutMs, ...(options.input === undefined ? {} : { input: options.input }) });
    }
    if (command === "git" && args.includes("fetch")) {
      return base.run(command, args.map(arg => arg.startsWith("ssh://remote/") ? `file:///${arg.slice("ssh://remote/".length)}` : arg), options);
    }
    return base.run(command, args, options);
  };
  let machines: unknown = { remote: config({ workerWorktree: h.workerWorktree, env: { CUDA_VISIBLE_DEVICES: "", MUSTER_FLEET_COMPUTE: "off", HOME: h.home }, wrap: ["/wrapper", "--name", "{name}", "--"] }) };
  const env: EnvShape = { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: h.workerWorktree,
    createId: () => "remote-id", sleep: ms => Effect.sync(() => { h.now = new Date(h.now.getTime() + ms); }), emitPaneClose: noEmitPaneClose,
    get machines() { return machines; }, remoteHerdr: () => Effect.succeed(remote.client()) };
  const run = <A, E>(effect: Effect.Effect<A, E, Herdr | MusterEnv | Proc | Comms>) => Effect.runPromise(effect.pipe(Effect.provideService(MusterEnv, env), Effect.provideService(Proc, proc), Effect.provide(h.layer)));
  const dir = fork?.dir ?? makeRepo(join(h.root, "source"));
  const open = async () => {
    await run(projectOpen({ dir, slug: "probe", outcome: "remote lanes", reviewTrigger: "weekly", nextAction: "launch", criticalPath: [], space: "w1", sidebar: false, ephemeral: true, cadenceMinutes: 15, musterExtension: "/muster", deskExtension: null }));
    await run(laneOpen(dir, { slug: "work", label: "remote work", goal: "packet", repo: dir }));
  };
  const launch = (name = "remote-w") => run(agentLaunch(dir, { action: "launch", machine: "remote", name, role: "worker", lane: "work", label: "remote worker", clone: true, noSkills: true }));
  return { h, remote, dir, calls, env, proc, run, open, launch, setMissing: () => { missing = true; }, setBefore: (hook: typeof before) => { before = hook; }, setMachines: (value: unknown) => { machines = Object.fromEntries(Object.entries(value as Record<string, MachineConfig>).map(([name, machine]) => [name, { ...machine, env: { ...machine.env, HOME: h.home } }])); } };
}

let launchedTemplate: Promise<{ s: ReturnType<typeof setup>; remote: FakeHerdr }> | undefined;
/** One launched remote worker, copied: files, fake panes and the remote herdr all belong to the case. */
const buildTemplate = () => launchedTemplate ??= (async () => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", "");
    const s = setup(); await s.open(); await s.launch();
    return { s, remote: s.remote };
  })();
beforeAll(async () => { await buildTemplate(); vi.unstubAllEnvs(); });
async function launchedFork() {
  const { s: template, remote: templateRemote } = await buildTemplate();
  const { h, dir, relocate } = forkHarness(template.h, template.dir);
  // Every text file the launch wrote (journals, bindings, launcher records) names the template root.
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }) as Dirent[]) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "objects") walk(full); continue; }
      if (!entry.isFile()) continue;
      // A skipped file could keep template paths; fail loudly instead of leaving them behind.
      if (statSync(full).size > 1_000_000) throw new Error(`launchedFork: ${full} is over 1 MB; relocate it explicitly`);
      const text = readFileSync(full, "utf8");
      if (text.includes(template.h.root)) writeFileSync(full, relocate(text));
    }
  };
  walk(h.root);
  const remote = new FakeHerdr(h.home);
  for (const [id, pane] of templateRemote.panes) remote.panes.set(id, { ...pane, cwd: relocate(pane.cwd), ...(pane.agent_session ? { agent_session: { ...pane.agent_session, value: relocate(pane.agent_session.value) } } : {}) });
  for (const [id, tab] of templateRemote.tabs) remote.tabs.set(id, { ...tab });
  for (const [id, workspace] of templateRemote.workspaces) remote.workspaces.set(id, { ...workspace });
  remote.seq = templateRemote.seq;
  h.herdr.seq = template.h.herdr.seq;
  const s = setup({ h, dir, remote });
  return { s, launched: { row: (await s.run(load(dir))).agents.find(row => row.name === "remote-w")! } };
}

describe("machine boundary", () => {
  it("maps only path prefixes, longest first, and decodes defaults", () => {
    const machine = config({ paths: { "/local": "/remote", "/local/specific": "/special" } });
    expect(mapPath("/local/specific/repo", machine)).toBe("/special/repo");
    expect(mapPath("/locality/repo", machine)).toBe("/locality/repo");
    expect(machine.socket).toBeUndefined();
    expect(herdrSocketFor("/home/alice")).toBe("/home/alice/.config/herdr/herdr.sock");
    expect(mapWorkerPath(join(process.cwd(), "skills/muster/SKILL.md"), config())).toBe("/remote/muster/skills/muster/SKILL.md");
    expect(() => config({ ssh: "-o evil" })).toThrow();
    expect(() => config({ maxPanes: 0 })).toThrow();
  });
  it("absent config means local only and malformed config fails closed", async () => {
    const s = setup(); s.setMachines({});
    await expect(s.run(machineConfig("remote"))).rejects.toThrow("not configured");
    mkdirSync(join(s.h.home, ".config/muster"), { recursive: true });
    writeFileSync(machinesPath(s.h.home), "{broken");
    const env = { ...s.env, machines: undefined };
    await expect(Effect.runPromise(machineConfig("remote").pipe(Effect.provideService(MusterEnv, env)))).rejects.toThrow("invalid");
  });
  it("bounds SSH, quotes shell inputs, and names transport failures", async () => {
    const run = vi.fn((_command: string, _args: readonly string[], _options: import("./runtime.ts").ProcOptions) => Effect.fail(new ProcError({ command: "ssh", code: null, stderr: "", message: "timeout" })));
    await expect(Effect.runPromise(sshProc("remote", config(), { run }, "/").run("git", ["a';touch /tmp/no"], { cwd: "/repo space", timeoutMs: 999999 }))).rejects.toThrow("machine remote");
    expect(run.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 300000 });
    expect(run.mock.calls[0]?.[1]).toContain("BatchMode=yes");
    expect(String(run.mock.calls[0]?.[1].at(-1))).toContain("'\\''");
  });
  // Bravestarr, 2026-10-11: a remote restart's binding push ran ssh inside onRemote's ssh: `cd /Users/alice` on remote1.
  it("wrapping an ssh-wrapped runner again makes one ssh, not ssh inside ssh", async () => {
    const run = vi.fn((_command: string, _args: readonly string[], _options: import("./runtime.ts").ProcOptions) => Effect.succeed({ code: 0, stdout: "", stderr: "" }));
    const outer = sshProc("remote", config(), { run }, "/local-home");
    await Effect.runPromise(sshProc("remote", config(), outer, "/local-home").run("node", ["-e", "1"], { cwd: "/", timeoutMs: 1000 }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe("ssh");
    expect(String(run.mock.calls[0]?.[1].at(-1))).toMatch(/^cd '\/' && exec env .*'node'/);
  });
  it("runs in place, not over ssh, when this Pi is already on that machine", async () => {
    vi.stubEnv("MUSTER_MACHINE", "remote");
    const run = vi.fn((_command: string, _args: readonly string[], _options: import("./runtime.ts").ProcOptions) => Effect.succeed({ code: 0, stdout: "ok", stderr: "" }));
    await Effect.runPromise(sshProc("remote", config(), { run }, "/").run("node", ["-e", "1"], { cwd: "/repo", timeoutMs: 1000, env: { X: "1" } }));
    expect(run.mock.calls[0]?.[0]).toBe("node");
    expect(run.mock.calls[0]?.[2]).toMatchObject({ cwd: "/repo", env: expect.objectContaining({ X: "1" }) });
    vi.unstubAllEnvs();
  });
  it("creates a socket forward only when its master is absent", async () => {
    const s = setup();
    const forward = async (machine: MachineConfig) => {
      const capture: string[][] = [];
      const proc: ProcShape = { run: (_command, args) => { capture.push([...args]); return Effect.succeed({ code: args.includes("check") ? 1 : 0, stdout: args.some(arg => arg.includes("process.env.HOME")) ? "/home/probed\n" : "", stderr: "" }); } };
      const client = await Effect.runPromise(remoteClient("remote", machine).pipe(Effect.provideService(MusterEnv, { ...s.env, remoteHerdr: undefined }), Effect.provideService(Proc, proc)));
      expect(client.socketPath()).toContain(".config/muster/fwd");
      const ssh = capture.find(args => args.includes("ExitOnForwardFailure=yes"))!;
      // A master that idled out leaves its forwarded socket behind; the next bind must replace it.
      expect(ssh).toContain("StreamLocalBindUnlink=yes");
      return ssh[ssh.indexOf("-L") + 1]!.split(":").at(-1);
    };
    // The remote socket defaults to Herdr's own path under the remote HOME, never an operator's path (public repo, 2026-10-17).
    expect(await forward(config({ socket: "/run/herdr.sock" }))).toBe("/run/herdr.sock");
    expect(await forward(config({ env: { HOME: "/home/alice" } }))).toBe("/home/alice/.config/herdr/herdr.sock");
    expect(await forward(config())).toBe("/home/probed/.config/herdr/herdr.sock");
  });
});

describe("remote launch hygiene", () => {
  it("explains pull delivery only for intercom policy", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const receipt = "remote notes reach the owner only when it runs owner_inbox or project_status; for push, set policy comms ratking (or leave it unset) once the owner and its rows load pi-ratking";
    // A new project rides ratking, which pushes owner notes.
    expect(launched.notes).not.toContain(receipt);
    expect(remotePullReceipt("ratking")).toEqual([]);
    expect(remotePullReceipt("intercom")).toEqual([]);
    expect(remotePullReceipt(undefined)).toEqual([]);
    expect(remotePullReceipt("network")).toEqual([]);
  });
  it("queues machine launch tickets in FIFO order and reports waiting", async () => {
    const s = setup();
    const env = { ...s.env, sleep: (ms: number) => Effect.sleep(ms) };
    const run = <A, E>(effect: Effect.Effect<A, E, MusterEnv>) => Effect.runPromise(effect.pipe(Effect.provideService(MusterEnv, env)));
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const order: number[] = [], notes: string[] = [];
    const first = run(withMachineLaunchLock("remote", Effect.promise(async () => { order.push(1); started(); await hold; })));
    await start;
    const second = run(withMachineLaunchLock("remote", Effect.sync(() => { order.push(2); }), text => notes.push(text)));
    const third = run(withMachineLaunchLock("remote", Effect.sync(() => { order.push(3); }), text => notes.push(text)));
    release();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
    expect(notes.join(" ")).toContain("after waiting");
    expect(readdirSync(join(s.h.home, ".config/muster/launch-locks/remote.queue"))).toEqual([]);
  });
  // Switchboard, 2026-10-20: ten desks queued behind 60 s launches; everyone past the fifth timed out on total wait.
  it("lets ten queued launches through behind slow holders, timing out only on a stuck head", async () => {
    const s = setup();
    let clock = 0;
    const env = { ...s.env, now: () => new Date(clock), sleep: (ms: number) => Effect.promise(async () => { clock += ms; await new Promise(resolve => setImmediate(resolve)); }) };
    const run = <A, E>(effect: Effect.Effect<A, E, MusterEnv>) => Effect.runPromise(effect.pipe(Effect.provideService(MusterEnv, env)));
    const order: number[] = [];
    // Each holder takes 60 s of the shared clock; the waiter timeout is 90 s, so total wait reaches 540 s.
    const holder = (i: number) => withMachineLaunchLock("remote", Effect.gen(function* () { order.push(i); yield* env.sleep(60_000); }), () => {}, 90_000);
    await Promise.all(Array.from({ length: 10 }, (_, i) => run(holder(i))));
    expect(order).toHaveLength(10);
    const lock = join(s.h.home, ".config/muster/launch-locks/remote");
    mkdirSync(lock);
    writeFileSync(join(`${lock}.queue`, "0000000000000999"), String(process.pid));
    await expect(run(withMachineLaunchLock("remote", Effect.void, () => {}, 2_000))).rejects.toThrow("has not moved for 2000 ms");
  });
  it("skips a head ticket whose process is gone, with the lock it held", async () => {
    const s = setup(); const lock = join(s.h.home, ".config/muster/launch-locks/remote");
    const dead = spawnSync("true").pid!;
    mkdirSync(`${lock}.queue`, { recursive: true }); mkdirSync(lock);
    writeFileSync(join(`${lock}.queue`, "0000000000000001"), String(dead));
    writeFileSync(`${lock}.counter`, "1");
    const notes: string[] = [];
    let ran = false;
    await s.run(withMachineLaunchLock("remote", Effect.sync(() => { ran = true; }), text => notes.push(text), 2000));
    expect(ran).toBe(true);
    expect(notes.join(" ")).toContain(`skipped dead ticket 0000000000000001 (pid ${dead} is gone)`);
    expect(readdirSync(`${lock}.queue`)).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });
  // Switchboard, 2026-10-20: two waiters reaping one dead head could remove the next live head's lock.
  it("a claimed dead head blocks the queue while its claimant lives, and is reclaimed once it dies", async () => {
    const s = setup(); const lock = join(s.h.home, ".config/muster/launch-locks/remote");
    const dead = spawnSync("true").pid!;
    const claimant = spawn("sleep", ["30"]);
    mkdirSync(`${lock}.queue`, { recursive: true }); mkdirSync(lock);
    writeFileSync(join(`${lock}.queue`, `0000000000000001.reap-${claimant.pid}`), String(dead));
    writeFileSync(`${lock}.counter`, "1");
    try {
      await expect(s.run(withMachineLaunchLock("remote", Effect.void, () => {}, 1_000))).rejects.toThrow("has not moved");
      expect(existsSync(lock)).toBe(true);
    } finally { claimant.kill(); await new Promise(resolve => claimant.once("exit", resolve)); }
    const notes: string[] = [];
    await s.run(withMachineLaunchLock("remote", Effect.void, text => notes.push(text), 2_000));
    expect(notes.join(" ")).toContain(`skipped dead ticket 0000000000000001 (its claimant, pid ${claimant.pid} is gone)`);
    expect(readdirSync(`${lock}.queue`)).toEqual([]);
    expect(existsSync(lock)).toBe(false);
  });
  it("releases cleanly when its lock or ticket is already gone", async () => {
    const s = setup(); const lock = join(s.h.home, ".config/muster/launch-locks/remote");
    await s.run(withMachineLaunchLock("remote", Effect.sync(() => { rmdirSync(lock); for (const file of readdirSync(`${lock}.queue`)) unlinkSync(join(`${lock}.queue`, file)); })));
    expect(readdirSync(`${lock}.queue`)).toEqual([]);
  });
  it("bounds stale-lock waits and removes only its own queue ticket", async () => {
    const s = setup(); const lock = join(s.h.home, ".config/muster/launch-locks/remote");
    mkdirSync(lock, { recursive: true });
    await expect(s.run(withMachineLaunchLock("remote", Effect.void, () => {}, 200))).rejects.toThrow("FIFO launch lock timed out");
    expect(existsSync(lock)).toBe(true);
    expect(readdirSync(`${lock}.queue`)).toEqual([]);
  });
  it("probes remote prerequisites once, reports Pi skew and names a missing helper fix", async () => {
    const s = setup(), bin = join(s.h.root, "preflight-bin"), extension = join(s.h.root, "muster");
    mkdirSync(bin); mkdirSync(join(extension, "extensions"), { recursive: true }); mkdirSync(join(extension, "node_modules"));
    writeFileSync(join(extension, "extensions/pi-muster.ts"), "");
    for (const cmd of ["pi", "node", "git", "rift", "muster-heavy"]) { const file = join(bin, cmd); writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${cmd === "pi" ? "0.99.2" : ""}'\n`); chmodSync(file, 0o700); }
    const helper = join(bin, "worker-worktree.sh"); writeFileSync(helper, "#!/bin/sh\n# --hydrate\n"); chmodSync(helper, 0o700);
    const machine = config({ musterExtension: extension, workerWorktree: helper, env: { HOME: s.h.home, PATH: `${bin}:/usr/bin:/bin`, MUSTER_FLEET_COMPUTE: "off" } });
    const calls: string[] = [];
    const proc: ProcShape = { run: (command, args, options) => { if (command === "pi") return Effect.succeed({ code: 0, stdout: "1.0.3\n", stderr: "" }); calls.push(args.at(-1)!); return liveProc.run("sh", ["-c", args.at(-1)!], options); } };
    const notes = await s.run(prerequisites("remote", machine, s.dir, true).pipe(Effect.provideService(Proc, proc)));
    expect(calls).toHaveLength(1); expect(notes.join(" ")).toContain("remote Pi 0.99.2; owner Pi 1.0.3; warning: Pi version skew");
    await expect(s.run(prerequisites("remote", machine, join(s.dir, "missing-source"), true).pipe(Effect.provideService(Proc, proc)))).rejects.toThrow("or pass machine: local");
    unlinkSync(join(bin, "muster-heavy"));
    await expect(s.run(prerequisites("remote", machine, s.dir, true).pipe(Effect.provideService(Proc, proc)))).rejects.toThrow("install muster-heavy on the remote non-interactive PATH");
  });
  it("refuses mapped-provider capability failures before allocating a clone or opening Herdr", async () => {
    const s = setup(); await s.open();
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, env: {}, providerMap: { "openai-codex": "cliproxy-codex" } }) });
    const original = s.proc.run;
    const readyCalls: string[] = [];
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => {
      if (command === "ssh" && args.at(-1)?.includes("'fleet-compute' 'ready'")) { readyCalls.push(args.at(-1)!); return Effect.succeed({ code: 69, stdout: JSON.stringify({ machine: "remote", verdict: "not-ready", checks: [{ name: "auth", ok: false, detail: "log in on target" }], busy: [] }), stderr: "" }); }
      return original(command, args, options);
    });
    await expect(s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "not-ready", role: "worker", lane: "work", label: "not ready", clone: true, noSkills: true, model: "openai-codex/gpt-6.1-sol", thinking: "medium", env: { PROBE_VALUE: "launch-env" } }))).rejects.toThrow("auth: log in on target");
    expect(readyCalls[0]).toContain("'cliproxy-codex/gpt-6.1-sol:medium'"); expect(readyCalls[0]).toContain("PROBE_VALUE='launch-env'");
    expect(s.remote.calls).toEqual([]); expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("'create'"))).toBe(false);
  });
  it("restore resolves a model alias and maps its provider before the capability probe", async () => {
    const s = setup(); await s.open(); const { row } = await s.launch();
    s.remote.panes.delete(row.pane!.paneId);
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, env: {}, providerMap: { "openai-codex": "cliproxy-codex" } }) });
    const original = s.proc.run;
    const readyCalls: string[] = [];
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => {
      if (command === "ssh" && args.at(-1)?.includes("'fleet-compute' 'ready'")) { readyCalls.push(args.at(-1)!); return Effect.succeed({ code: 69, stdout: JSON.stringify({ machine: "remote", verdict: "not-ready", checks: [{ name: "stop", ok: false, detail: "probe only" }], busy: [] }), stderr: "" }); }
      return original(command, args, options);
    });
    await expect(s.run(agentLaunch(s.dir, { action: "restore", name: row.name, model: "sol" }))).rejects.toThrow("probe only");
    expect(readyCalls).toHaveLength(1);
    expect(readyCalls[0]).toContain("'cliproxy-codex/gpt-6.1-sol");
    expect(readyCalls[0]).not.toMatch(/'--model' 'sol'/);
  });
  it("names the exit code and stderr when fleet-compute ready prints no receipt", async () => {
    const s = setup();
    const proc: ProcShape = { run: () => Effect.succeed({ code: 2, stdout: "", stderr: "usage: fleet-compute ready\n--model must be provider/id\n" }) };
    await expect(s.run(readyForRemoteLaunch("remote", config({ env: {} }), "/repo", "sol", 1000).pipe(Effect.provideService(Proc, proc))))
      .rejects.toThrow("fleet-compute ready exited 2 without a receipt (SyntaxError: Unexpected end of JSON input); stderr: --model must be provider/id");
  });
  it("waits for fleet busy and passes the resolved model and source before clone allocation", async () => {
    const s = setup(); const receipts = [
      { machine: "remote", verdict: "busy", checks: [], busy: ["gate held"] },
      { machine: "remote", verdict: "ready", checks: [{ name: "auth", ok: true, detail: "served" }], busy: [] },
    ]; const calls: string[] = [];
    const proc: ProcShape = { run: (_cmd, args) => { calls.push(args.at(-1)!); const receipt = receipts.shift()!; return Effect.succeed({ code: receipt.verdict === "busy" ? 75 : 0, stdout: JSON.stringify(receipt), stderr: "" }); } };
    const notes = await s.run(readyForRemoteLaunch("remote", config({ env: {} }), "/mapped/repo", "cliproxy-codex/gpt-6.1-sol:medium").pipe(Effect.provideService(Proc, proc)));
    expect(calls).toHaveLength(2); expect(calls[0]).toContain("'cliproxy-codex/gpt-6.1-sol:medium'"); expect(calls[0]).toContain("'/mapped/repo'");
    expect(notes.join(" ")).toContain("after waiting 1000 ms");
  });
  it("includes slow capability probe time in the bounded busy wait", async () => {
    const s = setup(); let probes = 0;
    const proc: ProcShape = { run: (_command, _args, options) => Effect.sync(() => {
      probes += 1; expect(options.timeoutMs).toBe(2000);
      s.h.now = new Date(s.h.now.getTime() + 1500);
      return { code: 75, stdout: JSON.stringify({ machine: "remote", verdict: "busy", checks: [], busy: ["gate held"] }), stderr: "" };
    }) };
    await expect(s.run(readyForRemoteLaunch("remote", config({ env: {} }), "/repo", "sol", 2000).pipe(Effect.provideService(Proc, proc)))).rejects.toThrow("busy after 2000 ms: gate held");
    expect(probes).toBe(1);
  });
  it.each(["not-ready", "busy", "mismatched"])("fails closed on a %s fleet capability receipt", async verdict => {
    const s = setup();
    const proc: ProcShape = { run: () => Effect.succeed({ code: verdict === "busy" ? 75 : 69, stdout: JSON.stringify({ machine: verdict === "mismatched" ? "other" : "remote", verdict: verdict === "busy" ? "busy" : "not-ready", checks: [{ name: "auth", ok: false, detail: "log in on target" }], busy: ["gate held"] }), stderr: "" }) };
    await expect(s.run(readyForRemoteLaunch("remote", config({ env: {} }), "/repo", "sol", 1000).pipe(Effect.provideService(Proc, proc)))).rejects.toThrow(verdict === "mismatched" ? "identity" : verdict === "busy" ? "gate held" : "auth: log in on target");
  });
  it("copies brief references privately, verifies hashes and removes only unchanged row-owned inputs", async () => {
    const s = setup(); const inputs = join(s.h.root, "private"); mkdirSync(inputs);
    const reference = join(inputs, "review.svx"), brief = join(inputs, "brief.md");
    writeFileSync(reference, "private source review"); writeFileSync(brief, `Read ${reference}.\n`);
    const machine = config({ env: { HOME: s.h.home }, paths: { [inputs]: "/mapped/private" } });
    const transfer = join(s.h.home, ".cache/muster-transfers/probe/worker");
    const synced = await s.run(syncRemoteBrief("remote", machine, brief, transfer));
    expect(readFileSync(synced.brief, "utf8")).toBe(readFileSync(brief, "utf8"));
    expect(statSync(synced.brief).mode & 0o777).toBe(0o600);
    const copy = JSON.parse(readFileSync(join(transfer, "transfers.json"), "utf8")).find((file: { path: string }) => file.path.endsWith("/review.svx")).path;
    expect(readFileSync(copy, "utf8")).toBe("private source review");
    expect(synced.note).toContain("sha256");
    writeFileSync(brief, `Updated task. Read ${reference}.\n`);
    const updated = await s.run(syncRemoteBrief("remote", machine, brief, transfer));
    expect(updated.brief).not.toBe(synced.brief); expect(existsSync(synced.brief)).toBe(true);
    const secondTransfer = `${transfer}-second`, second = await s.run(syncRemoteBrief("remote", machine, brief, secondTransfer));
    writeFileSync(copy, "edited review");
    expect((await s.run(cleanupRemoteBrief("remote", machine, transfer))).join(" ")).toContain("private input kept (changed)");
    expect(existsSync(synced.brief)).toBe(false); expect(existsSync(updated.brief)).toBe(false); expect(existsSync(copy)).toBe(true);
    expect(existsSync(second.brief)).toBe(true);
    await s.run(cleanupRemoteBrief("remote", machine, secondTransfer));
    expect(existsSync(second.brief)).toBe(false);
  });
  // Overthruster, 2026-10-20: briefs name the report the worker will write; three launches failed with ENOENT on it.
  it("skips a report path that does not exist yet and still refuses a missing input", async () => {
    const s = setup(); const inputs = join(s.h.root, "private"); mkdirSync(inputs);
    const brief = join(inputs, "brief.md"), report = join(inputs, "reports/deps/report.md");
    writeFileSync(brief, `Write your report to ${report}.\n`);
    const machine = config({ env: { HOME: s.h.home }, paths: { [inputs]: "/mapped/private" } });
    const transfer = join(s.h.home, ".cache/muster-transfers/probe/reports");
    const synced = await s.run(syncRemoteBrief("remote", machine, brief, transfer));
    expect(readFileSync(synced.brief, "utf8")).toContain("report.md");
    writeFileSync(brief, `Read ${join(inputs, "missing.svx")}.\n`);
    await expect(s.run(syncRemoteBrief("remote", machine, brief, `${transfer}-missing`))).rejects.toThrow("does not exist");
  });
  it.each(["planned", "failed", "interrupted"] as const)("clearly refuses explicit cross-machine relaunch of a %s row without reusing a lock", async state => {
    const { s, launched } = await launchedFork();
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, state, sessionFile: null })) }, undefined] as const)));
    s.calls.length = 0;
    for (const launch of [agentLaunch, queuedAgentLaunch]) await expect(s.run(launch(s.dir, { action: "launch", machine: "local", name: launched.row.name, clone: true }))).rejects.toThrow("explicit machine local differs");
    expect(s.calls).toEqual([]); expect((await s.run(load(s.dir))).agents[0]?.machine).toBe("remote");
  });
});

describe("remote owner operations", () => {
  it.each([false, true])("owner_inbox pulls before reading and tolerates an offline host (%s)", async offline => {
    const { s, launched } = await launchedFork();
    const item = appendOwnerItem(launched.row.owner, { author: launched.row.sessionId, lane: "work", kind: "progress", title: "Remote-only note" }, join(s.h.root, "remote-home"));
    const root = join(sidecarRoots(launched.row.cwd)[0]!, "notes"); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${"a".repeat(64)}.json`), JSON.stringify({ project: "probe", machine: "remote", agent: launched.row.name, lane: "work", owner: launched.row.owner, item }));
    appendOwnerItem(launched.row.owner, { author: "local-worker", kind: "progress", title: "Local note" }, s.h.home);
    if (offline) vi.spyOn(s.proc, "run").mockImplementation(() => Effect.fail(new ProcError({ command: "ssh", code: 255, stderr: "offline", message: "offline\nnow" })));
    const tools = new Map<string, any>();
    const stop = registerOwnerFeed({ on: vi.fn(), registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer: vi.fn(), sendMessage: vi.fn(), appendEntry: vi.fn() } as never,
      { HOME: s.h.home }, { pull: () => s.run(pullRemoteOwnerInbox(s.dir)) });
    const result = await tools.get("owner_inbox").execute("id", {}, undefined, undefined, { sessionManager: { getSessionId: () => launched.row.owner, getBranch: () => [] } });
    const text = result.content[0].text;
    expect(text).toContain("Local note");
    if (offline) expect(text).toContain("offline now");
    else expect(text).toContain("Remote-only note");
    if (!offline) expect(s.calls.filter(call => call.command === "ssh").at(-1)?.timeoutMs).toBe(5000);
    stop();
  });
  it("does not pull another owner's rows", async () => {
    const s = setup(); await s.open(); await s.launch();
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, owner: "different-owner" })) }, undefined] as const)));
    s.calls.length = 0;
    expect(await s.run(pullRemoteOwnerInbox(s.dir))).toEqual([]);
    expect(s.calls.filter(call => call.command === "ssh")).toEqual([]);
  });
  it("keeps gitfile checkout sidecars in its own git directory", () => {
    const s = setup(); const cwd = join(s.h.root, "linked");
    mkdirSync(cwd); mkdirSync(join(s.dir, ".git/worktrees"));
    sh(cwd, "init", "--separate-git-dir", join(s.dir, ".git/worktrees/linked"));
    const root = sidecarRoots(cwd)[0]!;
    expect(root).toBe(join(s.dir, ".git/worktrees/linked/muster"));
    mkdirSync(join(root, "notes"), { recursive: true }); writeFileSync(join(root, "notes/note.json"), "{}");
    expect(sh(cwd, "status", "--porcelain").trim()).toBe("");
  });
  it.each(["question", "blocked", "action", "progress"] as const)("pushes a remote %s note through ratking and preserves local wake semantics", async kind => {
    const { s, launched } = await launchedFork();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    const send = vi.fn(() => Effect.succeed({ status: "failed" as const, detail: "no reverse intercom" }));
    const fake = fakeRatking(s.h.home, () => "probe/remote-w", [], () => [decodeProject(JSON.parse(readFileSync(projectPath(s.dir), "utf8")))]);
    const posted = await s.run(deliverOwnerItem({ owner: launched.row.owner, home: join(s.h.root, "remote-home"), session: launched.row.sessionId, project: "probe", item: { author: launched.row.sessionId, lane: launched.row.lane, kind, title: "Need owner eyes", body: "Full note", refs: ["source"] }, comms: fake.service, send }));
    expect(send).not.toHaveBeenCalled(); expect(posted.pendingPull).toBe(false);
    expect(posted.delivery.status).toBe("delivered");
    expect(existsSync(join(sidecarRoots(launched.row.cwd)[0]!, "notes"))).toBe(false);
    {
      expect(fake.requests).toHaveLength(1);
      expect((fake.requests[0] as { quiet?: boolean }).quiet === true).toBe(kind === "progress");
      expect(fake.requests[0]).toMatchObject({ to: launched.row.owner, kind: "message", summary: `${kind} probe/remote-w · Need owner eyes` });
      expect(readOwnerQueue(launched.row.owner, s.h.home).items[0]?.item).toMatchObject({ uri: posted.delivery.id, author: launched.row.sessionId, kind, renderedBy: "ratking" });
    }
    const before = readFileSync(ownerPath(launched.row.owner, s.h.home), "utf8");
    await s.run(ingestRemotePackets(s.dir));
    expect(readFileSync(ownerPath(launched.row.owner, s.h.home), "utf8")).toBe(before);
    expect(readOwnerQueue(launched.row.owner, s.h.home).items).toHaveLength(1);
    const wake = vi.fn();
    const feed = ownerFeed({ session: launched.row.owner, home: s.h.home, appendEntry: vi.fn(), sendMessage: wake });
    expect(feed.flush()).toBe(0); expect(wake).not.toHaveBeenCalled();
    if (wakeKind(kind)) expect(feed.beforeTurn()).toBeUndefined();
    expect(feed.flush()).toBe(0); feed.dispose();
  });
  it("uses the catalog owner when the sidecar names another owner", async () => {
    const { s, launched } = await launchedFork();
    const item = appendOwnerItem(launched.row.owner, { author: launched.row.sessionId, lane: launched.row.lane, kind: "question", title: "Question" }, join(s.h.root, "remote-home"));
    const root = join(launched.row.cwd, ".pi/muster/notes"); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${"a".repeat(64)}.json`), JSON.stringify({ project: "probe", machine: "remote", agent: launched.row.name, lane: launched.row.lane, owner: "another-owner", item }));
    expect((await s.run(ingestRemotePackets(s.dir))).notes).toEqual([]);
    expect(readOwnerQueue(launched.row.owner, s.h.home).items.map(record => record.item)).toEqual([item]);
    expect(readOwnerQueue("another-owner", s.h.home).items).toHaveLength(0);
  });
  it.each(["project", "machine", "agent", "lane", "author"])("skips a note with mismatched %s and still pulls valid notes", async field => {
    const { s, launched } = await launchedFork();
    const item = appendOwnerItem(launched.row.owner, { author: launched.row.sessionId, lane: launched.row.lane, kind: "question", title: "Question" }, join(s.h.root, "remote-home"));
    const root = join(launched.row.cwd, ".pi/muster/notes"); mkdirSync(root, { recursive: true });
    const sidecar = { project: "probe", machine: "remote", agent: launched.row.name, lane: launched.row.lane, owner: launched.row.owner, item };
    writeFileSync(join(root, `${"a".repeat(64)}.json`), JSON.stringify(field === "author" ? { ...sidecar, item: { ...item, author: "wrong-author" } } : { ...sidecar, [field]: "wrong" }));
    writeFileSync(join(root, `${"b".repeat(64)}.json`), JSON.stringify(sidecar));
    writeFileSync(join(root, `${"c".repeat(64)}.json`), "{broken");
    writeFileSync(join(root, "unfinished.tmp"), "{broken");
    const result = await s.run(ingestRemotePackets(s.dir));
    expect(result.notes.join("\n")).toContain("invalid note sidecar identity");
    expect(result.notes.join("\n")).toContain(`${"c".repeat(64)}.json`);
    expect(readOwnerQueue(launched.row.owner, s.h.home).items.map(record => record.item)).toEqual([item]);
  });
  ;
  it("launches, forks and restores on the row machine with wrapper, env and remote panes", async () => {
    const s = setup(); await s.open();
    const first = await s.launch();
    expect(first.row.machine).toBe("remote");
    expect(first.row.intercomAddress).toBe("remote-w@remote");
    const typed = s.remote.calls.find(call => call.method === "pane.send_input")!.params.text;
    expect(typed).toMatch(/^exec sh '/);
    const shell = s.remote.launcherScripts[0]!;
    expect(shell).toContain("'/wrapper' '--name' 'remote-w' '--' 'pi'");
    expect(shell).toContain("export CUDA_VISIBLE_DEVICES=''");
    expect(s.h.herdr.calls.some(call => call.method === "agent.start")).toBe(false);
    const fork = await s.run(agentLaunch(s.dir, { action: "fork", name: "remote-fork", from: "remote-w", clone: true }));
    expect(fork.row.machine).toBe("remote"); expect(fork.row.parentSessionFile).toBe(first.row.sessionFile);
    expect(s.remote.calls.filter(call => call.method === "pane.split")).toHaveLength(1);
    // Simulate a lost pane, preserving the clone so restore can reuse it.
    s.remote.panes.delete(fork.row.pane!.paneId);
    await s.run(projectStatus(s.dir, { act: true }));
    const restored = await s.run(agentLaunch(s.dir, { action: "restore", name: "remote-fork" }));
    expect(restored.row.machine).toBe("remote"); expect(restored.argv).toContain("--session");
    expect(s.calls.filter(call => call.command === "ssh").every(call => (call.timeoutMs ?? Infinity) <= 300000)).toBe(true);
  }, 30_000);
  it("names a failed binding push's stderr class without its row text", () => {
    expect(stderrClass("\nSyntaxError: Unexpected token 'x', \"{\"env\":{\"K\":\"secret\"}\" is not valid JSON\n    at JSON.parse")).toBe("SyntaxError: Unexpected token …");
    expect(stderrClass("alice@remote1: Permission denied (publickey).")).toBe("alice@remote1: Permission denied (publickey).");
    expect(stderrClass("ENOENT {\"path\":\"/x\"}")).toBe("ENOENT …");
    expect(stderrClass("")).toBe("no stderr");
  });
  // Bravestarr, 2026-10-11: a restart's binding push failed, so remote1 workers kept naming the retired owner session.
  it("an owner pass re-sends a stale remote binding once, then writes nothing", async () => {
    const s = setup(); await s.open(); const { row } = await s.launch();
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(a => a.name === row.name ? { ...a, owner: "new-owner" } : a) }, undefined] as const)));
    const asNew = Effect.provideService(MusterEnv, { ...s.env, sessionId: "new-owner" });
    const first = await s.run(projectStatus(s.dir, { act: true }).pipe(asNew));
    expect(JSON.stringify(first)).toContain("re-sent 1 stale remote binding");
    expect(JSON.parse(readFileSync(remoteBindingPath(row.cwd, row.name), "utf8")).owner).toBe("new-owner");
    const second = await s.run(projectStatus(s.dir, { act: true }).pipe(asNew));
    expect(JSON.stringify(second)).not.toContain("stale remote binding");
  });
  it("non-owner status interrupts a gone remote pane without touching live panes", async () => {
    const s = setup(); await s.open(); const { row } = await s.launch();
    s.remote.panes.delete(row.pane!.paneId);
    const boundary = s.remote.calls.length;
    await s.run(projectStatus(s.dir, { act: true }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: "other-owner" })));
    expect((await s.run(load(s.dir))).agents[0]).toMatchObject({ state: "interrupted", pane: null, owner: row.owner });
    expect(s.remote.calls.slice(boundary).some(call => ["pane.close", "agent.prompt", "pane.send_input"].includes(call.method))).toBe(false);
  });
  // Bravestarr, 2026-10-10: close removed the row's brief copy, so restore failed with ENOENT on it.
  it("restore of a closed remote row re-copies its brief from the owner-side source", async () => {
    const s = setup(); await s.open();
    const brief = join(s.dir, "w2-brief.md"); writeFileSync(brief, "fold the second wave\n");
    const launched = await s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "w2-fold", role: "worker", lane: "work", label: "fold worker", clone: true, noSkills: true, brief }));
    const copy = launched.row.brief!;
    expect(copy).not.toBe(brief); expect(readFileSync(copy, "utf8")).toBe("fold the second wave\n");
    writeFileSync(join(launched.row.cwd, "wip.txt"), "unharvested\n"); // close keeps a clone with work in it
    await s.run(agentClose(s.dir, { name: "w2-fold" }));
    expect(existsSync(launched.row.cwd)).toBe(true);
    expect(existsSync(copy)).toBe(false);
    const restored = await s.run(agentLaunch(s.dir, { action: "restore", name: "w2-fold" }));
    expect(restored.row.state).toBe("running");
    expect(readFileSync(restored.row.brief!, "utf8")).toBe("fold the second wave\n");
  });
  it("saves the mapped role policy in a remote pre-Pi failure's restore command", async () => {
    const { s, launched: { row } } = await launchedFork();
    const prompt = join(s.dir, "worker-policy.txt"), mappedPrompt = join(s.dir, "remote-worker-policy.txt");
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, paths: { [prompt]: mappedPrompt } }) });
    // A launch that failed before Pi started has no journal or policy-bearing live profile.
    await s.run(mutate(s.dir, project => Effect.succeed([decodeProject({ ...project,
      policy: { ...project.policy, roles: { worker: { tools: ["read", "bash"], appendSystemPrompt: [prompt] } } },
      agents: project.agents.map(agent => agent.name === row.name ? { ...agent, state: "failed", pane: null, sessionFile: null, restore: null, profile: { ...agent.profile, policy: undefined } } : agent),
    }), undefined] as const)));
    const closed = await s.run(agentClose(s.dir, { name: row.name }));
    expect(closed.restore.argv).toEqual(expect.arrayContaining(["--tools", "read,bash", "--append-system-prompt", mappedPrompt]));
  });
  it("maps a transferred brief copy back to its owner-side source", () => {
    const machine = config({ paths: { "/Users/alice": "/home/alice" } });
    const transfer = "/home/alice/.cache/muster-transfers/drovr/w2-fold", hash = "a".repeat(64);
    expect(transferredBriefSource(`${transfer}/files/${hash}/home/alice/.agent/b.md`, transfer, machine)).toBe("/Users/alice/.agent/b.md");
    expect(transferredBriefSource("/home/alice/other/b.md", transfer, machine)).toBeNull();
  });
  it("restore recovers a running remote row whose bound pane is gone", async () => {
    const s = setup(); await s.open(); const { row } = await s.launch();
    s.remote.panes.delete(row.pane!.paneId);
    const result = await s.run(agentLaunch(s.dir, { action: "restore", name: row.name }));
    expect(result.row.state).toBe("running"); expect(result.row.owner).toBe(row.owner);
    expect(result.notes.join("\n")).toContain("gone; interrupted before restore");
    expect(result.row.events?.some(event => event.type === "PANE_GONE")).toBe(true);
  });
  it("keeps remote-only skill paths across restore instead of rediscovering them locally", async () => {
    const s = setup(); await s.open();
    const original = s.proc.run;
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => command === "ssh" && args.at(-1)?.includes("'test' '-r' '/only-remote/SKILL.md'")
      ? Effect.succeed({ code: 0, stdout: "", stderr: "" }) : original(command, args, options));
    const launched = await s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "skill-worker", role: "worker", lane: "work", label: "skill worker", cwd: s.dir, skills: ["/only-remote/SKILL.md"] }));
    expect(launched.row.profile.skills).toEqual(["/only-remote/SKILL.md"]);
    await s.run(agentClose(s.dir, { name: launched.row.name }));
    const restored = await s.run(agentLaunch(s.dir, { action: "restore", name: launched.row.name }));
    expect(restored.row.profile.skills).toEqual(["/only-remote/SKILL.md"]);
    expect(restored.argv).toContain("/only-remote/SKILL.md");
  });
  it("drops a skill that is unreadable on the remote machine with a note, instead of failing the launch", async () => {
    // Live 2026-10-07: /Users/alice/.agents/skills paths are not mapped to remote1, and every launch failed.
    const s = setup(); await s.open();
    const original = s.proc.run;
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => command === "ssh" && args.at(-1)?.includes("'test' '-r' '/flagg-only/SKILL.md'")
      ? Effect.succeed({ code: 1, stdout: "", stderr: "" }) : original(command, args, options));
    const launched = await s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "skill-drop", role: "worker", lane: "work", label: "skill drop", cwd: s.dir, skills: ["/flagg-only/SKILL.md"] }));
    expect(launched.row.profile.skills).not.toContain("/flagg-only/SKILL.md");
    expect(launched.notes.join("\n")).toContain("skill /flagg-only/SKILL.md is not readable on remote; launched without it");
  });
  it("sends clone launches without a machine to the cloneDefault machine, and refuses two defaults", async () => {
    const s = setup(); await s.open();
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, wrap: ["/wrapper", "--name", "{name}", "--"], cloneDefault: true }) });
    const launched = await s.run(agentLaunch(s.dir, { action: "launch", name: "default-w", role: "worker", lane: "work", label: "default worker", clone: true, noSkills: true }));
    expect(launched.row.machine).toBe("remote");
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, cloneDefault: true }), other: config({ workerWorktree: s.h.workerWorktree, cloneDefault: true }) });
    await expect(s.run(agentLaunch(s.dir, { action: "launch", name: "two-w", role: "worker", lane: "work", label: "two", clone: true, noSkills: true }))).rejects.toThrow(/cloneDefault is set on remote, other/);
  }, 30_000);
  it("maps a model's provider for the machine, and refuses a mapped model the machine does not serve", async () => {
    const s = setup(); await s.open();
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, providerMap: { "openai-codex": "cliproxy-codex" } }) });
    const original = s.proc.run; let served = true;
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => command === "ssh" && args.at(-1)?.includes("'node' '-e'") && args.at(-1)?.includes(".pi/agent/models.json")
      ? Effect.succeed({ code: served ? 0 : 3, stdout: "", stderr: "" }) : original(command, args, options));
    const launched = await s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "proxy-w", role: "worker", lane: "work", label: "proxy", cwd: s.dir, noSkills: true, model: "openai-codex/gpt-6-sol" }));
    expect(launched.row.profile.model).toBe("cliproxy-codex/gpt-6-sol");
    served = false;
    await expect(s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "proxy-x", role: "worker", lane: "work", label: "proxy", cwd: s.dir, noSkills: true, model: "openai-codex/gpt-6.1-sol" })))
      .rejects.toThrow(/maps to cliproxy-codex\/gpt-6.1-sol on remote, which its ~\/.pi\/agent\/models.json does not serve/);
  }, 30_000);
  it("launches with a synced private brief and removes only its remote copies on close", async () => {
    const s = setup(); await s.open();
    const inputs = join(s.h.root, "inputs"); mkdirSync(inputs);
    const brief = join(inputs, "brief.md"), reference = join(inputs, "review with spaces.svx");
    writeFileSync(reference, "source review"); writeFileSync(brief, `Read \`${reference}\` and report.\n`);
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, paths: { [inputs]: "/mapped/inputs" } }) });
    const launched = await s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "private-w", role: "worker", lane: "work", label: "private worker", clone: true, noSkills: true, brief }));
    expect(launched.row.brief).not.toBe(brief); expect(statSync(launched.row.brief!).mode & 0o777).toBe(0o600);
    expect(launched.argv).toContain(`@${launched.row.brief}`);
    const context = launched.row.profile.appendSystemPrompt.at(-1)!;
    expect(readFileSync(context, "utf8")).toContain("review with spaces.svx");
    expect(readFileSync(context, "utf8")).toContain("do not try a second destructive command");
    const closed = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(existsSync(launched.row.brief!)).toBe(false); expect(existsSync(brief)).toBe(true); expect(existsSync(reference)).toBe(true);
    expect(closed.notes.join(" ")).toContain("private input removed"); expect(existsSync(launched.row.cwd)).toBe(false);
  });
  it("names an unreadable owner brief before allocating a clone", async () => {
    const s = setup(); await s.open();
    await expect(s.run(agentLaunch(s.dir, { action: "launch", machine: "remote", name: "brief-worker", role: "worker", lane: "work", label: "brief worker", cwd: s.dir, brief: "/flagg-only/brief.md" })))
      .rejects.toThrow(/brief sync/);
    expect(s.remote.panes.size).toBe(0);
  });
  it("refuses at maxPanes before allocating any clone or pane", async () => {
    const s = setup(); s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, maxPanes: 1 }) }); await s.open(); await s.launch();
    const count = s.remote.panes.size; const calls = s.calls.length;
    await expect(s.launch("remote-next")).rejects.toThrow("maxPanes 1 reached");
    expect(s.remote.panes.size).toBe(count); expect(s.calls).toHaveLength(calls);
  });

  // Fleet burn, 2026-10-20: the machine lock covered probe, clone and Pi start, so launches queued 30 deep and timed out.
  describe("the machine launch lock covers only the pane count and pane allocation", () => {
    const clone = (command: string, args: readonly string[]) => command === "ssh" && args.at(-1)!.includes("'create'") && args.at(-1)!.includes("worker-worktree");
    /** Lock waits and Herdr calls yield a real tick, so a concurrent launch can run between them, as on a live host. */
    const live = (s: ReturnType<typeof setup>, hold: (method: string) => Promise<void> | undefined = () => undefined) => {
      const tick = Effect.promise(() => new Promise<void>(resolve => setImmediate(resolve)));
      // A fake 100 ms costs a real millisecond: a 300 s lock wait outlasts any real hold below.
      Object.assign(s.env, { sleep: (ms: number) => Effect.promise(() => new Promise<void>(resolve => setTimeout(resolve, 1))).pipe(Effect.andThen(Effect.sync(() => { s.h.now = new Date(s.h.now.getTime() + ms); }))) });
      const client = s.remote.client();
      Object.assign(s.env, { remoteHerdr: () => Effect.succeed({ ...client, request: (request: Parameters<typeof client.request>[0]) => {
        const held = hold(request.method);
        return (held ? Effect.promise(() => held) : tick).pipe(Effect.andThen(client.request(request)));
      } }) });
    };
    /** The first launch to reach `point` waits there until a second one reaches it too (capped, so a full lock cannot hang the test). */
    const meet = (s: ReturnType<typeof setup>, point: (command: string, args: readonly string[]) => boolean, onArrive: () => void = () => {}) => {
      let arrived = 0; let release!: () => void;
      const both = new Promise<void>(resolve => { release = resolve; });
      s.setBefore((command, args) => {
        if (!point(command, args)) return undefined;
        arrived += 1; onArrive();
        if (arrived >= 2) { release(); return undefined; }
        return Promise.race([both, new Promise<void>(resolve => setTimeout(resolve, 3000))]);
      });
      return { release: () => release(), arrived: () => arrived };
    };

    it("runs a second row's clone before the first row's Pi start", async () => {
      const s = setup(); await s.open(); live(s);
      const events: string[] = [];
      meet(s, clone, () => events.push("clone"));
      const handle = s.remote.handle.bind(s.remote);
      s.remote.handle = (method, params) => { if (method === "pane.send_input" && String(params.text).startsWith("exec sh ")) events.push("pi start"); return handle(method, params); };
      const results = await Promise.allSettled([s.launch("remote-a"), s.launch("remote-b")]);
      expect(results.map(result => result.status === "rejected" ? String(result.reason) : result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(events).toEqual(["clone", "clone", "pi start", "pi start"]);
    });

    it("admits exactly one of two concurrent launches at maxPanes 1", async () => {
      const s = setup(); s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, maxPanes: 1 }) }); await s.open(); live(s);
      const gate = meet(s, clone);
      const launches = [s.launch("remote-a"), s.launch("remote-b")];
      for (const launch of launches) launch.then(gate.release, gate.release);
      const results = await Promise.allSettled(launches);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : [])).toEqual([expect.stringContaining("maxPanes 1 reached (1 open Muster rows or launches)")]);
      expect(gate.arrived()).toBe(1);
      // The winner's reservation is released; its row now counts by its pane.
      expect(readdirSync(join(s.h.home, ".config/muster/launch-locks/remote.reservations"))).toEqual([]);
    });

    it("counts a live reservation and ignores one whose pid is gone", async () => {
      const s = setup(); s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, maxPanes: 1 }) }); await s.open();
      const root = join(s.h.home, ".config/muster/launch-locks/remote.reservations"); mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "another-owner-launch"), String(process.pid));
      await expect(s.launch("remote-a")).rejects.toThrow("maxPanes 1 reached");
      const dead = spawnSync("true").pid!;
      writeFileSync(join(root, "another-owner-launch"), String(dead));
      await expect(s.launch("remote-a")).resolves.toMatchObject({ row: { name: "remote-a", state: "running" } });
      expect(readdirSync(root)).toEqual([]);
    });

    it("refuses a second concurrent launch of the same row", async () => {
      const s = setup(); await s.open();
      const root = join(s.h.home, ".config/muster/launch-locks/remote.reservations"); mkdirSync(root, { recursive: true });
      const { launchReservationKey } = await import("./remote.ts");
      writeFileSync(join(root, launchReservationKey(s.dir, "remote-a")), String(process.pid));
      await expect(s.launch("remote-a")).rejects.toThrow("another launch of it is in progress on remote");
    });

    it("creates one workspace for two concurrent launches into an empty space", async () => {
      const s = setup(); await s.open();
      s.remote.workspaces.clear();
      // The first launch to look for the workspace waits briefly for the second to look too. Under the lock the second
      // cannot look until the first has created it, so the wait runs out.
      let looked = 0; let release!: () => void; const both = new Promise<void>(resolve => { release = resolve; });
      live(s, method => {
        if (method !== "workspace.list") return undefined;
        looked += 1;
        if (looked >= 2) { release(); return undefined; }
        return Promise.race([both, new Promise<void>(resolve => setTimeout(resolve, 500))]);
      });
      const results = await Promise.allSettled([s.launch("remote-a"), s.launch("remote-b")]);
      expect(results.map(result => result.status === "rejected" ? String(result.reason) : result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(s.remote.calls.filter(call => call.method === "workspace.create")).toHaveLength(1);
      expect(s.remote.workspaces.size).toBe(1);
      const panes = results.flatMap(result => result.status === "fulfilled" ? [result.value.row.pane!] : []);
      expect(new Set(panes.map(pane => pane.tabId)).size).toBe(1);
    });
  });
  it("reports missing remote prerequisites before allocating anything", async () => {
    const s = setup(); await s.open(); s.setMissing();
    await expect(s.launch()).rejects.toThrow("machine remote: missing prerequisites");
    expect(s.remote.calls).toHaveLength(0);
  });
  it("rebinds moved remote sessions before the next pass can nudge", async () => {
    const { s, launched } = await launchedFork();
    const pane = s.remote.panes.get(launched.row.pane!.paneId)!;
    pane.agent_status = "working"; // silent mid-turn, not waiting
    s.remote.panes.delete(pane.pane_id); pane.pane_id = "moved"; s.remote.panes.set("moved", pane);
    const old = new Date(s.h.now.getTime() - 35*60000); utimesSync(launched.row.sessionFile!, old, old);
    const status = await s.run(projectStatus(s.dir));
    expect(status.agents[0]?.pane).toBe("moved"); expect(status.agents[0]?.silentMin).toBeGreaterThanOrEqual(35);
    expect(status.agents[0]?.cost).toBe(null);
    expect(status.agents[0]?.action).toContain("rebound");
    expect(s.remote.calls.some(call => call.method === "pane.send_keys" && call.params.pane_id === "moved")).toBe(false);
    expect(s.calls.filter(call => call.command === "ssh" && call.args.at(-1)?.includes("mtimeMs"))).toHaveLength(1);
    await s.run(projectStatus(s.dir));
    // A working pane gets the note alone; Escape would abort its running tool call (rule hunt, 2026-10-17).
    expect(s.remote.calls.some(call => call.method !== "pane.send_keys" && call.params.pane_id === "moved" && String(call.params.text ?? call.params.command ?? "").includes("written nothing"))).toBe(true);
    expect(s.remote.calls.some(call => call.method === "pane.send_keys" && call.params.pane_id === "moved")).toBe(false);
  });
  // Servo, 2026-10-20 (content-grill): the lane repo existed only on pennywise, and verify ran git on the owner: spawn git ENOENT.
  it("verifies a packet whose source repo exists only on the worker's machine", async () => {
    const s = setup(); await s.open(); const launched = await s.launch(); const cwd = launched.row.cwd;
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "remote source");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "remote source", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs(); vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", "");
    // The owner sees the source only under a path that does not exist locally; the machine maps it to the real checkout.
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, env: { CUDA_VISIBLE_DEVICES: "", MUSTER_FLEET_COMPUTE: "off", HOME: s.h.home }, wrap: ["/wrapper", "--name", "{name}", "--"], paths: { "/ghost-local": join(s.dir, "..") } }) });
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === launched.row.name ? { ...row, clone: { ...row.clone!, source: "/ghost-local/source" } } : row) }, undefined] as const)));
    const verified = await s.run(packetVerify(s.dir, commit));
    expect(verified.checks).toContainEqual({ name: "expected repo", outcome: "pass" });
  });
  // Switchboard, #10 review: a failed read of the source's roots must name its cause, not just fail.
  it("names the exit code when the worker's machine cannot read the source repo", async () => {
    const s = setup(); await s.open(); const launched = await s.launch(); const cwd = launched.row.cwd;
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "remote source");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "remote source", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs(); vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", "");
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, env: { CUDA_VISIBLE_DEVICES: "", MUSTER_FLEET_COMPUTE: "off", HOME: s.h.home }, wrap: ["/wrapper", "--name", "{name}", "--"], paths: { "/ghost-local": join(s.dir, "..") } }) });
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === launched.row.name ? { ...row, clone: { ...row.clone!, source: "/ghost-local/missing" } } : row) }, undefined] as const)));
    const error = await s.run(Effect.flip(packetVerify(s.dir, commit)));
    expect(error._tag).toBe("PacketCheckFailed");
    expect(JSON.stringify((error as { failures?: unknown }).failures)).toMatch(/expected repo: source roots on remote: exit [1-9]\d*: /);
  });
  it("verifies and lands a remote-only packet over SSH", async () => {
    const s = setup(); await s.open(); const launched = await s.launch(); const cwd = launched.row.cwd;
    sh(cwd, "checkout", "--detach", "main");
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "remote-only");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    sh(cwd, "update-ref", "refs/remotes/origin/worker/remote-only", commit);
    sh(cwd, "checkout", launched.row.clone!.branch);
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "remote-only", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    const verified = await s.run(packetVerify(s.dir, commit));
    expect(verified.checks).toContainEqual({ name: "on lane branch", outcome: "pass", detail: `on remote-tracking branch origin/worker/remote-only (row branch ${launched.row.clone!.branch})` });
    expect((await s.run(load(s.dir))).agents.find(row => row.name === launched.row.name)?.clone?.branch).toBe("origin/worker/remote-only");
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("refs/remotes"))).toBe(true);
    const landed = await s.run(packetLand(s.dir, { id: commit, outcome: "committed" }));
    expect(landed.packet.state).toBe("committed");
    expect(readFileSync(join(s.dir, "work.txt"), "utf8")).toBe("packet\n");
  });

  // codetv-workshop, 2026-10-14: a remote1 lane's repo path is absent on Flagg; attested landing ran git there locally.
  it("an attested landing of a remote packet proves landedAs on the row's machine, never with local git", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "remote work");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "remote work", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs(); // the owner lands from Flagg, not from the row's machine
    expect((await s.run(packetVerify(s.dir, commit))).packet.state).toBe("verified");
    sh(s.dir, "fetch", "-q", cwd, commit); sh(s.dir, "merge", "--squash", "-q", commit); sh(s.dir, "commit", "-qm", "squash-merged elsewhere");
    const landedAs = sh(s.dir, "rev-parse", "HEAD").trim();
    s.calls.length = 0;
    const landed = await s.run(packetLand(s.dir, { id: commit, outcome: "committed", landedAs, attested: true, evidence: "squash-merged as PR #1" }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs, attested: true });
    expect(s.calls.filter(call => call.command === "git")).toEqual([]);
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("merge-base"))).toBe(true);
  });

  // imp, 2026-10-26: a refs/heads/ base names the owner's branch; the remote machine's copy of the repo sat far behind.
  it("an attested remote landing with a refs/heads/ base proves in the owner's checkout", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "remote work");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "remote work", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs();
    expect((await s.run(packetVerify(s.dir, commit))).packet.state).toBe("verified");
    sh(s.dir, "fetch", "-q", cwd, commit); sh(s.dir, "merge", "--squash", "-q", commit); sh(s.dir, "commit", "-qm", "squash-merged on the owner's main");
    const landedAs = sh(s.dir, "rev-parse", "HEAD").trim();
    await s.run(laneOpen(s.dir, { slug: launched.row.lane, base: "refs/heads/main" }));
    s.calls.length = 0;
    const landed = await s.run(packetLand(s.dir, { id: commit, outcome: "committed", landedAs, attested: true, evidence: "merged on local main" }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs, attested: true });
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("merge-base"))).toBe(false);
    expect(s.calls.some(call => call.command === "git" && call.args.includes("merge-base"))).toBe(true);
  });

  // muster desk, 2026-10-14: clone.source is an owner path (/Users/alice/...); proving it unmapped on remote1 failed
  // check-ref-format in a missing cwd and read as "requires a base branch, not main".
  it("an attested remote landing proves in the row machine's mapping of an owner-path source", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "remote work");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "remote work", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs();
    expect((await s.run(packetVerify(s.dir, commit))).packet.state).toBe("verified");
    sh(s.dir, "fetch", "-q", cwd, commit); sh(s.dir, "merge", "--squash", "-q", commit); sh(s.dir, "commit", "-qm", "squash-merged elsewhere");
    const landedAs = sh(s.dir, "rev-parse", "HEAD").trim();
    const ownerSource = join(s.h.root, "owner-only", "repo");
    const project = JSON.parse(readFileSync(projectPath(s.dir), "utf8"));
    project.agents[0].clone.source = ownerSource;
    writeFileSync(projectPath(s.dir), JSON.stringify(project));
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, paths: { [ownerSource]: s.dir } }) });
    const landed = await s.run(packetLand(s.dir, { id: commit, outcome: "committed", landedAs, attested: true, evidence: "desk landed it" }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs, attested: true });
  });

  it("verifies and records a remote sibling branch", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    sh(cwd, "checkout", "-qb", "worker/remote-next", "main");
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "sibling");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "sibling", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs(); // the owner runs on another machine
    const verified = await s.run(packetVerify(s.dir, commit));
    expect(verified.checks).toContainEqual({ name: "on lane branch", outcome: "pass", detail: `on sibling branch worker/remote-next (row branch ${launched.row.clone!.branch})` });
    expect(verified.note).toContain("updated clone.branch to worker/remote-next");
    expect(verified.checks).toContainEqual({ name: "clone branch", outcome: "pass", detail: `updated to worker/remote-next (was ${launched.row.clone!.branch})` });
    expect((await s.run(load(s.dir))).agents[0]?.clone?.branch).toBe("worker/remote-next");
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("for-each-ref"))).toBe(true);
  });

  // rubicon-fitness, 2026-10-26: coldread's row was failed when its sidecar arrived; "REPORT is not allowed from failed"
  // skipped the ingest, and agent_close refused on that skip.
  it("ingests a sidecar for a failed row and keeps the row's state", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "work");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "late work", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs();
    const project = JSON.parse(readFileSync(projectPath(s.dir), "utf8"));
    project.agents[0].state = "failed";
    writeFileSync(projectPath(s.dir), JSON.stringify(project));
    expect((await s.run(ingestRemotePackets(s.dir))).notes.filter(note => note.includes("ingest skipped"))).toEqual([]);
    const after = await s.run(load(s.dir));
    expect(after.packets.map(packet => [packet.id, packet.state])).toEqual([[commit, "reported"]]);
    expect(after.agents[0]?.state).toBe("failed");
  });

  it("ingests sidecars idempotently, verifies and lands a remote branch into the local source", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "work");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    const before = readFileSync(projectPath(s.dir), "utf8");
    const report = await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "Remote work committed", checks: [{ name: "unit", outcome: "pass" }] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(before);
    expect(existsSync(join(sidecarRoots(cwd)[0]!, "packets", commit, "packet.json"))).toBe(true);
    expect(sh(cwd, "status", "--porcelain").trim()).toBe("");
    // Unknown packet verification must ingest it before lookup.
    const verified = await s.run(packetVerify(s.dir, commit)); expect(verified.packet.state).toBe("verified");
    await s.run(ingestRemotePackets(s.dir)); await s.run(ingestRemotePackets(s.dir));
    expect((await s.run(load(s.dir))).packets).toHaveLength(1);
    expect((await s.run(load(s.dir))).packets[0]?.state).toBe("verified");
    expect(readFileSync(verified.packet.report, "utf8")).toBe(readFileSync(report.packet.report, "utf8"));
    const landed = await s.run(packetLand(s.dir, { id: commit, outcome: "committed" }));
    expect(landed.packet.state).toBe("committed"); expect(readFileSync(join(s.dir, "work.txt"), "utf8")).toBe("packet\n");
    expect(s.calls.some(call => call.command === "git" && call.args.includes(`ssh://remote/${cwd.replace(/^\//, "")}`))).toBe(true);
    const raw = JSON.parse(readFileSync(projectPath(s.dir), "utf8")); for (const row of raw.agents) { delete row.machine; delete row.intercomAddress; }
    expect(decodeProject(raw).agents[0]?.machine).toBe("local");
  });
  it("uses remote session-tree evidence for a labelled fork and rewind", async () => {
    const s = setup(); s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, musterExtension: process.cwd() }) });
    await s.open(); const launched = await s.launch();
    const tree = SessionManager.open(launched.row.sessionFile!);
    tree.appendMessage({ role: "user", content: "Read source", timestamp: 1 });
    const target = tree.appendMessage({ role: "assistant", content: [{ type: "text", text: "Read" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6.1-sol", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
    tree.appendLabelChange(target, "ctx:ready"); tree.appendMessage({ role: "user", content: "Wrong instruction", timestamp: 3 });
    const fork = await s.run(agentLaunch(s.dir, { action: "fork", name: "labelled-child", from: launched.row.name, at: "ctx:ready", clone: true }));
    expect(fork.row.parentSessionFile).not.toBe(launched.row.sessionFile);
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("forkSessionAt"))).toBe(true);
    const original = s.remote.handle.bind(s.remote);
    s.remote.handle = (method, params) => {
      if (method === "agent.get") {
        const result = original("agent.wait", params) as { agent: { agent_status: string } }; result.agent.agent_status = "idle"; return result;
      }
      if (method === "pane.send_input" && String(params.text).startsWith("/muster-rewind")) tree.branchWithSummary(target, "Corrected branch");
      return original(method, params);
    };
    const rewind = await s.run(agentRewind(s.dir, { name: launched.row.name, to: "ctx:ready", note: "Use correction" }));
    expect(rewind.entryId).toBe(target); expect(rewind.evidence).toBeTruthy();
    expect(s.remote.calls.filter(call => call.method === "pane.send_input" && String(call.params.text).startsWith("/muster-rewind"))).toHaveLength(1);
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("openSessionTree"))).toBe(true);
  }, 30_000);
  it("rejects a sidecar from a different project that names this row, without changing the owner catalog", async () => {
    const { s, launched } = await launchedFork();
    const id = sh(launched.row.cwd, "rev-parse", "HEAD").trim();
    const root = join(launched.row.cwd, ".pi/muster/packets", id); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "packet.json"), JSON.stringify({ project: "wrong", machine: "remote", packet: { id, kind: "commit", artifact: null, lane: "work", agent: launched.row.name, report: "/report", checks: [], state: "reported", verification: null, landedAs: null, reportedAt: s.h.now.toISOString(), updatedAt: s.h.now.toISOString() }, reportText: "wrong" }));
    const before = readFileSync(projectPath(s.dir), "utf8");
    const result = await s.run(ingestRemotePackets(s.dir));
    expect(result.notes.join("\n")).toContain("invalid packet sidecar identity");
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(before);
  });
  // 🧠, 2026-10-12: hooksv141 reused hooksv14's clone; the closed row's sidecars failed identity against the new row and close refused.
  it("skips a sidecar for a packet already in the catalog, even one an earlier row left in a reused clone", async () => {
    const { s, launched } = await launchedFork();
    const id = sh(launched.row.cwd, "rev-parse", "HEAD").trim();
    const packet = { id, kind: "commit", artifact: null, lane: "work", agent: launched.row.name, report: "/report", checks: [], state: "reported", verification: null, landedAs: null, reportedAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" };
    const root = join(launched.row.cwd, ".pi/muster/packets", id); mkdirSync(root, { recursive: true });
    const sidecar = (agent: string) => writeFileSync(join(root, "packet.json"), JSON.stringify({ project: "probe", machine: "remote", packet: { ...packet, agent }, reportText: "report" }));
    sidecar(launched.row.name);
    expect((await s.run(ingestRemotePackets(s.dir))).notes).toEqual([]);
    expect((await s.run(load(s.dir))).packets.map(p => p.id)).toEqual([id]);
    // The same clone now serves a later row: the sidecar names the earlier row, and its packet is already recorded.
    sidecar("earlier-row");
    const before = readFileSync(projectPath(s.dir), "utf8");
    expect((await s.run(ingestRemotePackets(s.dir))).notes).toEqual([]);
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(before);
  });
  // content-grill, 2026-10-20: celld-surface and celld-stateid both ran in the alchemy-celld checkout; celld-stateid's note
  // failed celld-surface's identity check and its close refused.
  it("leaves a live sibling's sidecar in a shared checkout to the sibling's own ingest", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const sibling = { ...launched.row, name: "sibling", sessionId: "sibling-20261020T000000", state: "reported" as const, pane: null };
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: [...p.agents, sibling] }, undefined] as const)));
    const item = appendOwnerItem(sibling.owner, { author: sibling.sessionId, lane: sibling.lane, kind: "question", title: "From the sibling" }, join(s.h.root, "remote-home"));
    const root = join(launched.row.cwd, ".pi/muster/notes"); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${"d".repeat(64)}.json`), JSON.stringify({ project: "probe", machine: "remote", agent: "sibling", lane: sibling.lane, owner: sibling.owner, item }));
    const result = await s.run(ingestRemotePackets(s.dir));
    expect(result.notes.join("\n")).not.toContain("invalid note sidecar identity");
    expect(readOwnerQueue(sibling.owner, s.h.home).items.map(record => record.item)).toEqual([item]);
  });
  // rubicon-fitness, 2026-10-13: athlete-migration-sync-2 reused a closed row's worktree whose sidecar was never ingested; close refused.
  // codetv-workshop, 2026-10-13: a closed row in another lane ran in the source checkout, and every clone copied its sidecars.
  it("notes and skips never-ingested packet and note sidecars left by a closed row in any lane", async () => {
    const { s, launched } = await launchedFork();
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: [...p.agents, { ...launched.row, name: "earlier-row", lane: "elsewhere", state: "closed" as const, pane: null }] }, undefined] as const)));
    const id = sh(launched.row.cwd, "rev-parse", "HEAD").trim();
    const packet = { id, kind: "commit", artifact: null, lane: "elsewhere", agent: "earlier-row", report: "/report", checks: [], state: "reported", verification: null, landedAs: null, reportedAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" };
    const root = join(launched.row.cwd, ".pi/muster/packets", id); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "packet.json"), JSON.stringify({ project: "probe", machine: "remote", packet, reportText: "report" }));
    const result = await s.run(ingestRemotePackets(s.dir));
    expect(result.notes).toEqual([`packet sidecar ${id.slice(0, 12)} was left by closed row earlier-row and never ingested; ignored for ${launched.row.name} (check it landed if that work matters)`]);
    expect((await s.run(load(s.dir))).packets).toEqual([]);
    rmSync(root, { recursive: true });
    const noteId = "61829ad01878d31ffe835240707d15449cb03c3640264bd3a631b3954be8e1b2";
    mkdirSync(join(launched.row.cwd, ".pi/muster/notes"), { recursive: true });
    const item = appendOwnerItem("old-owner", { author: "earlier-session", lane: "elsewhere", kind: "fyi", title: "old note" }, join(s.h.root, "remote-home"));
    writeFileSync(join(launched.row.cwd, ".pi/muster/notes", `${noteId}.json`), JSON.stringify({ project: "probe", machine: "remote", agent: "earlier-row", lane: "elsewhere", owner: "old-owner", item }));
    const notesResult = await s.run(ingestRemotePackets(s.dir));
    expect(notesResult.notes.some(note => note.startsWith(`note sidecar ${noteId.slice(0, 12)} was left by closed row earlier-row`))).toBe(true);
    expect(notesResult.notes.join("\n")).not.toContain("ingest skipped");
  });
  // aih-support-sweep, 2026-10-14: codetv-workshop rows had run in the remote1 ai-hero source checkout; every aih clone
  // copied their sidecars, ingest refused them as "invalid sidecar identity" and close refused lgseat2 and giftnow.
  it("notes and skips packet and note sidecars that belong to another project", async () => {
    const { s, launched } = await launchedFork();
    const id = sh(launched.row.cwd, "rev-parse", "HEAD").trim();
    const packet = { id, kind: "commit", artifact: null, lane: "cb-security", agent: "cb-bump", report: "/report", checks: [], state: "reported", verification: null, landedAs: null, reportedAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z" };
    const root = join(launched.row.cwd, ".pi/muster/packets", id); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "packet.json"), JSON.stringify({ project: "other-project", machine: "remote", packet, reportText: "report" }));
    const noteId = "058320c05962e3c644bad3c823b1b04cbd2bbea7af7968b3ee94244aae6cd652";
    mkdirSync(join(launched.row.cwd, ".pi/muster/notes"), { recursive: true });
    const item = appendOwnerItem("other-owner", { author: "cb-bump-session", lane: "cb-security", kind: "fyi", title: "other note" }, join(s.h.root, "remote-home"));
    writeFileSync(join(launched.row.cwd, ".pi/muster/notes", `${noteId}.json`), JSON.stringify({ project: "other-project", machine: "remote", agent: "cb-bump", lane: "cb-security", owner: "other-owner", item }));
    const result = await s.run(ingestRemotePackets(s.dir));
    expect(result.notes).toEqual(expect.arrayContaining([
      `packet sidecar ${id.slice(0, 12)} belongs to project other-project, copied from the clone's source; ignored for ${launched.row.name} (that project's owner should check it landed)`,
      `note sidecar ${noteId.slice(0, 12)} belongs to project other-project, copied from the clone's source; ignored for ${launched.row.name} (that project's owner should check it landed)`]));
    expect(result.notes.join("\n")).not.toContain("ingest skipped");
    expect((await s.run(load(s.dir))).packets).toEqual([]);
  });
  it("keeps local status available and skips remaining machine rows after a transport failure", async () => {
    const { s } = await launchedFork(); await s.launch("remote-two");
    const local = await s.run(agentLaunch(s.dir, { action: "launch", name: "local-w", role: "worker", lane: "work", label: "local worker", clone: true, noSkills: true }));
    s.calls.length = 0;
    const original = s.proc.run;
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => command === "ssh"
      ? Effect.fail(new ProcError({ command: "ssh remote", code: 255, stderr: "offline", message: "machine remote: offline" })) : original(command, args, options));
    const status = await s.run(projectStatus(s.dir, { act: false }));
    expect(status.agents.find(row => row.name === local.row.name)?.state).toBe("running");
    expect(status.board).toContain("machine remote: session stats skipped");
    expect(status.notes.join("\n")).toContain("machine remote: offline");
    expect((await s.run(load(s.dir))).agents.filter(row => row.machine === "remote").every(row => row.state === "running")).toBe(true);
    expect(vi.mocked(s.proc.run).mock.calls.filter(([command]) => command === "ssh")).toHaveLength(1);
  });
  it("skips malformed sidecars while ingesting a good sidecar in the same pass", async () => {
    const { s, launched } = await launchedFork();
    const id = sh(launched.row.cwd, "rev-parse", "HEAD").trim();
    const root = join(launched.row.cwd, ".pi/muster/packets");
    for (const key of [id, "a".repeat(40)]) mkdirSync(join(root, key), { recursive: true });
    writeFileSync(join(root, "a".repeat(40), "packet.json"), "{broken JSON");
    writeFileSync(join(root, id, "packet.json"), JSON.stringify({ project: "probe", machine: "remote", packet: { id, kind: "commit", artifact: null, lane: "work", agent: launched.row.name, report: "/report", checks: [], state: "reported", verification: null, landedAs: null, reportedAt: s.h.now.toISOString(), updatedAt: s.h.now.toISOString() }, reportText: "good report" }));
    const result = await s.run(ingestRemotePackets(s.dir));
    expect(result.notes.join("\n")).toContain(`sidecar ${"a".repeat(40)}`);
    expect((await s.run(load(s.dir))).packets.map(packet => packet.id)).toEqual([id]);
    expect(readFileSync((await s.run(load(s.dir))).packets[0]!.report, "utf8")).toBe("good report");
  });
  it("verifies a local packet without SSH even when a remote machine is offline", async () => {
    const { s } = await launchedFork();
    const local = await s.run(agentLaunch(s.dir, { action: "launch", name: "local-w", role: "worker", lane: "work", label: "local worker", clone: true, noSkills: true }));
    const artifact = join(s.h.root, "local-artifact.txt"); writeFileSync(artifact, "local evidence");
    const report = await s.run(packetReport({ dir: s.dir, agent: local.row.name, owner: local.row.owner, cwd: local.row.cwd, artifact, summary: "Local artifact", checks: [] }));
    const original = s.proc.run;
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => command === "ssh"
      ? Effect.fail(new ProcError({ command: "ssh remote", code: 255, stderr: "offline", message: "machine remote: offline" })) : original(command, args, options));
    expect((await s.run(packetVerify(s.dir, report.packet.id))).packet.state).toBe("verified");
    expect(vi.mocked(s.proc.run).mock.calls.some(([command]) => command === "ssh")).toBe(false);
    await expect(s.run(packetVerify(s.dir, "f".repeat(40)))).rejects.toThrow("machine remote: ingest skipped");
  });
  // drovr, 2026-10-23: project_status act:false never ingests, and packet_land answered a bare "no packet".
  it("packet_land ingests a remote packet it doesn't hold yet, and names a skipped ingest", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/remote-project", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "No source changes", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId })));
    vi.unstubAllEnvs();
    expect((await s.run(load(s.dir))).packets).toEqual([]);
    const landed = await s.run(packetLand(s.dir, { id: commit.slice(0, 12), outcome: "rejected", evidence: "superseded by a later packet" }));
    expect(landed.packet.state).toBe("rejected");
    const original = s.proc.run;
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => command === "ssh"
      ? Effect.fail(new ProcError({ command: "ssh remote", code: 255, stderr: "offline", message: "machine remote: offline" })) : original(command, args, options));
    await expect(s.run(packetLand(s.dir, { id: "f".repeat(40), outcome: "rejected", evidence: "x" }))).rejects.toThrow(/no packet f+; machine remote: ingest skipped/);
  });
  it("ingests a remote packet before closing, so retiring the clone never loses it", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/remote-project", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "No source changes", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs();
    await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect((await s.run(load(s.dir))).packets.map(packet => packet.id)).toContain(commit);
  });
  it("a row whose clone is gone neither poisons the machine nor blocks its own close", async () => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: [{ ...launched.row, name: "dead", state: "failed" as const, pane: null, cwd: join(s.h.root, "gone-clone") }, ...p.agents] }, undefined] as const)));
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/remote-project", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "No source changes", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    vi.unstubAllEnvs();
    const ingest = await s.run(ingestRemotePackets(s.dir));
    expect(ingest.failedMachines.size).toBe(0);
    expect((await s.run(load(s.dir))).packets.map(packet => packet.id)).toContain(commit);
    await s.run(agentClose(s.dir, { name: "dead" }));
    expect((await s.run(load(s.dir))).agents.find(row => row.name === "dead")?.state).toBe("closed");
  });
  it("refuses to close a remote row whose machine cannot be read", async () => {
    const { s, launched } = await launchedFork();
    const original = s.proc.run;
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => command === "ssh"
      ? Effect.fail(new ProcError({ command: "ssh remote", code: 255, stderr: "offline", message: "machine remote: offline" })) : original(command, args, options));
    await expect(s.run(agentClose(s.dir, { name: launched.row.name }))).rejects.toThrow("agent_close refused");
    expect((await s.run(load(s.dir))).agents.find(row => row.name === launched.row.name)?.state).not.toBe("closed");
  });
  it.each(["accepted", "unconsumed", "changed-report"])("retires accepted or freshly ingested unchanged remote sidecars: %s", async kind => {
    const { s, launched } = await launchedFork(); const cwd = launched.row.cwd;
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/remote-project", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "No source changes", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    // Exercise compatibility and the harness-only dirt allowance for in-flight legacy clones.
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    renameSync(sidecarRoots(cwd)[0]!, join(cwd, ".pi/muster"));
    if (kind !== "unconsumed") {
      await s.run(packetVerify(s.dir, commit));
      await s.run(packetLand(s.dir, { id: commit, outcome: "no_changes" }));
    }
    if (kind === "changed-report") writeFileSync(join(cwd, ".pi/muster/packets", commit, "report.svx"), "edited report");
    const result = await s.run(agentClose(s.dir, { name: launched.row.name }));
    // agent_close ingests an unconsumed sidecar first, so the catalog holds it and the clone can go.
    expect(existsSync(cwd)).toBe(kind === "changed-report");
    expect(result.cloneError === null).toBe(kind !== "changed-report");
    if (kind === "unconsumed") expect((await s.run(load(s.dir))).packets.map(packet => packet.id)).toContain(commit);
  });
  it.each([false, true])("retire exact pi-notes scaffolds but preserve edits (%s)", async edited => {
    const { s, launched } = await launchedFork();
    mkdirSync(join(launched.row.cwd, ".brain"), { recursive: true });
    // Exact pi-notes 8a8c3da template owned by this fixture; the source tree has no BRAIN.md.
    const brain = [
      "# pi-notes brain", "",
      "Use pi-notes as an agent-connected project brain, not a generic notes site.", "",
      "- Organize by usefulness: Projects, Areas, Resources, Archives.",
      "- Ask: Where will this be useful next?",
      "- Keep notes atomic, linked, and source-grounded.",
      "- Capture only durable decisions, terms, tradeoffs, gotchas, sources, questions, and review feedback.",
      "- Refine captures into graph edges, backlinks, summaries, and canonical concepts.",
      "- Express knowledge as code, docs, decisions, UI, issues, or plans. Storage is not the goal; output is.",
      "- Browser pages are read/review surfaces. Agents own source edits and must leave receipts.",
      "- Avoid bloated PKM ceremony, append-only logs as truth, Obsidian cloning, and generic static-site sludge.", "",
    ].join("\n");
    writeFileSync(join(launched.row.cwd, "BRAIN.md"), brain);
    const index = ["# Project Brain", "", "The rendered Brain index is programmatic.", "", "Open `/notes` in the local pi-notes Document Host to browse entries sorted by PARA.", "", "Do not maintain a manual page list here; `.brain/**/*.svx` is discovered automatically.", ""].join("\n");
    writeFileSync(join(launched.row.cwd, ".brain/index.svx"), index + (edited ? "private edited note" : ""));
    const result = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(existsSync(launched.row.cwd)).toBe(edited);
    expect(result.cloneError === null).toBe(!edited);
  });
  // flowing-pi, 2026-10-13: every landed remote clone was kept for pi-notes' own runtime files.
  it("removes a landed remote clone whose only dirt is pi-notes' runtime state", async () => {
    const { s, launched } = await launchedFork();
    const root = join(launched.row.cwd, ".pi/notes-bridge"); mkdirSync(root, { recursive: true });
    for (const file of ["events.jsonl", "session.json", "status.json"]) writeFileSync(join(root, file), `runtime ${file}`);
    const result = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(result.cloneError).toBeNull(); expect(existsSync(launched.row.cwd)).toBe(false);
  });
  it("keeps unknown remote pi-notes bridge files rather than declaring the whole directory disposable", async () => {
    const { s, launched } = await launchedFork();
    const root = join(launched.row.cwd, ".pi/notes-bridge"); mkdirSync(root, { recursive: true }); writeFileSync(join(root, "edited-review.json"), "private note");
    const result = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(result.cloneError).toContain(".pi/notes-bridge/edited-review.json"); expect(existsSync(launched.row.cwd)).toBe(true);
  });
  // KITT, 2026-10-12: a walgit lane base resolved on Flagg, but remote1's checkout had only origin.
  it("fetches a named-remote lane base the remote checkout lacks, for clone create and close", async () => {
    const s = setup(); await s.open();
    const bare = join(s.h.root, "walgit.git"); sh(s.h.root, "init", "-q", "--bare", bare);
    sh(s.dir, "remote", "add", "walgit", bare);
    sh(s.dir, "checkout", "-q", "-b", "central/cache");
    writeFileSync(join(s.dir, "cache.txt"), "cache\n"); sh(s.dir, "add", "cache.txt"); sh(s.dir, "commit", "-q", "-m", "cache");
    const tip = sh(s.dir, "rev-parse", "HEAD").trim();
    sh(s.dir, "push", "-q", "walgit", "central/cache"); sh(s.dir, "fetch", "-q", "walgit"); sh(s.dir, "checkout", "-q", "main");
    const mirror = join(s.h.root, "remote-source"); sh(s.h.root, "clone", "-q", s.dir, mirror); sh(mirror, "remote", "remove", "origin");
    s.setMachines({ remote: config({ workerWorktree: s.h.workerWorktree, env: { CUDA_VISIBLE_DEVICES: "", MUSTER_FLEET_COMPUTE: "off", HOME: s.h.home }, wrap: ["/wrapper", "--name", "{name}", "--"], paths: { [s.dir]: mirror } }) });
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, lanes: p.lanes.map(lane => lane.slug === "work" ? { ...lane, base: "walgit/central/cache" } : lane) }, undefined] as const)));
    const launched = await s.launch();
    expect(launched.row.clone?.base).toEqual({ ref: "walgit/central/cache", sha: tip });
    expect(launched.notes.join("\n")).toContain(`base walgit/central/cache fetched from ${bare}; this checkout has no walgit remote`);
    expect(sh(mirror, "remote").trim()).toBe("");
    const closed = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(closed.cloneError).toBeNull(); expect(existsSync(launched.row.cwd)).toBe(false);
  });

  // drovr, 2026-10-12: "lane tab is full" came after the clone existed, so every retry failed on "already exists".
  it("refuses a full lane tab before allocating a clone", async () => {
    const s = setup(); await s.open();
    for (const name of ["w1", "w2", "w3", "w4"]) await s.launch(name);
    await expect(s.launch("w5")).rejects.toThrow(/already has 4 worker panes \(w1, w2, w3, w4\).*nothing was allocated.*Next: agent_close/);
    expect(existsSync(join(s.h.root, "clones", "w5"))).toBe(false);
  });
  // pi-tui-research, 2026-10-13: a bundle-seeded source has no origin, so set-url failed after the clone existed.
  it("adds origin to a remote clone whose source checkout has none", async () => {
    const s = setup(); await s.open();
    // worker-worktree.sh copies the source's remotes; with none, the clone has no origin either.
    writeFileSync(s.h.workerWorktree, readFileSync(s.h.workerWorktree, "utf8").replace(/(git clone -q "\$2" "\$target")/, '$1 && git -C "$target" remote remove origin'));
    const launched = await s.launch("no-origin");
    expect(spawnSync("git", ["-C", launched.row.cwd, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout.trim()).toBe(s.dir);
  });
  // Barnum and KITT, 2026-10-20: under load a remote launch was recorded failed while its Pi was starting.
  it("finds a remote session file Herdr has not detected yet, from the remote sessions dir", async () => {
    const s = setup(); await s.open();
    s.remote.startSessions = false;
    s.setBefore((command, args) => {
      if (command !== "ssh" || !args.at(-1)?.includes("muster launch log") || !s.remote.launcherScripts.length) return undefined;
      const script = s.remote.launcherScripts.at(-1)!;
      const id = /'--session-id' '([^']+)'/.exec(script)?.[1] ?? /--session-id ([^ ]+)/.exec(script)?.[1];
      const cwd = /^cd '([^']*)'/m.exec(script)![1]!;
      const dir = sessionDirFor(cwd, s.h.home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `2026-10-20T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: "session", id, cwd })}\n`);
      return undefined;
    });
    const launched = await s.launch("offpane");
    expect(launched.row.state).toBe("running");
    expect(launched.row.sessionFile).toMatch(/_offpane-.*\.jsonl$/);
  });
  it("leaves a remote launch whose pane hosts a starting Pi launching, never failed", async () => {
    const s = setup(); await s.open();
    s.remote.startSessions = false;
    const launched = await s.launch("slow");
    expect(launched.row.state).toBe("launching");
    expect(launched.row.pane).not.toBeNull();
    expect(launched.notes.join("\n")).toMatch(/slow start: Pi still starting in .*row left launching.*"action":"adopt","name":"slow"/s);
  });
  it("refuses to reuse a clone while the earlier attempt's Pi still runs in it", async () => {
    const s = setup(); await s.open();
    const first = await s.launch("twice");
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === "twice" ? { ...row, state: "failed" as const } : row) }, undefined] as const)));
    await expect(s.launch("twice")).rejects.toThrow(`its earlier attempt is still running in pane ${first.row.pane!.paneId}`);
  });
  it("the owner pass leaves a launching row alone when its job died but its pane hosts a Pi", async () => {
    const s = setup(); await s.open();
    s.remote.startSessions = false;
    const launched = await s.launch("orphan");
    const dead = spawnSync("true").pid!;
    const id = "0badc0de-0000-4000-8000-000000000001";
    mkdirSync(join(s.h.home, ".local/state/muster/launches"), { recursive: true });
    writeFileSync(join(s.h.home, ".local/state/muster/launches", `${id}.json`), JSON.stringify({ id, project: "probe", name: "orphan", sessionId: launched.row.sessionId, pid: dead,
      log: join(s.h.home, "job.log"), startedAt: new Date(s.h.now.getTime() - 60_000).toISOString(), state: "running", priorState: "planned", owner: s.h.sessionId,
      request: { action: "launch", machine: "remote", name: "orphan", role: "worker", lane: "work", label: "remote worker", clone: true, noSkills: true } }));
    const board = await s.run(projectStatus(s.dir, { act: true }));
    expect(JSON.stringify(board)).toContain(`pane ${launched.row.pane!.paneId} hosts a Pi; adopt it`);
    expect((await s.run(load(s.dir))).agents.find(row => row.name === "orphan")!.state).toBe("launching");
    // The job is closed as an action, so the next pass reaches the row's status instead of the dead job again.
    expect(JSON.parse(readFileSync(join(s.h.home, ".local/state/muster/launches", `${id}.json`), "utf8")).outcome).toBe("action");
    expect((await s.run(projectStatus(s.dir, { act: true }))).agents.find(line => line.name === "orphan")?.action ?? "").not.toContain(`launch job ${id}`);
  });
  it("the owner pass leaves a dead job's row alone when Herdr cannot be asked", async () => {
    const s = setup(); await s.open();
    s.remote.startSessions = false;
    const launched = await s.launch("unknown");
    const id = "0badc0de-0000-4000-8000-000000000002";
    mkdirSync(join(s.h.home, ".local/state/muster/launches"), { recursive: true });
    writeFileSync(join(s.h.home, ".local/state/muster/launches", `${id}.json`), JSON.stringify({ id, project: "probe", name: "unknown", sessionId: launched.row.sessionId, pid: spawnSync("true").pid!,
      log: join(s.h.home, "job.log"), startedAt: new Date(s.h.now.getTime() - 60_000).toISOString(), state: "running", priorState: "planned", owner: s.h.sessionId,
      request: { action: "launch", machine: "remote", name: "unknown", role: "worker", lane: "work", label: "remote worker", clone: true, noSkills: true } }));
    s.setMachines({});
    const board = await s.run(projectStatus(s.dir, { act: true }));
    expect(JSON.stringify(board)).toContain("could not say whether pane");
    expect((await s.run(load(s.dir))).agents.find(row => row.name === "unknown")!.state).toBe("launching");
  });
  it("a relaunch does not take the earlier attempt's session file as proof the new Pi started", async () => {
    const s = setup(); await s.open();
    const first = await s.launch("again");
    expect(first.row.sessionFile).not.toBeNull();
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === "again" ? { ...row, state: "failed" as const, pane: null } : row) }, undefined] as const)));
    s.remote.panes.delete(first.row.pane!.paneId);
    s.remote.startSessions = false;
    const second = await s.launch("again");
    expect(second.row.state).toBe("launching");
    expect(second.notes.join("\n")).toContain("slow start: Pi still starting");
  });
  it("a relaunch whose baseline listing failed ignores session files for that wait", async () => {
    const s = setup(); await s.open();
    const first = await s.launch("blind");
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === "blind" ? { ...row, state: "failed" as const, pane: null } : row) }, undefined] as const)));
    s.remote.panes.delete(first.row.pane!.paneId);
    s.remote.startSessions = false;
    let looks = 0;
    const original = s.proc.run;
    vi.spyOn(s.proc, "run").mockImplementation((command, args, options) => {
      if (command === "ssh" && args.at(-1)?.includes("muster launch log") && looks++ === 0) return Effect.succeed({ code: 255, stdout: "", stderr: "connection reset" });
      return original(command, args, options);
    });
    const second = await s.launch("blind");
    expect(looks).toBeGreaterThan(1);
    expect(second.row.state).toBe("launching");
  });
  it("a queued launch that errors after its Pi started is not recorded failed", async () => {
    const s = setup(); await s.open();
    const first = await s.launch("jobbed");
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === "jobbed" ? { ...row, state: "launching" as const, pane: null, sessionId: "jobbed-20261020T000000" } : row) }, undefined] as const)));
    s.remote.panes.delete(first.row.pane!.paneId);
    const id = "0badc0de-0000-4000-8000-000000000003";
    mkdirSync(join(s.h.home, ".local/state/muster/launches"), { recursive: true });
    writeFileSync(join(s.h.home, ".local/state/muster/launches", `${id}.json`), JSON.stringify({ id, project: "probe", name: "jobbed", sessionId: "jobbed-20261020T000000", pid: process.pid,
      log: join(s.h.home, "jobbed.log"), startedAt: s.h.now.toISOString(), state: "queued", priorState: "failed", owner: s.h.sessionId,
      request: { action: "launch", machine: "remote", name: "jobbed", role: "worker", lane: "work", label: "remote worker", clone: true, noSkills: true } }));
    const handle = s.remote.handle.bind(s.remote);
    vi.spyOn(s.remote, "handle").mockImplementation((method, params) => {
      if (method === "pane.rename") throw new HerdrApiError({ operation: method, code: "internal", message: "rename refused" });
      return handle(method, params);
    });
    const result = await s.run(runLaunchJob(s.dir, id));
    expect(result.kind).toBe("blocked");
    const row = (await s.run(load(s.dir))).agents.find(row => row.name === "jobbed")!;
    expect(row.state).not.toBe("failed");
  });
  it("relaunching a failed row reuses its earlier clone", async () => {
    const s = setup(); await s.open();
    const first = await s.launch("retry");
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === "retry" ? { ...row, state: "failed" as const, pane: null } : row) }, undefined] as const)));
    s.remote.panes.delete(first.row.pane!.paneId);
    const again = await s.launch("retry");
    expect(again.row.cwd).toBe(first.row.cwd); expect(again.row.clone).toEqual(first.row.clone);
    expect(again.notes.join("\n")).toContain(`reused clone ${first.row.cwd} from retry's earlier attempt`);
  });

  it("saves remote logs, closes the bound pane and removes the clone through SSH", async () => {
    const { s, launched } = await launchedFork();
    const result = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(result.row.state).toBe("closed"); expect(result.notes.join(" ")).toContain("pane log saved");
    expect(s.remote.panes.has(launched.row.pane!.paneId)).toBe(false); expect(existsSync(launched.row.cwd)).toBe(false);
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("'remove'"))).toBe(true);
  });

  describe("owner note outbox", () => {
    const leaseMismatch = { status: "failed" as const, detail: "NOT DELIVERED: LeaseMismatch: Rejected LeaseMismatch (409) (ratking; no fallback)" };
    const failing = (delivery: { status: "failed"; detail: string } = leaseMismatch) => ({ postOwner: () => Effect.succeed(delivery) }) as unknown as import("./runtime.ts").CommsShape;
    const post = (s: ReturnType<typeof setup>, launched: Awaited<ReturnType<ReturnType<typeof setup>["launch"]>>, comms: import("./runtime.ts").CommsShape | undefined, kind: "question" | "progress" = "question") =>
      s.run(deliverOwnerItem({ owner: launched.row.owner, agent: launched.row.name, home: join(s.h.root, "remote-home"), session: launched.row.sessionId, project: "probe", item: { author: launched.row.sessionId, lane: launched.row.lane, kind, title: "Need owner eyes", body: "Full note" }, comms, send: () => Effect.succeed(leaseMismatch) }));
    const remoteEnv = (launched: Awaited<ReturnType<ReturnType<typeof setup>["launch"]>>) => { vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_AGENT", launched.row.name); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe"); };

    it("a remote worker's failed send is saved as a sidecar the owner pass ingests once, with a wake and a board note", async () => {
      const s = setup(); await s.open(); const launched = await s.launch(); remoteEnv(launched);
      const posted = await post(s, launched, failing());
      expect(posted.lost).toBe(false); expect(posted.stored).toBe("sidecar"); expect(posted.failureCode).toBe("LeaseMismatch");
      const notes = join(sidecarRoots(launched.row.cwd)[0]!, "notes");
      expect(readdirSync(notes)).toEqual([`${posted.uri.split("/").at(-1)}.json`]);
      expect(readOwnerQueue(launched.row.owner, s.h.home).items).toHaveLength(0);
      const first = await s.run(ingestRemotePackets(s.dir));
      expect(first.notes.join("\n")).toContain(`owner note from ${launched.row.name} arrived by sidecar (Rat King send had failed: LeaseMismatch)`);
      expect(readOwnerQueue(launched.row.owner, s.h.home).items.map(r => r.item.uri)).toEqual([posted.uri]);
      const second = await s.run(ingestRemotePackets(s.dir));
      expect(second.notes).toEqual([]); expect(readOwnerQueue(launched.row.owner, s.h.home).items).toHaveLength(1);
      const wake = vi.fn(); const feed = ownerFeed({ session: launched.row.owner, home: s.h.home, appendEntry: vi.fn(), sendMessage: wake });
      expect(feed.flush()).toBe(1); expect(wake).toHaveBeenCalledTimes(1); feed.dispose();
    });
    // drovr, 2026-10-12: sidecars stay on disk and the queue is per owner session, so an owner restart replayed a 10-11 note.
    it("does not replay a note to an owner that restarted after taking it", async () => {
      const s = setup(); await s.open(); const launched = await s.launch(); remoteEnv(launched);
      const posted = await post(s, launched, failing());
      await s.run(ingestRemotePackets(s.dir));
      const before = launched.row.owner;
      await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: [...p.agents.map(row => row.name === launched.row.name ? { ...row, owner: "owner-2" } : row),
        { ...launched.row, name: "owner-desk", machine: "local", pane: null, sessionId: "owner-2", events: [{ type: "RESTARTED", at: "2026-10-12T17:00:00.000Z", detail: `${before} -> owner-2 onto abc` }] }] }, undefined] as const)));
      expect((await s.run(ingestRemotePackets(s.dir))).notes).toEqual([]);
      expect(readOwnerQueue("owner-2", s.h.home).items).toHaveLength(0);
      expect(readOwnerQueue(before, s.h.home).items.map(record => record.item.uri)).toEqual([posted.uri]);
    });
    it("accepts a note written under the worker's own earlier session", async () => {
      const s = setup(); await s.open(); const launched = await s.launch(); remoteEnv(launched);
      const posted = await post(s, launched, failing());
      await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => row.name === launched.row.name
        ? { ...row, sessionId: "worker-2", events: [...(row.events ?? []), { type: "RESTARTED", at: "2026-10-12T17:00:00.000Z", detail: `${launched.row.sessionId} -> worker-2 onto abc` }] } : row) }, undefined] as const)));
      const result = await s.run(ingestRemotePackets(s.dir));
      expect(result.notes.join("\n")).not.toContain("invalid note sidecar identity");
      expect(readOwnerQueue(launched.row.owner, s.h.home).items.map(record => record.item.uri)).toEqual([posted.uri]);
    });
    it("does not duplicate when the Rat King send was delivered after all", async () => {
      const s = setup(); await s.open(); const launched = await s.launch(); remoteEnv(launched);
      const posted = await post(s, launched, failing());
      const { ingestOwnerItem } = await import("./owner-queue.ts");
      const item = JSON.parse(readFileSync(join(sidecarRoots(launched.row.cwd)[0]!, "notes", `${posted.uri.split("/").at(-1)}.json`), "utf8")).item;
      expect(ingestOwnerItem(launched.row.owner, item, s.h.home)).toBe(true);
      const result = await s.run(ingestRemotePackets(s.dir));
      expect(result.notes).toEqual([]);
      expect(readOwnerQueue(launched.row.owner, s.h.home).items).toHaveLength(1);
      const wake = vi.fn(); const feed = ownerFeed({ session: launched.row.owner, home: s.h.home, appendEntry: vi.fn(), sendMessage: wake });
      expect(feed.flush()).toBe(1); expect(wake).toHaveBeenCalledTimes(1); feed.dispose();
    });
    it("a local worker's failed send persists into the local owner queue", async () => {
      const s = setup(); await s.open(); const launched = await s.launch();
      const posted = await post(s, launched, failing());
      expect(posted.lost).toBe(false); expect(posted.stored).toBe("local-queue");
      expect(readOwnerQueue(launched.row.owner, join(s.h.root, "remote-home")).items.map(r => r.item.uri)).toEqual([posted.uri]);
    });
    it("a failure that cannot be stored stays lost", async () => {
      const s = setup(); await s.open(); const launched = await s.launch(); remoteEnv(launched);
      vi.stubEnv("MUSTER_REMOTE_ROW", "");
      const posted = await post(s, launched, failing());
      expect(posted.lost).toBe(true); expect(posted.stored).toBeUndefined();
    });
    it("a delivered send writes no sidecar", async () => {
      const s = setup(); await s.open(); const launched = await s.launch(); remoteEnv(launched);
      const posted = await post(s, launched, fakeRatking(s.h.home, () => "probe/remote-w", [], () => [decodeProject(JSON.parse(readFileSync(projectPath(s.dir), "utf8")))]).service);
      expect(posted.lost).toBe(false); expect(posted.stored).toBeUndefined();
      expect(existsSync(join(sidecarRoots(launched.row.cwd)[0]!, "notes"))).toBe(false);
    });
  });
});

it("lists a row's sessions newest first from its restart and foreign-adopt events", () => {
  expect(sessionChain({ sessionId: "c", events: [
    { type: "RESTARTED", at: "1", detail: "a -> b onto 123" }, { type: "LAUNCHED", at: "2", detail: "x -> y" },
    { type: "ADOPT_FOREIGN", at: "3", detail: "b -> c: Joel: desk now" },
  ] })).toEqual(["c", "b", "a"]);
  expect(sessionChain({ sessionId: "only" })).toEqual(["only"]);
});

// Zeno, 2026-10-12: git's "fatal: not a git repository" was painted over desk TUIs on every owner pass.
it("resolves sidecar roots outside git silently, locally and in the remote probe script", () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "muster-nogit-")));
  try {
    expect(sidecarRoots(plain)).toEqual([join(plain, ".pi/muster")]);
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `${sidecarRootsScript}\nprocess.stdout.write(JSON.stringify(sidecarRoots(process.argv[1])));`, plain], { cwd: plain, encoding: "utf8" });
    expect(probe.stderr).toBe("");
    expect(JSON.parse(probe.stdout)).toEqual([join(plain, ".pi/muster")]);
  } finally { rmSync(plain, { recursive: true, force: true }); }
});
