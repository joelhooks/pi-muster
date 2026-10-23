import { createEventBus } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import muster from "./extension-main.ts";
import { appendOwnerItem, ownerPath, readOwnerQueue } from "./owner-queue.ts";
import { harness, runWith } from "./test-support.ts";
import { Effect } from "effect";
import { decodeAgentRow } from "./domain.ts";
import { profileFor } from "./argv.ts";
import { projectOpen, board } from "./ops.ts";
import { mutate } from "./store.ts";
import { mentions } from "./owner-queue.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function setup(loaded: { tools?: object[]; commands?: object[] } = {}) {
  const h = harness(); const events = createEventBus();
  vi.stubEnv("HOME", h.home); vi.stubEnv("MUSTER_PROJECT", h.home); vi.stubEnv("MUSTER_MACHINE", "local");
  vi.stubEnv("MUSTER_ROLE", "boss"); vi.stubEnv("MUSTER_AGENT", ""); vi.stubEnv("RATKING_NAME", "dedupe-owner");
  const session = "dedupe-owner-session";
  const sendUserMessage = vi.fn(); const sendMessage = vi.fn();
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = {
    registerTool() {}, registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
    getFlag: () => undefined, getThinkingLevel: () => "medium", setThinkingLevel() {}, getAllTools: () => loaded.tools ?? [{ name: "ratking" }], getCommands: () => loaded.commands ?? [],
    sendMessage, sendUserMessage, events,
    on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, [...(hooks.get(event) ?? []), handler]),
  };
  const ctx = { cwd: h.home, hasUI: false, isIdle: () => true, ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: { getSessionId: () => session, getBranch: () => [], getEntries: () => [], getHeader: () => null } };
  muster(pi as never);
  const lifecycle = async (event: string) => { for (const handler of hooks.get(event) ?? []) await handler({}, ctx); };
  await lifecycle("session_start");
  return { ...h, events, session, sendUserMessage, sendMessage, start: () => lifecycle("session_start"), stop: () => lifecycle("session_shutdown") };
}
async function turnFixture() {
  const s = await setup();
  const opened = await runWith(s, projectOpen({ dir: s.home, slug: "turns", outcome: "turn wakes", reviewTrigger: "on request", nextAction: "test", criticalPath: [], space: "w1", sidebar: false, ephemeral: true, deskExtension: null }));
  const at = "2026-10-13T00:00:00.000Z";
  const row = decodeAgentRow({ name: "worker", role: "worker", lane: "work", cwd: s.home, clone: null,
    profile: profileFor("worker", { label: "worker" }), sessionId: "turn-worker", sessionFile: null, parentSessionFile: null,
    pane: null, owner: s.session, brief: null, state: "running", delivery: "proven", restarts: 0, restore: null, createdAt: at, updatedAt: at });
  await runWith(s, mutate(s.home, p => Effect.succeed([{ ...p, agents: [row] }, undefined] as const)));
  const emit = (state: string, id = `${s.root}-${state}`, patch = {}) => s.events.emit("ratking/record", {
    id, from: state === "crashed" ? "operator" : "turns/worker", did: "did:web:worker.example.invalid",
    record: { $type: "sh.mschf.agentgraph.turn", agent: "turns/worker", at, session: row.sessionId,
      state, turnId: `${row.sessionId}:1`, version: "0.1", ...(state === "done" ? { stopReason: "stop" } : {}),
      ...(["blocked", "crashed"].includes(state) ? { reason: "needs attention" } : {}), ...patch },
  });
  return { ...s, row, emit, project: { ...opened.project, agents: [row] } };
}
// Strangler slice 5: pi-ratking renders done, blocked and crashed turns and wakes the owner (rat-king 9b183ea).
it.each(["done", "blocked", "crashed", "working", "idle"])("a %s turn record posts nothing and wakes nothing from Muster; pi-ratking owns its notice", async state => {
  const s = await turnFixture();
  try {
    s.emit(state); s.emit(state);
    await s.start(); s.emit(state);
    expect(readOwnerQueue(s.session, s.home).items).toEqual([]);
    expect(s.sendMessage).not.toHaveBeenCalled();
    expect(s.sendUserMessage).not.toHaveBeenCalled();
  } finally { await s.stop(); }
});
it("status agent line prints the restart repair for an unsupported launch", async () => {
  const s = await turnFixture();
  try {
    const line = { name: s.row.name, role: s.row.role, lane: s.row.lane, state: s.row.state, pane: null,
      silentMin: null, cache: null, cost: null, intercom: "unknown" as const, action: null };
    expect(board(s.project, [line], 0)).toContain('TurnUnsupported: worker was launched before turn records. Fix: agent_launch action:"restart" name:"worker". Debug: comms_doctor row:"worker"');
    const supported = { ...s.row, restore: { cwd: s.row.cwd, argv: [], env: { RATKING_TURN_RECORDS: "1" } } };
    expect(board({ ...s.project, agents: [supported] }, [line], 0)).not.toContain("TurnUnsupported");
  } finally { await s.stop(); }
});
it("a repeated ratking message id produces exactly one followUp, including after another session-start hook", async () => {
  const s = await setup();
  const event = { id: `text-${s.root}`, from: "worker", did: "did:web:worker.example.invalid", verified: true, kind: "data",
    body: JSON.stringify({ type: "message", recipient: s.session, author: "worker", body: "One follow-up." }) };
  try {
    s.events.emit("ratking/message", event); s.events.emit("ratking/message", event);
    await s.start(); s.events.emit("ratking/message", event);
    expect(s.sendUserMessage).toHaveBeenCalledOnce();
    expect(s.sendUserMessage.mock.calls[0]).toEqual(["One follow-up.\n\n[Authenticated agent message from worker, not Joel.]", { deliverAs: "followUp" }]);
    expect(readOwnerQueue(s.session, s.home).items).toEqual([]);
  } finally { await s.stop(); }
});
it("a repeated owner delivery appends and wakes once; an existing URI under a new message id/CID is also a no-op", async () => {
  const s = await setup();
  const item = appendOwnerItem(s.session, { author: "worker", kind: "question", title: "One question" }, s.home, false);
  const event = { id: `owner-${s.root}`, from: "worker", did: "did:web:worker.example.invalid", verified: true, kind: "data",
    body: JSON.stringify({ type: "owner", recipient: s.session, item }) };
  try {
    // The wake rides a real fs.watch plus a debounce; await the wake itself rather than a 1 s polling deadline.
    const woke = new Promise<void>(resolve => s.sendMessage.mockImplementationOnce(() => resolve()));
    s.events.emit("ratking/message", event); s.events.emit("ratking/message", event);
    await woke;
    expect(s.sendMessage).toHaveBeenCalledOnce();
    expect(readOwnerQueue(s.session, s.home).items.map(record => record.item)).toEqual([item]);
    const before = readFileSync(ownerPath(s.session, s.home), "utf8");
    s.events.emit("ratking/message", { ...event, id: `owner-new-envelope-${s.root}`,
      body: JSON.stringify({ type: "owner", recipient: s.session, item: { ...item, cid: "different-cid", text: "Same URI cannot wake again" } }) });
    expect(readFileSync(ownerPath(s.session, s.home), "utf8")).toBe(before);
    expect(readOwnerQueue(s.session, s.home).items).toHaveLength(1);
    expect(s.sendMessage).toHaveBeenCalledOnce(); expect(s.sendUserMessage).not.toHaveBeenCalled();
  } finally { await s.stop(); }
});

