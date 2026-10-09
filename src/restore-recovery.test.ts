import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Effect } from "effect";
import { HerdrApiError } from "@joelhooks/pi-bellwether/herdr-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentLaunch, agentLaunchForeground, laneOpen, projectOpen, projectStatus } from "./ops.ts";
import { liveProc } from "./runtime.ts";
import { load, mutate } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  },
}));

beforeEach(() => {
  vi.stubEnv("MUSTER_MACHINE", ""); vi.stubEnv("MUSTER_PROJECT", "");
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const run = liveProc.run;
  vi.spyOn(liveProc, "run").mockImplementation((command, args, options) => command === "pi"
    ? Effect.succeed({ code: 0, stdout: "provider model context max-out thinking images\nopenai-codex gpt-6.1-sol 272K 128K yes yes\n", stderr: "" })
    : run(command, args, options));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup() {
  const h = harness(); h.proc = liveProc;
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "restore", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "test" }));
  const launched = await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, model: "sol", prompt: "start" }));
  return { h, dir, row: launched.row };
}

it.each([true, false])("non-owner status only interrupts a gone pane with act:%s", async act => {
  const { h, dir, row } = await setup();
  h.herdr.panes.delete(row.pane!.paneId); h.sessionId = "other-owner";
  const boundary = h.herdr.calls.length;
  await runWith(h, projectStatus(dir, { act }));
  const current = (await runWith(h, load(dir))).agents[0]!;
  expect(current.state).toBe(act ? "interrupted" : "running");
  expect(current.pane).toEqual(act ? null : row.pane);
  expect(current.owner).toBe(row.owner);
  expect(h.herdr.calls.slice(boundary).some(call => ["pane.close", "pane.send_input", "agent.prompt"].includes(call.method))).toBe(false);
});

it("another live pane proving the session vetoes interruption and duplicate restore", async () => {
  const { h, dir, row } = await setup();
  const old = h.herdr.panes.get(row.pane!.paneId)!;
  h.herdr.panes.delete(old.pane_id);
  const replacement = h.herdr.addPane("w1", old.tab_id, dir);
  Object.assign(replacement, { agent: "pi", agent_session: old.agent_session });
  h.sessionId = "other-owner";
  // Restore must refuse before launching a duplicate, even without status reconciliation.
  const boundary = h.herdr.calls.length;
  expect((await failWith(h, agentLaunchForeground(dir, { action: "restore", name: "worker" }))).message).toContain("RESTORE");
  expect(h.herdr.calls.slice(boundary).some(call => call.method === "pane.send_input")).toBe(false);
  await runWith(h, projectStatus(dir, { act: true }));
  const current = (await runWith(h, load(dir))).agents[0]!;
  expect(current.state).toBe("running"); expect(current.pane?.paneId).toBe(replacement.pane_id);
});

it("restore interrupts a running row with a gone pane and preserves its owner", async () => {
  const { h, dir, row } = await setup();
  h.herdr.panes.delete(row.pane!.paneId); h.sessionId = "other-owner";
  const result = await runWith(h, agentLaunchForeground(dir, { action: "restore", name: "worker" }));
  expect(result.row.state).toBe("running"); expect(result.row.owner).toBe(row.owner);
  expect(result.row.pane?.paneId).not.toBe(row.pane!.paneId);
  expect(result.notes.join("\n")).toContain("gone; interrupted before restore");
  expect(result.row.events?.some(event => event.type === "PANE_GONE")).toBe(true);
});

it("async restore reserves the recovered state rather than refusing a running row", async () => {
  const { h, dir, row } = await setup();
  h.herdr.panes.delete(row.pane!.paneId);
  // No child process in this test: reservation is the proof under test.
  const result = await runWith(h, agentLaunch(dir, { action: "restore", name: "worker" }));
  expect(result.row.state).toBe("launching"); expect(result.row.pane).toBeNull();
  expect(result.row.events?.some(event => event.type === "PANE_GONE")).toBe(true);
});

