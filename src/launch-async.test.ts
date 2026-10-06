import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: [] as unknown[][], fail: false, observe: undefined as undefined | ((args: unknown[]) => void) }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: (...args: unknown[]) => {
    spawned.calls.push(args);
    spawned.observe?.(args);
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    queueMicrotask(() => spawned.fail ? child.emit("error", new Error("fake spawn refusal")) : child.emit("spawn"));
    return child;
  },
}));
import { agentClose, agentLaunch as launch, agentLaunchForeground, laneOpen, launchResultText, projectOpen, projectStatus, readLaunchJob, runLaunchJob } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { readOwnerQueue, mentions } from "./owner-queue.ts";
const readOwnerItems = (owner: string, home: string) => readOwnerQueue(owner, home).items.map(entry => entry.item);
const agentLaunch = (...args: Parameters<typeof launch>) => launch(...args).pipe(Effect.map(result => { if (!("jobId" in result)) throw new Error("expected asynchronous admission"); return result; }));
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "async", outcome: "launch without waiting", reviewTrigger: "weekly", nextAction: "launch", criticalPath: ["work"], space: "w1", ephemeral: true, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "launch" }));
  const request = { action: "launch" as const, name: "worker", role: "worker" as const, lane: "work", label: "worker", cwd: dir, prompt: "Do the work." };
  return { h, dir, request };
}
beforeEach(() => { spawned.calls.splice(0); spawned.fail = false; spawned.observe = undefined; });

