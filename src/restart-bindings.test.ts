import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { MusterEnv } from "./runtime.ts";

const pushed = vi.hoisted(() => [] as Array<{ slug: string; rows: string[] }>);
vi.mock("./comms-network.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./comms-network.ts")>(),
  provisionLiveRows: (options: { project: { slug: string }; rows: ReadonlyArray<{ name: string }> }) => Effect.sync(() => {
    pushed.push({ slug: options.project.slug, rows: options.rows.map(row => row.name) });
    return options.rows.map(row => `${row.name}: identity ready, key pushed to remote`);
  }),
}));

beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_PROJECT", ""); vi.stubEnv("MUSTER_MACHINE", ""); pushed.length = 0; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Roland, 20:32Z: a pennywise worker refused the restarted desk's replies as "not a known agent".
it("a self-restart pushes the successor's session binding to the network catalog's live remote rows", async () => {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "restart", reviewTrigger: "weekly", nextAction: "test", criticalPath: [], space: "w1", sidebar: false, ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "restart" }));
  const launch = await runWith(h, agentLaunch(dir, { action: "launch", machine: "local", name: "desk", role: "desk", lane: "work", label: "desk", cwd: dir, noSkills: true, prompt: "Initial work." }));
  const old = launch.row;
  h.sessionId = old.sessionId;
  const remote = (name: string, state: "running" | "closed") => ({ ...old, name, role: "worker" as const, machine: "remote", sessionId: `${name}-session`, owner: old.sessionId, pane: null, state });
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, policy: { ...p.policy, comms: "network" as const }, agents: [...p.agents, remote("bucket", "running"), remote("gone", "closed")] }, undefined] as const)));
  const env = { home: h.home, now: () => h.now, sessionId: old.sessionId, paneId: undefined, musterRoot: dir, workerWorktree: h.workerWorktree,
    createId: () => "receipt", sleep: (ms: number) => Effect.sync(() => h.sleep(ms)), emitPaneClose: h.emitPaneClose };
  const result = await runWith(h, agentLaunch(dir, { action: "restart", name: "desk" }).pipe(Effect.provideService(MusterEnv, env)));
  expect(pushed).toEqual([{ slug: "probe", rows: ["bucket"] }]);
  expect(result.notes.join("\n")).toContain("session bindings pushed to 1 remote row(s) in probe");
});
