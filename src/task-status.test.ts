import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentState, decodeRemotePacket, type AgentRow } from "./domain.ts";
import { agentLaunchForeground, laneOpen, projectOpen, projectStatus } from "./ops.ts";
import { paneList } from "./herdr.ts";
import { MusterEnv, Proc } from "./runtime.ts";
import { load, mutate, projectPath } from "./store.ts";
import { harness, makeRepo, runWith, sh, type Harness } from "./test-support.ts";
import { appendTaskTraces, deriveTaskStatus, STORED_TASK_STATUS, traceProjectTasks, type TaskFacts, type TaskTrace } from "./task-status.ts";

const empty: TaskFacts = { live: false, commits: false, merged: false, report: false, gate: false, rejected: false };
const homes: Harness[] = [];
beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_PROJECT", ""); });
afterEach(() => { vi.unstubAllEnvs(); for (const h of homes.splice(0)) rmSync(h.root, { recursive: true }); });

async function fixture() {
  const h = harness(); homes.push(h);
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "trace", outcome: "trace facts", reviewTrigger: "weekly", nextAction: "observe", criticalPath: [], space: "w1", sidebar: true, ephemeral: true, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "task", label: "task", goal: "one task" }));
  const brief = join(dir, "brief.md"); writeFileSync(brief, "trace\n");
  const launched = await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "worker", role: "worker", lane: "task", label: "worker", clone: true, brief }));
  const row = launched.row;
  const trace = async () => (await runWith(h, traceProjectTasks(await runWith(h, load(dir)), await runWith(h, paneList())))).traces.get(row.name)!;
  const commit = () => {
    writeFileSync(join(row.cwd, "work.txt"), "work\n"); sh(row.cwd, "add", "work.txt"); sh(row.cwd, "commit", "-qm", "work");
    return sh(row.cwd, "rev-parse", "HEAD").trim();
  };
  return { h, dir, row, trace, commit };
}

function receipt(home: string, tree: string, patch = {}) {
  const root = join(home, ".local/state/muster/gates"); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "gate.json"), JSON.stringify({ runId: "run", host: "pennywise", tree, slot: 0, durationMs: 1, exit: 0, ...patch }));
}

describe("pure task status", () => {
  it.each([
    [empty, "drafted"], [{ ...empty, live: true }, "working"], [{ ...empty, commits: true }, "working"],
    [{ ...empty, report: true }, "drafted"], [{ ...empty, commits: true, report: true }, "reported"],
    [{ ...empty, commits: true, merged: true }, "working"],
    [{ ...empty, commits: true, merged: true, gate: true }, "landed"],
    [{ ...empty, gate: true, merged: true }, "drafted"],
    [{ ...empty, live: true, commits: true, report: true, merged: true, gate: true }, "landed"],
    [{ ...empty, rejected: true }, "rejected"],
    [{ live: true, commits: true, report: true, merged: true, gate: true, rejected: true }, "rejected"],
  ] as const)("derives %s as %s", (facts, expected) => expect(deriveTaskStatus(facts)).toBe(expected));

  it("maps every stored state explicitly", () => {
    expect(Object.keys(STORED_TASK_STATUS).sort()).toEqual([...AgentState.literals].sort());
    expect(STORED_TASK_STATUS).toEqual({ planned: "drafted", launching: "drafted", running: "working", silent: "working", nudged: "working", restarted: "working", reported: "reported", verified: "reported", landed: "landed", interrupted: "working", restoring: "working", failed: "working", closed: null });
  });
});

