import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@joelhooks/pi-bellwether/herdr-client";
import { Effect } from "effect";
import { basename } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { profileFor } from "./argv.ts";
import { decodeAgentRow, decodeTurnRecord, type TurnRecord } from "./domain.ts";
import muster from "./extension-main.ts";
import { projectOpen } from "./ops.ts";
import { mutate } from "./store.ts";
import { harness, runWith } from "./test-support.ts";
import { deriveTokens, lacksTurnEvidence } from "./tokens.ts";

vi.mock("@joelhooks/pi-bellwether/herdr-client", async importOriginal => ({
  ...await importOriginal<typeof import("@joelhooks/pi-bellwether/herdr-client")>(),
  createHerdrClient: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function setup() {
  const h = harness();
  const slug = basename(h.root).toLowerCase();
  const opened = await runWith(h, projectOpen({ dir: h.home, slug, outcome: "turn tokens", reviewTrigger: "on request",
    nextAction: "test", space: "w1", sidebar: true, ephemeral: true, deskExtension: null }));
  const at = "2026-10-13T00:00:00.000Z";
  const row = decodeAgentRow({ name: "worker", role: "worker", lane: "work", cwd: h.home, clone: null,
    profile: profileFor("worker", { label: "worker" }), sessionId: `${slug}-session`, sessionFile: null, parentSessionFile: null,
    pane: null, owner: h.sessionId, brief: null, state: "running", delivery: "proven", restarts: 0, restore: null, createdAt: at, updatedAt: at });
  const project = { ...opened.project, agents: [row] };
  await runWith(h, mutate(h.home, () => Effect.succeed([project, undefined] as const)));
  const record = (state: TurnRecord["state"], patch = {}) => decodeTurnRecord({
    $type: "sh.mschf.agentgraph.turn", agent: `${slug}/worker`, at, session: row.sessionId,
    state, turnId: `${row.sessionId}:1`, version: "0.1", ...patch,
  });
  return { ...h, project, row, record };
}

it("buckets usable turns before fallback states, excluding closed rows and preserving fit", async () => {
  const s = await setup();
  const rows = ["working", "idle", "blocked"].map(name => ({ ...s.row, name }));
  const turns = new Map(rows.map(row => [`${s.project.slug}/${row.name}`, s.record(row.name as TurnRecord["state"], { agent: `${s.project.slug}/${row.name}` })]));
  const project = { ...s.project, agents: rows };
  expect(deriveTokens(project, [], {}, turns).agents).toBe("1 working · 1 blocked · 1 idle");
  turns.set(`${s.project.slug}/idle`, s.record("done", { agent: `${s.project.slug}/idle` }));
  expect(deriveTokens(project, [], {}, turns).agents).toBe("1 working · 1 blocked · 1 idle");
  expect(deriveTokens({ ...project, agents: [...rows, { ...rows[0]!, state: "closed" }] }, [], {}, turns).agents).toBe("1 working · 1 blocked · 1 idle");
  expect(deriveTokens(project, [], { stuck: 1 }, turns).agents).toBe("⚠️ 1 stuck · 1 working");
});
it("uses gone for a lapsed lease and falls back for sessions outside the chain", async () => {
  const s = await setup();
  const key = `${s.project.slug}/worker`;
  expect(deriveTokens(s.project, [], {}, new Map([[key, s.record("crashed")]])).agents).toBe("1 gone");
  expect(deriveTokens(s.project, [], {}, new Map([[key, s.record("blocked", { session: "stranger", turnId: "stranger:1" })]])).agents).toBe("1 run");
  const project = { ...s.project, agents: [{ ...s.row, events: [{ type: "RESTARTED" as const, at: s.row.updatedAt, detail: `prior -> ${s.row.sessionId}` }] }] };
  expect(deriveTokens(project, [], {}, new Map([[key, s.record("idle", { session: "prior", turnId: "prior:1" })]])).agents).toBe("1 idle");
});

async function live(turnEnabled = false) {
  const s = await setup();
  if (turnEnabled) await runWith(s, mutate(s.home, project => Effect.succeed([{ ...project, agents: project.agents.map(row =>
    ({ ...row, restore: { cwd: row.cwd, argv: [], env: { RATKING_TURN_RECORDS: "1" } } })) }, undefined] as const)));
  vi.stubEnv("HOME", s.home); vi.stubEnv("MUSTER_PROJECT", s.home); vi.stubEnv("MUSTER_MACHINE", "local");
  vi.stubEnv("MUSTER_ROLE", "boss"); vi.stubEnv("MUSTER_AGENT", "");
  vi.mocked(createHerdrClient).mockReturnValue(s.herdr.client());
  const events = createEventBus();
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool), registerFlag() {}, registerCommand() {}, registerShortcut() {},
    registerMessageRenderer() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {},
    getFlag: () => undefined, getThinkingLevel: () => "medium", setThinkingLevel() {}, getAllTools: () => [{ name: "ratking" }], events,
    on: (name: string, fn: (...args: unknown[]) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), fn]) };
  const ctx = { cwd: s.home, hasUI: false, isIdle: () => false, ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: { getSessionId: () => s.sessionId, getBranch: () => [], getEntries: () => [], getHeader: () => null } };
  muster(pi as never);
  const lifecycle = async (event: string) => { for (const hook of hooks.get(event) ?? []) await hook({}, ctx); };
  vi.useFakeTimers();
  await lifecycle("session_start");
  s.herdr.calls.length = 0;
  const emit = (state: TurnRecord["state"], patch = {}) => events.emit("ratking/record", { record: s.record(state, patch) });
  const publishes = () => s.herdr.calls.filter(call => call.method === "workspace.report_metadata");
  return { ...s, emit, publishes, stop: () => lifecycle("session_shutdown"),
    status: () => tools.get("project_status")!.execute("status", { project: s.home, act: true }, undefined, undefined, ctx) };
}