it("restore reopens a missing lane root through lane_open without closing another pane", async () => {
  const { h, dir, row } = await setup();
  const lane = (await runWith(h, load(dir))).lanes.find(lane => lane.slug === "work")!;
  h.herdr.panes.delete(row.pane!.paneId); h.herdr.panes.delete(lane.root!.paneId); h.herdr.tabs.delete(lane.tabId!);
  const foreign = h.herdr.addPane("w1", "foreign-tab", dir);
  const boundary = h.herdr.calls.length;
  const result = await runWith(h, agentLaunchForeground(dir, { action: "restore", name: "worker" }));
  const reopened = (await runWith(h, load(dir))).lanes.find(lane => lane.slug === "work")!;
  expect(reopened.tabId).not.toBe(lane.tabId); expect(reopened.root?.openedByMuster).toBe(true);
  expect(result.row.pane?.tabId).toBe(reopened.tabId);
  expect(result.notes.join("\n")).toContain("lane work reopened");
  expect(h.herdr.panes.has(foreign.pane_id)).toBe(true);
  expect(h.herdr.calls.slice(boundary).some(call => call.method === "pane.close")).toBe(false);
});

it.each(["late", "timeout"] as const)("restore rename waits for Herdr registration: %s", async kind => {
  const { h, dir, row } = await setup();
  h.herdr.panes.delete(row.pane!.paneId);
  const handle = h.herdr.handle.bind(h.herdr);
  let gets = 0; let renamed = false;
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => {
    if (method === "agent.get") {
      gets++;
      if (kind === "timeout" || gets < 4) throw new HerdrApiError({ operation: method, code: "agent_not_found", message: "not registered yet" });
    }
    if (method === "agent.rename") { expect(gets).toBeGreaterThanOrEqual(4); renamed = true; }
    return handle(method, params);
  });
  const result = await runWith(h, agentLaunchForeground(dir, { action: "restore", name: "worker" }));
  expect(result.row.state).toBe("running");
  if (kind === "late") {
    expect(renamed).toBe(true); expect(h.herdr.panes.get(result.row.pane!.paneId)?.name).toBe("worker");
  } else {
    expect(renamed).toBe(false); expect(gets).toBe(61);
    const notes = result.notes.filter(note => note.includes("agent registration not proven"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`herdr agent rename '${result.row.pane!.paneId}' 'worker'`);
  }
});

it("non-owner status recovers a launching row too", async () => {
  const { h, dir, row } = await setup();
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(agent => ({ ...agent, state: "launching" as const })) }, undefined] as const)));
  h.herdr.panes.delete(row.pane!.paneId); h.sessionId = "other-owner";
  await runWith(h, projectStatus(dir, { act: true }));
  expect((await runWith(h, load(dir))).agents[0]?.state).toBe("interrupted");
});

it("launch into an open lane whose root pane is gone reopens it instead of refusing", async () => {
  const { h, dir } = await setup();
  const lane = (await runWith(h, load(dir))).lanes.find(lane => lane.slug === "work")!;
  h.herdr.panes.delete(lane.root!.paneId); h.herdr.tabs.delete(lane.tabId!);
  const result = await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "boss", role: "boss", lane: "work", label: "boss", cwd: dir, model: "sol", prompt: "start" }));
  const reopened = (await runWith(h, load(dir))).lanes.find(lane => lane.slug === "work")!;
  expect(reopened.tabId).not.toBe(lane.tabId);
  expect(result.row.pane?.tabId).toBe(reopened.tabId);
  expect(result.notes.join("\n")).toContain("launch: lane work reopened");
});

it.each(["reported", "verified", "landed"] as const)("restore of a %s row whose pane died interrupts it and restores", async state => {
  const { h, dir, row } = await setup();
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(agent => ({ ...agent, state })) }, undefined] as const)));
  h.herdr.panes.delete(row.pane!.paneId);
  const result = await runWith(h, agentLaunchForeground(dir, { action: "restore", name: "worker" }));
  expect(result.row.state).toBe("running"); expect(result.row.owner).toBe(row.owner);
  expect(result.notes.join("\n")).toContain("gone; interrupted before restore");
});
