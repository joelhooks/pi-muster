import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync, utimesSync, statSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMachines, decodeProject, type MachineConfig } from "./domain.ts";
import { remotePullReceipt, sidecarRoots, mapPath, mapWorkerPath, machinesPath, machineConfig, sshProc, remoteClient, prerequisites, withMachineLaunchLock, readyForRemoteLaunch, syncRemoteBrief, cleanupRemoteBrief } from "./remote.ts";
import { Comms, Herdr, MusterEnv, Proc, liveProc, noEmitPaneClose, type EnvShape, type ProcShape } from "./runtime.ts";
import { agentLaunchForeground as agentLaunch, agentLaunch as queuedAgentLaunch, agentClose, packetReport, packetVerify, packetLand, projectOpen, laneOpen, projectStatus, ingestRemotePackets, pullRemoteOwnerInbox } from "./ops.ts";
import { FakeHerdr, harness, makeRepo, sh } from "./test-support.ts";
import { load, mutate, projectPath } from "./store.ts";
import { ProcError } from "./errors.ts";
import { agentRewind } from "./rewind.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendOwnerItem, deliverOwnerItem, forwardOwner, ownerPath, readOwnerQueue, wakeKind } from "./owner-queue.ts";
import { ownerFeed } from "./owner-feed.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";

const config = (patch: Partial<MachineConfig> = {}): MachineConfig => decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/remote/muster", workerWorktree: "/remote/worker-worktree.sh", env: { CUDA_VISIBLE_DEVICES: "", MUSTER_FLEET_COMPUTE: "off" }, wrap: [], ...patch } }).remote!;
beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", ""); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function setup() {
  const h = harness();
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs?: number }> = [];
  const remote = new FakeHerdr(h.home);
  let missing = false;
  const base = h.proc;
  const proc: ProcShape = { run: (command, args, options) => {
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
  } };
  let machines: unknown = { remote: config({ workerWorktree: h.workerWorktree, env: { CUDA_VISIBLE_DEVICES: "", MUSTER_FLEET_COMPUTE: "off", HOME: h.home }, wrap: ["/wrapper", "--name", "{name}", "--"] }) };
  const env: EnvShape = { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: h.workerWorktree,
    createId: () => "remote-id", sleep: ms => Effect.sync(() => { h.now = new Date(h.now.getTime() + ms); }), emitPaneClose: noEmitPaneClose,
    get machines() { return machines; }, remoteHerdr: () => Effect.succeed(remote.client()) };
  const run = <A, E>(effect: Effect.Effect<A, E, Herdr | MusterEnv | Proc | Comms>) => Effect.runPromise(effect.pipe(Effect.provideService(MusterEnv, env), Effect.provideService(Proc, proc), Effect.provide(h.layer)));
  const dir = makeRepo(join(h.root, "source"));
  const open = async () => {
    await run(projectOpen({ dir, slug: "probe", outcome: "remote lanes", reviewTrigger: "weekly", nextAction: "launch", criticalPath: [], space: "w1", sidebar: false, ephemeral: true, cadenceMinutes: 15, musterExtension: "/muster", deskExtension: null }));
    await run(laneOpen(dir, { slug: "work", label: "remote work", goal: "packet", repo: dir }));
  };
  const launch = (name = "remote-w") => run(agentLaunch(dir, { action: "launch", machine: "remote", name, role: "worker", lane: "work", label: "remote worker", clone: true, noSkills: true }));
  return { h, remote, dir, calls, env, proc, run, open, launch, setMissing: () => { missing = true; }, setMachines: (value: unknown) => { machines = Object.fromEntries(Object.entries(value as Record<string, MachineConfig>).map(([name, machine]) => [name, { ...machine, env: { ...machine.env, HOME: h.home } }])); } };
}