it("the real listener publishes working, idle and blocked within one second, and status uses the same log", async () => {
  const s = await live();
  try {
    for (const state of ["working", "idle", "blocked"] as const) {
      s.emit(state);
      await vi.advanceTimersByTimeAsync(999);
      expect(s.publishes()).toHaveLength(["working", "idle", "blocked"].indexOf(state));
      await vi.advanceTimersByTimeAsync(1);
      expect(s.publishes().at(-1)?.params.tokens).toMatchObject({ agents: `1 ${state}`, needs: null });
    }
    expect(s.publishes()).toHaveLength(3);
    const status = await s.status();
    expect(status.isError).not.toBe(true);
    expect(s.publishes()).toHaveLength(4);
    expect(s.publishes().at(-1)?.params.tokens).toMatchObject({ agents: "1 blocked" });
  } finally { await s.stop(); }
});
// S5 live proof, 2026-10-13: three detached launch jobs, with empty turn logs, overwrote the desk's turn-derived token.
it("a publisher without turn evidence for its turn-enabled rows leaves $agents to the owner", async () => {
  const s = await live(true);
  try {
    const project = { ...s.project, agents: [{ ...s.row, restore: { cwd: s.row.cwd, argv: [], env: { RATKING_TURN_RECORDS: "1" } } }] };
    expect(lacksTurnEvidence(project, new Map())).toBe(true);
    expect(lacksTurnEvidence({ ...project, agents: [s.row] }, new Map())).toBe(false);
    await s.status();
    expect(s.publishes().at(-1)?.params.tokens).not.toHaveProperty("agents");
    expect(s.publishes().at(-1)?.params.tokens).toHaveProperty("progress");
    s.emit("working"); await vi.advanceTimersByTimeAsync(1000);
    expect(s.publishes().at(-1)?.params.tokens).toMatchObject({ agents: "1 working" });
  } finally { await s.stop(); }
});
// S5 live proof, 2026-10-13: after every worker closed, the desk's own turn-enabled row kept a stale $agents.
it("the publisher's own row is not missing evidence, so closing every worker republishes $agents", async () => {
  const s = await setup();
  const enabled = { cwd: s.row.cwd, argv: [], env: { RATKING_TURN_RECORDS: "1" } };
  const desk = { ...s.row, name: "desk", role: "desk" as const, sessionId: s.sessionId, restore: enabled };
  const worker = { ...s.row, restore: enabled };
  expect(lacksTurnEvidence({ ...s.project, agents: [desk] }, new Map(), s.sessionId)).toBe(false);
  expect(lacksTurnEvidence({ ...s.project, agents: [desk, { ...worker, state: "closed" as const }] }, new Map(), s.sessionId)).toBe(false);
  expect(lacksTurnEvidence({ ...s.project, agents: [desk, worker] }, new Map(), s.sessionId)).toBe(true);
});
it("coalesces bursts, ignores other projects, and cancels the pending publish on shutdown", async () => {
  const s = await live();
  try {
    s.emit("working", { agent: "outside/worker" });
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.publishes()).toHaveLength(0);
    s.emit("working"); s.emit("idle");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.publishes()).toHaveLength(1);
    expect(s.publishes()[0]?.params.tokens).toMatchObject({ agents: "1 idle" });
    s.emit("blocked");
    await s.stop();
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.publishes()).toHaveLength(1);
  } finally { await s.stop(); }
});
