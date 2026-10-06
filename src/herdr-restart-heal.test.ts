import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRow } from "./domain.ts";
import { agentLaunch, laneOpen, packetReport, projectOpen, projectStatus } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", ""); vi.stubEnv("MUSTER_PROJECT", ""); });
afterEach(() => vi.unstubAllEnvs());

async function setup(state: AgentRow["state"] = "landed", stale = false) {
  const h = harness();
  const dir = makeRepo(join(h.root, "source"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "repair identity", reviewTrigger: "weekly", nextAction: "heal", criticalPath: [], space: "w1", ephemeral: true, deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "heal", repo: dir }));
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "desk", lane: "work", label: "worker", cwd: dir, noSkills: true }));
  h.herdr.panes.delete(row.pane!.paneId);
  const pane = h.herdr.addPane("w1", "new-tab", dir);
  pane.agent = "pi";
  pane.agent_session = { source: "pi", agent: "pi", kind: "path", value: row.sessionFile! };
  const patch = (change: Partial<AgentRow>) => runWith(h, mutate(dir, project => {
    const next = { ...project.agents[0]!, ...change };
    return Effect.succeed([{ ...project, agents: [next, ...project.agents.slice(1)] }, next] as const);
  }));
  await patch({ state, pane: stale ? row.pane : null });
  h.herdr.calls.length = 0;
  const saved = async () => (await runWith(h, load(dir))).agents[0]!;
  const untouched = () => expect(h.herdr.calls.filter(call => ["agent.start", "agent.prompt", "pane.send_keys", "pane.send_input", "pane.close"].includes(call.method))).toEqual([]);
  return { h, dir, row, pane, patch, saved, untouched };
}

it.each(["planned", "launching", "failed", "running", "reported", "verified", "landed"] as const)("rebinds %s without lifecycle change", async state => {
  const s = await setup(state);
  const result = await runWith(s.h, projectStatus(s.dir, { act: true }));
  expect(await s.saved()).toMatchObject({ state, sessionId: s.row.sessionId, pane: { paneId: s.pane.pane_id, terminalId: s.pane.terminal_id, openedByMuster: false } });
  expect(result.agents[0]!.action).toBe(`rebound worker → ${s.pane.pane_id} (identity: session path match)`);
  s.untouched();
});

it("rebinds a stale terminal and is idempotent", async () => {
  const s = await setup("landed", true);
  await runWith(s.h, projectStatus(s.dir, { act: true }));
  const before = await s.saved();
  await runWith(s.h, projectStatus(s.dir, { act: true }));
  expect(await s.saved()).toEqual(before);
  s.untouched();
});

it.each(["reported", "verified", "landed"] as const)("explicit adopt preserves %s", async state => {
  const s = await setup(state);
  const result = await runWith(s.h, agentLaunch(s.dir, { action: "adopt", name: "worker", pane: s.pane.pane_id }));
  expect(result.row.state).toBe(state);
  s.untouched();
});

it("a rebound reported worker can report again", async () => {
  const s = await setup("reported");
  await runWith(s.h, projectStatus(s.dir, { act: true }));
  const result = await runWith(s.h, packetReport({ dir: s.dir, cwd: s.dir, agent: "worker", owner: s.row.owner, commit: "HEAD", summary: "recovered report", checks: [] }));
  expect(result.packet.state).toBe("reported");
});

it.each(["ambiguous", "held", "closed", "foreign", "preview", "different path", "not pi"])("refuses or leaves untouched: %s", async kind => {
  const s = await setup(kind === "closed" ? "closed" : "landed");
  if (kind === "ambiguous") {
    const duplicate = s.h.herdr.addPane("w1", "other-tab", s.dir);
    duplicate.agent = "pi"; duplicate.agent_session = { ...s.pane.agent_session! };
  }
  if (kind === "held") await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, agents: [...project.agents, { ...s.row, name: "holder", owner: "other", state: "landed", pane: { paneId: s.pane.pane_id, tabId: s.pane.tab_id, terminalId: s.pane.terminal_id, openedByMuster: true } }] }, undefined] as const)));
  if (kind === "foreign") await s.patch({ owner: "other" });
  if (kind === "different path") s.pane.agent_session!.value = join(s.h.root, `elsewhere_${s.row.sessionId}.jsonl`);
  if (kind === "not pi") s.pane.agent = "claude";
  const before = await s.saved();
  const result = await runWith(s.h, projectStatus(s.dir, { act: kind !== "preview" }));
  expect(await s.saved()).toEqual(before);
  if (kind === "ambiguous" || kind === "held") {
    expect(result.agents[0]!.action).toContain("rebind refused");
    await expect(runWith(s.h, agentLaunch(s.dir, { action: "adopt", name: "worker", pane: s.pane.pane_id }))).rejects.toThrow("rebind refused");
  }
  s.untouched();
});

it("keeps interrupted lifecycle recovery", async () => {
  const s = await setup("interrupted");
  await runWith(s.h, projectStatus(s.dir, { act: true }));
  expect((await s.saved()).state).toBe("running");
  s.untouched();
});
