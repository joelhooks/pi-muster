import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodeMachines, type AgentRow } from "./domain.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen, projectStatus } from "./ops.ts";
import { MusterEnv, Proc, liveProc, noEmitPaneClose } from "./runtime.ts";
import { load, mutate } from "./store.ts";
import { harness, makeRepo, runWith, type FakePane } from "./test-support.ts";

beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", ""); vi.stubEnv("MUSTER_PROJECT", ""); });
afterEach(() => vi.unstubAllEnvs());

async function setup(remote = false) {
  const h = harness();
  const dir = makeRepo(join(h.root, "source"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "adopt desks", reviewTrigger: "weekly", nextAction: "adopt", criticalPath: [], space: "w1", ephemeral: true, deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "adopt", repo: dir }));
  const launched = await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "work", label: "💬 desk", cwd: dir, noSkills: true }));
  const original = launched.row;
  const machine = remote ? "remote" : "local";
  const patch = (change: Partial<AgentRow>) => runWith(h, mutate(dir, project => {
    const row = { ...project.agents.find(row => row.name === "desk")!, ...change };
    return Effect.succeed([{ ...project, agents: project.agents.map(other => other.name === row.name ? row : other) }, row] as const);
  }));
  await patch({ state: "interrupted", machine, pane: null });
  h.herdr.panes.delete(original.pane!.paneId);
  const pane = h.herdr.addPane("w1", "new-tab", dir);
  pane.agent = "pi";
  pane.agent_session = { source: "pi", agent: "pi", kind: "path", value: original.sessionFile! };
  const machines = decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/muster", workerWorktree: h.workerWorktree, env: {}, wrap: [] } });
  const run = <A, E>(effect: Parameters<typeof runWith<A, E>>[1]) => runWith(h, remote ? effect.pipe(
    Effect.provideService(MusterEnv, { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: h.workerWorktree, createId: () => "id", sleep: () => Effect.void, emitPaneClose: noEmitPaneClose, machines, remoteHerdr: () => Effect.succeed(h.herdr.client()) }),
    Effect.provideService(Proc, { run: (command, args, options) => command === "ssh" ? liveProc.run("sh", ["-c", args.at(-1)!], { cwd: h.home, timeoutMs: options.timeoutMs }) : h.proc.run(command, args, options) }),
  ) : effect);
  h.herdr.calls.length = 0;
  const untouched = () => expect(h.herdr.calls.filter(call => ["agent.start", "agent.prompt", "pane.send_keys", "pane.send_input", "pane.close"].includes(call.method))).toEqual([]);
  return { h, dir, original, pane, patch, run, untouched };
}

it.each([false, true])("re-adopts an interrupted session in a new pane (remote=%s)", async remote => {
  const s = await setup(remote);
  const status = await s.run(projectStatus(s.dir, { act: true }));
  expect(status.agents.find(row => row.name === "desk")).toMatchObject({ state: "running", pane: s.pane.pane_id, action: `re-adopted ${s.pane.pane_id}` });
  expect((await runWith(s.h, load(s.dir))).agents[0]!.pane).toMatchObject({ paneId: s.pane.pane_id, terminalId: s.pane.terminal_id, tabId: "new-tab", openedByMuster: false });
  s.untouched();
});

it("matches the session id filename at another path", async () => {
  const s = await setup();
  s.pane.agent_session!.value = join(s.h.root, "elsewhere", `date_${s.original.sessionId}.jsonl`);
  await s.run(projectStatus(s.dir));
  expect((await runWith(s.h, load(s.dir))).agents[0]).toMatchObject({ state: "running", sessionFile: s.pane.agent_session!.value });
  s.untouched();
});

it.each([false, true])("adopts a fork's parent session evidence without changing its file (remote=%s)", async remote => {
  const s = await setup(remote);
  const file = join(s.h.root, "fork_new-session.jsonl");
  const content = JSON.stringify({ type: "session", version: 3, id: "new-session", timestamp: s.h.now.toISOString(), cwd: s.dir, parentSession: s.original.sessionFile }) + "\n";
  writeFileSync(file, content); s.pane.agent_session!.value = file;
  await s.run(projectStatus(s.dir));
  expect((await runWith(s.h, load(s.dir))).agents[0]).toMatchObject({ state: "running", sessionFile: file, sessionId: "new-session" });
  expect(readFileSync(file, "utf8")).toBe(content);
  s.untouched();
});

it("never takes another row's pane, including an interrupted holder", async () => {
  const s = await setup();
  await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, agents: [...project.agents, { ...s.original, name: "holder", state: "interrupted", owner: "other-owner", pane: { paneId: s.pane.pane_id, terminalId: s.pane.terminal_id, tabId: s.pane.tab_id, openedByMuster: true } }] }, undefined] as const)));
  await s.run(projectStatus(s.dir));
  expect((await runWith(s.h, load(s.dir))).agents[0]!.state).toBe("interrupted");
  await expect(s.run(agentLaunch(s.dir, { action: "adopt", name: "desk", pane: s.pane.pane_id }))).rejects.toThrow("already bound");
  s.untouched();
});

it("refuses explicit adoption of an unrelated session without poisoning later matching", async () => {
  const s = await setup();
  s.pane.agent_session!.value = join(s.h.root, "unrelated_other.jsonl");
  await expect(s.run(agentLaunch(s.dir, { action: "adopt", name: "desk", pane: s.pane.pane_id }))).rejects.toThrow("session");
  await s.run(projectStatus(s.dir));
  expect((await runWith(s.h, load(s.dir))).agents[0]).toMatchObject({ state: "interrupted", sessionFile: s.original.sessionFile });
  s.untouched();
});

it.each([false, true])("explicit adopt only updates catalog evidence (remote=%s)", async remote => {
  const s = await setup(remote);
  const result = await s.run(agentLaunch(s.dir, { action: "adopt", name: "desk", pane: s.pane.pane_id }));
  expect(result.row).toMatchObject({ state: "running", pane: { paneId: s.pane.pane_id } });
  expect(result.argv).toEqual([]);
  s.untouched();
});

it.each(["silent", "nudged", "restarted"] as const)("re-adopts a %s row and skips silence actions in that pass", async state => {
  const s = await setup(); await s.patch({ state });
  s.h.now = new Date(s.h.now.getTime() + 3 * 3600_000);
  const result = await s.run(projectStatus(s.dir));
  expect(result.agents[0]).toMatchObject({ state: "running", action: `re-adopted ${s.pane.pane_id}` });
  s.untouched();
});

it.each(["preview", "foreign owner", "foreign workspace", "not pi", "ambiguous"])("does not re-adopt with %s", async kind => {
  const s = await setup();
  if (kind === "foreign owner") await s.patch({ owner: "other-owner" });
  if (kind === "foreign workspace") s.pane.workspace_id = "w-other";
  if (kind === "not pi") { s.pane.agent = "claude"; s.pane.agent_session!.agent = "claude"; }
  if (kind === "ambiguous") {
    const duplicate: FakePane = s.h.herdr.addPane("w1", "other-tab", s.dir);
    duplicate.agent = "pi"; duplicate.agent_session = { ...s.pane.agent_session! };
  }
  await s.run(projectStatus(s.dir, { act: kind !== "preview" }));
  expect((await runWith(s.h, load(s.dir))).agents[0]!.state).toBe("interrupted");
  s.untouched();
});