describe("machine boundary", () => {
  it("maps only path prefixes, longest first, and decodes defaults", () => {
    const machine = config({ paths: { "/local": "/remote", "/local/specific": "/special" } });
    expect(mapPath("/local/specific/repo", machine)).toBe("/special/repo");
    expect(mapPath("/locality/repo", machine)).toBe("/locality/repo");
    expect(machine.socket).toBe("/home/joel/.config/herdr/herdr.sock");
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
  it("creates a socket forward only when its master is absent", async () => {
    const s = setup();
    const capture: string[][] = [];
    const proc: ProcShape = { run: (_command, args) => { capture.push([...args]); return Effect.succeed({ code: args.includes("check") ? 1 : 0, stdout: "", stderr: "" }); } };
    const client = await Effect.runPromise(remoteClient("remote", config()).pipe(Effect.provideService(MusterEnv, { ...s.env, remoteHerdr: undefined }), Effect.provideService(Proc, proc)));
    expect(client.socketPath()).toContain(".config/muster/fwd");
    expect(capture[1]).toContain("ExitOnForwardFailure=yes");
    expect(capture[1]).toContain("-L");
    // A master that idled out leaves its forwarded socket behind; the next bind must replace it.
    expect(capture[1]).toContain("StreamLocalBindUnlink=yes");
  });
});

describe("remote launch hygiene", () => {
  it("explains pull delivery only for non-network policy", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const receipt = "remote notes reach the owner only when it runs owner_inbox or project_status; set policy comms network for push";
    expect(launched.notes).toContain(receipt);
    expect(remotePullReceipt("intercom")).toEqual([receipt]);
    expect(remotePullReceipt(undefined)).toEqual([receipt]);
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
  it.each(["planned", "failed", "interrupted"] as const)("clearly refuses explicit cross-machine relaunch of a %s row without reusing a lock", async state => {
    const s = setup(); await s.open(); const launched = await s.launch();
    await s.run(mutate(s.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, state, sessionFile: null })) }, undefined] as const)));
    s.calls.length = 0;
    for (const launch of [agentLaunch, queuedAgentLaunch]) await expect(s.run(launch(s.dir, { action: "launch", machine: "local", name: launched.row.name, clone: true }))).rejects.toThrow("explicit machine local differs");
    expect(s.calls).toEqual([]); expect((await s.run(load(s.dir))).agents[0]?.machine).toBe("remote");
  });
});