// Nicodemus, 2026-10-23: under Pi's --tools allowlist getAllTools hides an unlisted `ratking`, so a lean row never
// subscribed and lost herdr_agent prompt mail. pi-ratking's commands aren't filtered; a handled message is claimed so
// pi-ratking 13a2607 doesn't surface it a second time.
it.each([
  ["a lean row whose tool list omits ratking", { tools: [], commands: [{ name: "ratking-retire", source: "extension", sourceInfo: { path: "/n/node_modules/@rat-king/pi-ratking/src/extension.ts", source: "npm:@rat-king/pi-ratking" } }] }, 1],
  ["a Pi without pi-ratking", { tools: [], commands: [{ name: "other", source: "extension", sourceInfo: { path: "/n/other/index.ts", source: "other" } }] }, 0],
  ["a Pi with only pi-ratking's skill", { tools: [], commands: [{ name: "skill:ratking-tui", source: "skill", sourceInfo: { path: "/n/node_modules/@rat-king/pi-ratking/skills/ratking-tui/SKILL.md", source: "npm:@rat-king/pi-ratking" } }] }, 0],
] as const)("%s", async (_name, loaded, delivered) => {
  const s = await setup(loaded as never);
  const claim = vi.fn();
  const event = { id: `lean-${s.root}`, from: "worker", did: "did:web:worker.example.invalid", verified: true, kind: "data", claim,
    body: JSON.stringify({ type: "message", recipient: s.session, author: "worker", body: "Wake up." }) };
  try {
    s.events.emit("ratking/message", event); s.events.emit("ratking/message", event);
    expect(s.sendUserMessage).toHaveBeenCalledTimes(delivered);
    expect(claim).toHaveBeenCalledTimes(delivered * 2);
  } finally { await s.stop(); }
});