describe("read-only task tracer", () => {
  it("proves session paths rather than stored pane binding; separates quiet progress", async () => {
    const { h, row, trace, commit } = await fixture();
    expect((await trace()).derived).toBe("working");
    const pane = h.herdr.panes.get(row.pane!.paneId)!;
    pane.agent_session!.value = "/different-session.jsonl";
    expect((await trace()).derived).toBe("drafted");
    pane.agent_session!.value = row.sessionFile!;
    pane.agent_status = "idle";
    expect(await trace()).toMatchObject({ derived: "working", liveness: "quiet" });
    h.herdr.panes.delete(row.pane!.paneId);
    commit();
    expect(await trace()).toMatchObject({ derived: "working", liveness: "quiet", facts: { live: false, commits: true } });
  });

  it("requires a report for the exact head, then an exact passing merged-tree receipt", async () => {
    const { h, dir, row, trace, commit } = await fixture();
    const head = commit();
    const root = join(row.cwd, ".pi/muster/packets", head); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "report.svx"), "report\n");
    expect((await trace()).derived).toBe("reported");
    sh(dir, "fetch", row.cwd, row.clone!.branch);
    sh(dir, "merge", "--no-ff", "-m", "land", "FETCH_HEAD");
    const tree = sh(dir, "rev-parse", "HEAD^{tree}").trim();
    receipt(h.home, "wrong-tree"); expect((await trace()).derived).toBe("reported");
    receipt(h.home, tree, { exit: 1 }); expect((await trace()).derived).toBe("reported");
    receipt(h.home, tree, { exactTree: false }); expect((await trace()).derived).toBe("reported");
    receipt(h.home, tree); expect((await trace()).derived).toBe("landed");
    // An unrelated later commit does not erase proof for the merged tree.
    writeFileSync(join(dir, "later.txt"), "later\n"); sh(dir, "add", "later.txt"); sh(dir, "commit", "-qm", "later");
    expect((await trace()).derived).toBe("landed");
    writeFileSync(join(row.cwd, "next.txt"), "next\n"); sh(row.cwd, "add", "next.txt"); sh(row.cwd, "commit", "-qm", "next");
    expect((await trace()).derived).toBe("working");
  });

  it("decodes packet sidecars, rejects stale identity, and uses only explicit rejection", async () => {
    const { h, dir, row, trace, commit } = await fixture();
    const head = commit();
    const root = join(row.cwd, ".pi/muster/packets", head); mkdirSync(root, { recursive: true });
    const sidecar = decodeRemotePacket({ project: "trace", machine: "local", reportText: "report", packet: {
      id: head, kind: "commit", lane: row.lane, agent: row.name, artifact: null, report: join(root, "missing.svx"), checks: [], state: "reported", verification: null, landedAs: null, reportedAt: h.now.toISOString(), updatedAt: h.now.toISOString(),
    } });
    writeFileSync(join(root, "packet.json"), JSON.stringify(sidecar));
    expect((await trace()).derived).toBe("reported");
    writeFileSync(join(root, "packet.json"), JSON.stringify({ ...sidecar, project: "wrong" }));
    expect(await trace()).toMatchObject({ derived: "?", facts: { gaps: ["packet sidecar identity disagrees"] } });
    await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, packets: [{ ...sidecar.packet, state: "rejected" as const }] }, null] as const)));
    expect((await trace()).derived).toBe("rejected");
  });

  it("falls back to the source branch after clone removal and logs remote gaps", async () => {
    const { h, dir, row, trace, commit } = await fixture();
    commit(); sh(dir, "fetch", row.cwd, `${row.clone!.branch}:${row.clone!.branch}`);
    rmSync(row.cwd, { recursive: true });
    expect((await trace()).derived).toBe("working");
    await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: p.agents.map(a => ({ ...a, machine: "missing" })) }, null] as const)));
    expect(await trace()).toMatchObject({ derived: "?", liveness: "?" });
    const log = readFileSync(join(h.home, ".local/state/muster/task-status-trace.jsonl"), "utf8");
    expect(log).toContain("facts unavailable:");
  });

  it("reads remote facts through existing SSH helpers and the remote pane list", async () => {
    const { h, dir, row, commit } = await fixture();
    const head = commit();
    const root = join(row.cwd, ".pi/muster/packets", head); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "report.svx"), "remote report\n");
    await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: p.agents.map(a => ({ ...a, machine: "remote" })) }, null] as const)));
    const project = await runWith(h, load(dir));
    const remote = await runWith(h, Effect.gen(function* () {
      const env = yield* MusterEnv;
      const proc = yield* Proc;
      return yield* traceProjectTasks(project, []).pipe(
        Effect.provideService(MusterEnv, { ...env, machines: { remote: {
          herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/muster", workerWorktree: h.workerWorktree,
          env: { HOME: h.home }, wrap: [],
        } }, remoteHerdr: () => Effect.succeed(h.herdr.client()) }),
        Effect.provideService(Proc, { run: (command, args, options) => command === "ssh"
          ? proc.run("sh", ["-c", args.at(-1)!], options)
          : proc.run(command, args, options) }),
      );
    }));
    expect(remote.traces.get(row.name)).toMatchObject({ derived: "reported", facts: { live: true, commits: true, report: true, gaps: [] } });
  });

  it("project_status prints every non-closed stored state without catalog writes or duplicate traces", async () => {
    const { h, dir, row } = await fixture();
    const states = AgentState.literals;
    await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: states.map(state => ({ ...row, name: `row_${state}`, state, pane: null, sessionFile: null })) }, null] as const)));
    h.herdr.panes.delete(row.pane!.paneId);
    const before = readFileSync(projectPath(dir), "utf8");
    const first = await runWith(h, projectStatus(dir, { act: false }));
    for (const state of states.filter(state => state !== "closed")) expect(first.board).toContain(`worker/task ${state} task=drafted liveness=quiet`);
    expect(first.board).not.toContain("- row_closed worker/task");
    expect(readFileSync(projectPath(dir), "utf8")).toBe(before);
    const path = join(h.home, ".local/state/muster/task-status-trace.jsonl");
    const log = readFileSync(path, "utf8");
    expect(log.trim().split("\n")).toHaveLength(10);
    await runWith(h, projectStatus(dir, { act: false }));
    expect(readFileSync(path, "utf8")).toBe(log);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The tracer itself must never turn a failed row into a rejection.
    expect(first.board).toContain("failed task=drafted");
  });

  it("logs mapping disagreements only and appends one record when the pair changes", async () => {
    const { h, dir, row } = await fixture();
    const working = { derived: "working" as const, liveness: "quiet" as const, facts: { ...empty, head: null, tree: null, gaps: [] } };
    const path = join(h.home, ".local/state/muster/task-status-trace.jsonl");
    appendTaskTraces(h.home, h.now.toISOString(), "trace", [row], new Map([[row.name, working]]));
    expect(existsSync(path)).toBe(false);
    const rows: AgentRow[] = [{ ...row, state: "reported" }];
    const traces = new Map<string, TaskTrace>([[row.name, working]]);
    appendTaskTraces(h.home, h.now.toISOString(), "trace", rows, traces);
    appendTaskTraces(h.home, h.now.toISOString(), "trace", rows, traces);
    traces.set(row.name, { ...working, derived: "drafted" });
    appendTaskTraces(h.home, h.now.toISOString(), "trace", rows, traces);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    traces.set(row.name, { ...working, derived: "reported" }); // Agreement breaks the previous pair.
    appendTaskTraces(h.home, h.now.toISOString(), "trace", rows, traces);
    traces.set(row.name, { ...working, derived: "drafted" });
    appendTaskTraces(h.home, h.now.toISOString(), "trace", rows, traces);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
    expect((await runWith(h, load(dir))).agents[0]!.state).toBe("running");
  });
});
