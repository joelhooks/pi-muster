import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: (...args: unknown[]) => {
    spawned.calls.push(args);
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  },
}));
import { agentLaunch as launch, agentLaunchForeground, laneOpen, launchResultText, projectOpen, projectStatus, runLaunchJob } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { ownerPath, readOwnerQueue } from "./owner-queue.ts";
const readOwnerItems = (path: string) => { const match = path.match(/^(.*)\/\.local\/state\/muster\/owner-queue\/([^/]+)\.jsonl$/); if (!match) throw new Error("invalid test queue path"); return readOwnerQueue(match[2]!, match[1]!).items.map(entry => entry.item); };
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
beforeEach(() => spawned.calls.splice(0));

describe("asynchronous launch admission", () => {
  it("returns under one second without entering a slow model/process/pane path", async () => {
    const { h, dir, request } = await setup();
    h.proc = { run: () => Effect.promise(() => new Promise(() => {})) };
    const before = h.herdr.calls.length;
    const start = performance.now();
    const result = await runWith(h, agentLaunch(dir, request));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.row.state).toBe("launching");
    expect(result.row.launchJob).toMatchObject({ id: result.jobId, pid: process.pid, owner: h.sessionId });
    expect(result.proof).toBeNull();
    expect(h.herdr.calls).toHaveLength(before);
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0]?.[2]).toMatchObject({ detached: true });
    expect((await runWith(h, load(dir))).agents[0]?.launchJob?.id).toBe(result.jobId);
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
    const items = readOwnerItems(ownerPath(h.sessionId, h.home));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "action", body: result.body });
    expect(result.body).toContain("delivery: proven");
    expect(result.body).toContain("argv: pi");
    await failWith(h, runLaunchJob(dir, receipt.jobId!));
    expect(readOwnerItems(ownerPath(h.sessionId, h.home))).toHaveLength(1);
  });

  it("fails the row and posts a blocked item containing the log tail", async () => {
    const { h, dir, request } = await setup();
    const receipt = await runWith(h, agentLaunch(dir, request));
    writeFileSync(receipt.log!, "slow path diagnostic\n");
    h.herdr.startErrors = ["broken startup"];
    const result = await runWith(h, runLaunchJob(dir, receipt.jobId!));
    expect(result.kind).toBe("blocked");
    expect((await runWith(h, load(dir))).agents[0]?.state).toBe("failed");
    expect(readOwnerItems(ownerPath(h.sessionId, h.home))).toMatchObject([{ kind: "blocked", body: expect.stringContaining("slow path diagnostic") }]);
  });

  it("recovers a dead pid through project_status without re-spawning", async () => {
    const { h, dir, request } = await setup();
    const receipt = await runWith(h, agentLaunch(dir, request));
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, launchJob: { ...row.launchJob!, pid: 2147483647 } })) }, null] as const)));
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
    expect(readOwnerItems(ownerPath(h.sessionId, h.home))).toHaveLength(2);
  });

  it("keeps the original foreground rendering byte-identical", async () => {
    const { h, dir, request } = await setup();
    const result = await runWith(h, agentLaunchForeground(dir, request));
    const renderer = readFileSync(new URL("./extension-main.ts", import.meta.url), "utf8");
    expect(renderer).toContain("return launchResultText(result);");
    expect(launchResultText(result)).toContain("delivery: proven");
  });
});