describe("remote owner operations", () => {
  it.each([false, true])("owner_inbox pulls before reading and tolerates an offline host (%s)", async offline => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const item = appendOwnerItem(launched.row.owner, { author: launched.row.sessionId, lane: "work", kind: "progress", title: "Remote-only note" }, join(s.h.root, "remote-home"));
    const root = join(sidecarRoots(launched.row.cwd)[0]!, "notes"); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${"a".repeat(64)}.json`), JSON.stringify({ project: "probe", machine: "remote", agent: launched.row.name, lane: "work", owner: launched.row.owner, item }));
    appendOwnerItem(launched.row.owner, { author: "local-worker", kind: "progress", title: "Local note" }, s.h.home);
    if (offline) vi.spyOn(s.proc, "run").mockImplementation(() => Effect.fail(new ProcError({ command: "ssh", code: 255, stderr: "offline", message: "offline\nnow" })));
    const tools = new Map<string, any>();
    const stop = registerOwnerFeed({ on: vi.fn(), registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer: vi.fn(), sendMessage: vi.fn(), appendEntry: vi.fn() } as never,
      { HOME: s.h.home }, { pull: () => s.run(pullRemoteOwnerInbox(s.dir)), consume: async () => {} });
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
  it.each(["question", "blocked", "action", "progress"] as const)("pulls a remote %s note once and preserves local wake semantics", async kind => {
    const s = setup(); await s.open(); const launched = await s.launch();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    const send = vi.fn(() => Effect.succeed({ status: "failed" as const, detail: "no reverse intercom" }));
    const posted = await s.run(deliverOwnerItem({ owner: launched.row.owner, home: join(s.h.root, "remote-home"), session: launched.row.sessionId, project: "probe", item: { author: launched.row.sessionId, lane: launched.row.lane, kind, title: "Need owner eyes", body: "Full note", refs: ["source"] }, send }));
    expect(send).toHaveBeenCalledTimes(wakeKind(kind) ? 1 : 0); expect(posted.pendingPull).toBe(true);
    expect(posted.delivery).toMatchObject({ status: "queued", detail: expect.stringContaining("not delivered") });
    const root = join(sidecarRoots(launched.row.cwd)[0]!, "notes");
    expect(sh(launched.row.cwd, "status", "--porcelain").trim()).toBe("");
    expect(readdirSync(root)).toHaveLength(1); expect(readdirSync(root)[0]).toMatch(/\.json$/);
    const sidecar = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!), "utf8"));
    expect(sidecar).toMatchObject({ project: "probe", machine: "remote", agent: launched.row.name, lane: launched.row.lane, owner: launched.row.owner, item: { uri: posted.uri, kind } });
    expect(readOwnerQueue(launched.row.owner, s.h.home).items).toHaveLength(0);
    s.calls.length = 0;
    expect((await s.run(ingestRemotePackets(s.dir))).notes).toEqual([]);
    expect(s.calls.filter(call => call.command === "ssh")).toHaveLength(1);
    expect(readOwnerQueue(launched.row.owner, s.h.home).items.map(record => record.item)).toEqual([sidecar.item]);
    const before = readFileSync(ownerPath(launched.row.owner, s.h.home), "utf8");
    await s.run(ingestRemotePackets(s.dir));
    expect(readFileSync(ownerPath(launched.row.owner, s.h.home), "utf8")).toBe(before);
    expect(readOwnerQueue(launched.row.owner, s.h.home).items).toHaveLength(1);
    const wake = vi.fn();
    const feed = ownerFeed({ session: launched.row.owner, home: s.h.home, appendEntry: vi.fn(), sendMessage: wake });
    expect(feed.flush()).toBe(wakeKind(kind) ? 1 : 0); expect(wake).toHaveBeenCalledTimes(wakeKind(kind) ? 1 : 0);
    expect(feed.flush()).toBe(0); feed.dispose();
  });
  it("uses the catalog owner when the sidecar names another owner", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const item = appendOwnerItem(launched.row.owner, { author: launched.row.sessionId, lane: launched.row.lane, kind: "question", title: "Question" }, join(s.h.root, "remote-home"));
    const root = join(launched.row.cwd, ".pi/muster/notes"); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${"a".repeat(64)}.json`), JSON.stringify({ project: "probe", machine: "remote", agent: launched.row.name, lane: launched.row.lane, owner: "another-owner", item }));
    expect((await s.run(ingestRemotePackets(s.dir))).notes).toEqual([]);
    expect(readOwnerQueue(launched.row.owner, s.h.home).items.map(record => record.item)).toEqual([item]);
    expect(readOwnerQueue("another-owner", s.h.home).items).toHaveLength(0);
  });
  it.each(["project", "machine", "agent", "lane", "author"])("skips a note with mismatched %s and still pulls valid notes", async field => {
    const s = setup(); await s.open(); const launched = await s.launch();
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
  it("pulls replies with thread references, forwards mentions, and leaves old queues intact", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const remoteHome = join(s.h.root, "remote-home");
    const parent = appendOwnerItem(launched.row.sessionId, { author: launched.row.owner, kind: "fyi", title: "Owner answer" }, remoteHome);
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(deliverOwnerItem({ owner: parent.author, home: remoteHome, session: launched.row.sessionId, project: "probe", item: { author: launched.row.sessionId, lane: launched.row.lane, kind: "fyi", title: "Follow-up", replyTo: parent.uri, mention: parent.author }, send: () => Effect.succeed({ status: "failed" }) }));
    const old = appendOwnerItem(launched.row.owner, { author: launched.row.sessionId, project: "probe", kind: "progress", title: "Old queue" }, s.h.home);
    const before = readFileSync(ownerPath(launched.row.owner, s.h.home), "utf8");
    forwardOwner({ from: launched.row.owner, to: "replacement-owner", project: "probe", home: s.h.home });
    await s.run(ingestRemotePackets(s.dir)); await s.run(ingestRemotePackets(s.dir));
    const queue = readOwnerQueue(launched.row.owner, s.h.home);
    expect(queue.items).toHaveLength(2); expect(queue.items[0]?.item).toEqual(old);
    expect(readFileSync(ownerPath(launched.row.owner, s.h.home), "utf8").startsWith(before)).toBe(true);
    expect(queue.items[1]?.item.reply).toEqual({ root: { uri: parent.uri, cid: parent.cid }, parent: { uri: parent.uri, cid: parent.cid } });
    const wake = vi.fn(); const feed = ownerFeed({ session: "replacement-owner", home: s.h.home, appendEntry: vi.fn(), sendMessage: wake });
    expect(feed.flush()).toBe(1); feed.dispose();
  });
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
    // Live 2026-10-07: /Users/joel/.agents/skills paths are not mapped to pennywise, and every launch failed.
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
  it("reports missing remote prerequisites before allocating anything", async () => {
    const s = setup(); await s.open(); s.setMissing();
    await expect(s.launch()).rejects.toThrow("machine remote: missing prerequisites");
    expect(s.remote.calls).toHaveLength(0);
  });
  it("rebinds moved remote sessions before the next pass can nudge", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const pane = s.remote.panes.get(launched.row.pane!.paneId)!;
    s.remote.panes.delete(pane.pane_id); pane.pane_id = "moved"; s.remote.panes.set("moved", pane);
    const old = new Date(s.h.now.getTime() - 35*60000); utimesSync(launched.row.sessionFile!, old, old);
    const status = await s.run(projectStatus(s.dir));
    expect(status.agents[0]?.pane).toBe("moved"); expect(status.agents[0]?.silentMin).toBeGreaterThanOrEqual(35);
    expect(status.agents[0]?.cost).toBe(null);
    expect(status.agents[0]?.action).toContain("rebound");
    expect(s.remote.calls.some(call => call.method === "pane.send_keys" && call.params.pane_id === "moved")).toBe(false);
    expect(s.calls.filter(call => call.command === "ssh" && call.args.at(-1)?.includes("mtimeMs"))).toHaveLength(1);
    await s.run(projectStatus(s.dir));
    expect(s.remote.calls.some(call => call.method === "pane.send_keys" && call.params.pane_id === "moved")).toBe(true);
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

  it("verifies and records a remote sibling branch", async () => {
    const s = setup(); await s.open(); const launched = await s.launch(); const cwd = launched.row.cwd;
    sh(cwd, "checkout", "-qb", "worker/remote-next", "main");
    writeFileSync(join(cwd, "work.txt"), "packet\n"); sh(cwd, "add", "work.txt"); sh(cwd, "commit", "-qm", "sibling");
    const commit = sh(cwd, "rev-parse", "HEAD").trim();
    vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launched.row)); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    await s.run(packetReport({ dir: "/not-on-remote", agent: launched.row.name, owner: launched.row.owner, cwd, commit, summary: "sibling", checks: [] }).pipe(Effect.provideService(MusterEnv, { ...s.env, sessionId: launched.row.sessionId, home: join(s.h.root, "remote-home") })));
    const verified = await s.run(packetVerify(s.dir, commit));
    expect(verified.checks).toContainEqual({ name: "on lane branch", outcome: "pass", detail: `on sibling branch worker/remote-next (row branch ${launched.row.clone!.branch})` });
    expect(verified.note).toContain("updated clone.branch to worker/remote-next");
    expect(verified.checks).toContainEqual({ name: "clone branch", outcome: "pass", detail: `updated to worker/remote-next (was ${launched.row.clone!.branch})` });
    expect((await s.run(load(s.dir))).agents[0]?.clone?.branch).toBe("worker/remote-next");
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("for-each-ref"))).toBe(true);
  });

  it("ingests sidecars idempotently, verifies and lands a remote branch into the local source", async () => {
    const s = setup(); await s.open(); const launched = await s.launch(); const cwd = launched.row.cwd;
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
  it("rejects a sidecar from a different project without changing the owner catalog", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const id = sh(launched.row.cwd, "rev-parse", "HEAD").trim();
    const root = join(launched.row.cwd, ".pi/muster/packets", id); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "packet.json"), JSON.stringify({ project: "wrong", machine: "remote", packet: { id, kind: "commit", artifact: null, lane: "work", agent: launched.row.name, report: "/report", checks: [], state: "reported", verification: null, landedAs: null, reportedAt: s.h.now.toISOString(), updatedAt: s.h.now.toISOString() }, reportText: "wrong" }));
    const before = readFileSync(projectPath(s.dir), "utf8");
    const result = await s.run(ingestRemotePackets(s.dir));
    expect(result.notes.join("\n")).toContain("invalid packet sidecar identity");
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(before);
  });
  it("keeps local status available and skips remaining machine rows after a transport failure", async () => {
    const s = setup(); await s.open(); await s.launch(); await s.launch("remote-two");
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
    const s = setup(); await s.open(); const launched = await s.launch();
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
    const s = setup(); await s.open(); await s.launch();
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
  it.each(["accepted", "unconsumed", "changed-report", "changed-note"])("retires only accepted unchanged remote sidecars: %s", async kind => {
    const s = setup(); await s.open(); const launched = await s.launch(); const cwd = launched.row.cwd;
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
    if (kind === "changed-note") {
      const root = join(cwd, ".pi/muster/notes"), path = join(root, readdirSync(root)[0]!);
      const note = JSON.parse(readFileSync(path, "utf8")); note.item.body = "edited owner note"; writeFileSync(path, JSON.stringify(note));
    }
    const result = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(existsSync(cwd)).toBe(kind !== "accepted");
    expect(result.cloneError === null).toBe(kind === "accepted");
  });
  it.each([false, true])("retire exact pi-notes scaffolds but preserve edits (%s)", async edited => {
    const s = setup(); await s.open(); const launched = await s.launch();
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
  it("keeps unknown remote pi-notes bridge files rather than declaring the whole directory disposable", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const root = join(launched.row.cwd, ".pi/notes-bridge"); mkdirSync(root, { recursive: true }); writeFileSync(join(root, "edited-review.json"), "private note");
    const result = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(result.cloneError).toContain(".pi/notes-bridge/edited-review.json"); expect(existsSync(launched.row.cwd)).toBe(true);
  });
  it("saves remote logs, closes the bound pane and removes the clone through SSH", async () => {
    const s = setup(); await s.open(); const launched = await s.launch();
    const result = await s.run(agentClose(s.dir, { name: launched.row.name }));
    expect(result.row.state).toBe("closed"); expect(result.notes.join(" ")).toContain("pane log saved");
    expect(s.remote.panes.has(launched.row.pane!.paneId)).toBe(false); expect(existsSync(launched.row.cwd)).toBe(false);
    expect(s.calls.some(call => call.command === "ssh" && call.args.at(-1)?.includes("'remove'"))).toBe(true);
  });
});
