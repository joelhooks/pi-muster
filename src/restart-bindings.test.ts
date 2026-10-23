import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentLaunchForeground as agentLaunch, backfillOwnerNames, laneOpen, projectOpen } from "./ops.ts";
import { mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { ratkingTarget } from "./comms-ratking.ts";
import { resolveOwner } from "./owner-queue.ts";
import { remoteBindingPath } from "./remote.ts";
import { MusterEnv } from "./runtime.ts";
import type { AgentRow, Project } from "./domain.ts";

const pushed = vi.hoisted(() => [] as Array<AgentRow>);
vi.mock("./remote.ts", async importOriginal => ({
  ...await importOriginal<typeof import("./remote.ts")>(),
  pushRemoteBinding: (_project: Project, row: AgentRow) => Effect.sync(() => {
    pushed.push(row);
    const path = remoteBindingPath(row.cwd, row.name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(row), { mode: 0o600 });
  }),
}));
beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_PROJECT", ""); vi.stubEnv("MUSTER_MACHINE", ""); pushed.length = 0; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup() {
  const h = harness(); const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "names", reviewTrigger: "weekly", nextAction: "test", criticalPath: [], space: "w1", sidebar: false, ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "names" }));
  const launch = await runWith(h, agentLaunch(dir, { action: "launch", machine: "local", name: "desk", role: "desk", lane: "work", label: "desk", cwd: dir, noSkills: true, prompt: "Initial work." }));
  return { h, dir, old: launch.row };
}
it("a self-restart pushes updated orchestration bindings to live remote rows regardless of policy", async () => {
  const { h, dir, old } = await setup(); h.sessionId = old.sessionId;
  const remote = (name: string, state: "running" | "closed") => ({ ...old, name, role: "worker" as const, machine: "remote", sessionId: `${name}-session`, owner: old.sessionId, pane: null, state });
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: [...p.agents, remote("bucket", "running"), remote("gone", "closed")] }, undefined] as const)));
  const env = { home: h.home, now: () => h.now, sessionId: old.sessionId, paneId: undefined, musterRoot: dir, workerWorktree: h.workerWorktree, createId: () => "receipt", sleep: (ms: number) => Effect.sync(() => h.sleep(ms)), emitPaneClose: h.emitPaneClose };
  const result = await runWith(h, agentLaunch(dir, { action: "restart", name: "desk" }).pipe(Effect.provideService(MusterEnv, env)));
  expect(pushed.map(row => [row.name, row.owner])).toEqual([["bucket", result.row.sessionId]]);
});

it("backfills an ownerName set after a remote launch and pushes it; the worker reads it before launch env", async () => {
  const { h, dir, old } = await setup();
  const { ownerName: _name, ...launch } = { ...old, name: "remote-worker", role: "worker" as const, machine: "remote", state: "running" as const, sessionId: "remote-session", owner: h.sessionId };
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: [...p.agents, launch] }, undefined] as const)));
  vi.stubEnv("RATKING_NAME", "new-owner-name");
  expect(await runWith(h, backfillOwnerNames(dir))).toBe(2);
  expect(pushed).toHaveLength(1);
  expect(pushed[0]?.ownerName).toBe("new-owner-name");
  const env = { MUSTER_MACHINE: "remote", MUSTER_AGENT: launch.name, MUSTER_REMOTE_ROW: JSON.stringify(launch), MUSTER_OWNER: launch.owner, MUSTER_OWNER_NAME: "stale-owner-name" };
  expect(ratkingTarget(launch.owner, { catalogs: [], env })).toEqual({ name: "new-owner-name", session: launch.owner });
  vi.stubEnv("MUSTER_MACHINE", "remote"); vi.stubEnv("MUSTER_AGENT", launch.name); vi.stubEnv("MUSTER_REMOTE_ROW", JSON.stringify(launch));
  expect(resolveOwner({ owner: "stale-session", agent: launch.name, project: "/missing", home: h.home })).toMatchObject({ owner: launch.owner, resolution: "pushed binding" });
  expect(await runWith(h, backfillOwnerNames(dir))).toBe(0);
  expect(pushed).toHaveLength(1);
});