describe("asynchronous launch admission", () => {
  it("returns under one second without entering a slow model/process/pane path", async () => {
    const { h, dir, request } = await setup();
    h.proc = { run: () => Effect.promise(() => new Promise(() => {})) };
    const before = h.herdr.calls.length;
    spawned.observe = () => {
      const catalog = JSON.parse(readFileSync(join(dir, ".brain/data/muster/project.json"), "utf8"));
      expect(catalog.agents[0].state).toBe("launching");
      expect(catalog.agents[0]).not.toHaveProperty("launchJob");
      const args = spawned.calls.at(-1)?.[1] as string[];
      expect(readLaunchJob(h.home, args.at(-1)!)).toMatchObject({ state: "queued", pid: null });
    };
    const start = performance.now();
    const result = await runWith(h, agentLaunch(dir, request));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.row.state).toBe("launching");
    expect(result.job).toMatchObject({ id: result.jobId, pid: process.pid, owner: h.sessionId, project: "async", name: "worker", sessionId: result.row.sessionId });
    expect(result.row).not.toHaveProperty("launchJob");
    expect(result.proof).toBeNull();
    expect(h.herdr.calls).toHaveLength(before);
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0]?.[2]).toMatchObject({ detached: true });
    expect(readLaunchJob(h.home, result.jobId).id).toBe(result.jobId);
  });

  it.each([
    { name: "illegal name" }, { role: "invalid" }, { lane: "missing" }, { model: "fable" },
    { thinking: "bogus" }, { machine: "unknown" }, { cwd: "/not/a/cwd" }, { brief: "/not/a/brief" },
  ])("rejects invalid admission before spawning: %j", async patch => {
    const { h, dir, request } = await setup();
    const before = h.herdr.calls.length;
    const error = await failWith(h, agentLaunch(dir, { ...request, ...patch } as typeof request));
    expect(error._tag).toBe("InputError");
    expect(spawned.calls).toHaveLength(0);
    expect(h.herdr.calls).toHaveLength(before);
    expect((await runWith(h, load(dir))).agents).toHaveLength(0);
  });

  it("refuses duplicate names, including another launch in flight", async () => {
    const { h, dir, request } = await setup();
    await runWith(h, agentLaunch(dir, request));
    expect((await failWith(h, agentLaunch(dir, request)))._tag).toBe("InputError");
    expect(spawned.calls).toHaveLength(1);
  });

  it("runs the existing path and posts exactly one waking action with the full result", async () => {
    const { h, dir, request } = await setup();
    const receipt = await runWith(h, agentLaunch(dir, request));
    const result = await runWith(h, runLaunchJob(dir, receipt.jobId!));
    expect(result.kind).toBe("action");
    const row = (await runWith(h, load(dir))).agents[0]!;
    expect(row.state).toBe("running");
    expect(row.delivery).toBe("proven");
    const items = readOwnerItems(h.sessionId, h.home);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("action");
    expect(items[0]?.text.endsWith(result.body)).toBe(true);
    expect(mentions(items[0]!, h.sessionId)).toBe(true);
    expect(result.body).toContain("delivery: proven");
    expect(result.body).toContain("argv: pi");
    await failWith(h, runLaunchJob(dir, receipt.jobId!));
    expect(readOwnerItems(h.sessionId, h.home)).toHaveLength(1);
  });

  it("fails the row and posts a blocked item containing the log tail", async () => {
    const { h, dir, request } = await setup();
    const receipt = await runWith(h, agentLaunch(dir, request));
    writeFileSync(receipt.log!, "slow path diagnostic\n");
    const proc = h.proc;
    h.proc = { run: (command, args, options) => command === "pi" ? Effect.succeed({ code: 0, stdout: "provider model context max-out thinking images\nclaude-bridge claude-opus-5-5 1M 128K yes yes\n", stderr: "" }) : proc.run(command, args, options) };
    const result = await runWith(h, runLaunchJob(dir, receipt.jobId!));
    expect(result.kind).toBe("blocked");
    expect((await runWith(h, load(dir))).agents[0]?.state).toBe("failed");
    expect(readOwnerItems(h.sessionId, h.home)).toMatchObject([{ kind: "blocked", text: expect.stringContaining("slow path diagnostic") }]);
  });

  it("recovers a dead pid through project_status without re-spawning", async () => {
    const { h, dir, request } = await setup();
    const receipt = await runWith(h, agentLaunch(dir, request));
    writeFileSync(join(h.home, ".local/state/muster/launches", `${receipt.jobId}.json`), JSON.stringify({ ...receipt.job, pid: 2147483647 }));
    await runWith(h, projectStatus(dir));
    const row = (await runWith(h, load(dir))).agents[0]!;
    expect(row.state).toBe("failed");
    expect(row.events?.at(-1)?.detail).toContain(receipt.log);
    expect(spawned.calls).toHaveLength(1);
  });

  it("preserves two concurrent reservations and completion patches", async () => {
    const { h, dir, request } = await setup();
    const receipts = await Promise.all(["one", "two"].map(name => runWith(h, agentLaunch(dir, { ...request, name }))));
    expect((await runWith(h, load(dir))).agents.map(row => row.name).sort()).toEqual(["one", "two"]);
    await Promise.all(receipts.map(receipt => runWith(h, runLaunchJob(dir, receipt.jobId!))));
    expect((await runWith(h, load(dir))).agents.map(row => row.state)).toEqual(["running", "running"]);
    expect(readOwnerItems(h.sessionId, h.home)).toHaveLength(2);
  });

  it.each(["fork", "restore"] as const)("admits and completes %s through the same job path", async action => {
    const { h, dir, request } = await setup();
    await runWith(h, agentLaunchForeground(dir, request));
    if (action === "restore") await runWith(h, agentClose(dir, { name: "worker" }));
    const receipt = await runWith(h, agentLaunch(dir, { action, name: action === "fork" ? "child" : "worker", from: "worker" }));
    expect(receipt.row.state).toBe("launching");
    expect(receipt.job.priorState).toBe(action === "fork" ? "planned" : "closed");
    const result = await runWith(h, runLaunchJob(dir, receipt.jobId));
    expect(result.kind).toBe("action");
    expect((await runWith(h, load(dir))).agents.find(row => row.name === receipt.row.name)?.state).toBe("running");
  });

  it("marks a refused spawn failed and returns InputError immediately", async () => {
    const { h, dir, request } = await setup();
    spawned.fail = true;
    expect((await failWith(h, agentLaunch(dir, request)))._tag).toBe("InputError");
    expect((await runWith(h, load(dir))).agents[0]?.state).toBe("failed");
  });

  it("admits clone: true on a lane without its own repo, falling back to the project dir", async () => {
    const { h, dir, request } = await setup();
    const { cwd: _cwd, ...rest } = request;
    const result = await runWith(h, agentLaunch(dir, { ...rest, clone: true }));
    expect(result.jobId).toBeTruthy();
    expect(spawned.calls).toHaveLength(1);
  });

  it("refuses closed lanes before recording or spawning", async () => {
    const { h, dir, request } = await setup();
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, lanes: project.lanes.map(lane => ({ ...lane, state: "closed" as const })) }, null] as const)));
    expect((await failWith(h, agentLaunch(dir, request)))._tag).toBe("InputError");
    expect(spawned.calls).toHaveLength(0);
  });

  it("validates a known remote machine locally and maps its reserved cwd without SSH", async () => {
    const { h, dir, request } = await setup();
    mkdirSync(join(h.home, ".config/muster"), { recursive: true });
    writeFileSync(join(h.home, ".config/muster/machines.json"), JSON.stringify({ remote: { herdr: "remote", ssh: "remote", paths: { [dir]: "/remote/source" }, musterExtension: "/remote/muster", workerWorktree: "/remote/worktree", env: {}, wrap: [] } }));
    h.proc = { run: () => Effect.promise(() => new Promise(() => {})) };
    const receipt = await runWith(h, agentLaunch(dir, { ...request, machine: "remote" }));
    expect(receipt.row).toMatchObject({ machine: "remote", cwd: "/remote/source", state: "launching" });
    expect(spawned.calls).toHaveLength(1);
  });

  it("keeps jobs across a stale-writer catalog rewrite without raising schema 4", async () => {
    const { h, dir, request } = await setup();
    const receipt = await runWith(h, agentLaunch(dir, request));
    const path = join(dir, ".brain/data/muster/project.json");
    const oldWriter = JSON.parse(readFileSync(path, "utf8"));
    expect(oldWriter.writerSchemaVersion).toBeLessThanOrEqual(4);
    expect(oldWriter.agents[0]).not.toHaveProperty("launchJob");
    writeFileSync(path, JSON.stringify(oldWriter));
    expect(readLaunchJob(h.home, receipt.jobId).pid).toBe(process.pid);
    expect((await runWith(h, runLaunchJob(dir, receipt.jobId))).kind).toBe("action");
    expect(readLaunchJob(h.home, receipt.jobId)).toMatchObject({ state: "succeeded", outcome: "action" });
  });

  it("boots the real CLI through its symlink from an unrelated cwd", () => {
    const h = harness();
    const link = join(h.root, "muster-launch");
    symlinkSync(fileURLToPath(new URL("../bin/muster-launch", import.meta.url)), link);
    const result = spawnSync(link, [], { cwd: h.root, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: MUSTER_OWNER=");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
  });

  it("uses the shared foreground renderer for queued output", async () => {
    const { h, dir, request } = await setup();
    const result = await runWith(h, agentLaunchForeground(dir, request));
    const renderer = readFileSync(new URL("./extension-main.ts", import.meta.url), "utf8");
    expect(renderer).toContain("return launchResultText(result);");
    expect(launchResultText(result)).toContain("delivery: proven");
  });
});
