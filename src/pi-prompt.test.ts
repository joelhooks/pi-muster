import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { profileFor } from "./argv.ts";
import { decodeAgentRow, decodeTurnRecord } from "./domain.ts";
import { RATKING_SEND, RATKING_SEND_RESULT } from "./comms-ratking.ts";
import { projectOpen } from "./ops.ts";
import { registerPiPrompt, type PiPromptResult } from "./pi-prompt.ts";
import { projectPath } from "./store.ts";
import { harness, runWith } from "./test-support.ts";
import { TurnLog } from "./turn-wake.ts";
import muster from "./extension-main.ts";

afterEach(() => vi.useRealTimers());

async function setup(patch: Record<string, unknown> = {}, answer = { status: "delivered", id: "real-mail-42" }, extension = false) {
  const h = harness();
  const dir = join(h.home, "prompt-project"); mkdirSync(dir);
  await runWith(h, projectOpen({ dir, slug: "pilot", outcome: "mail", reviewTrigger: "review", nextAction: "prompt", ephemeral: true }));
  const at = new Date().toISOString();
  const row = decodeAgentRow({ name: "worker", role: "worker", lane: "work", cwd: dir, clone: null,
    profile: { ...profileFor("worker", { label: "worker" }), env: { RATKING_TURN_RECORDS: "1" } },
    sessionId: "worker-session", sessionFile: null, parentSessionFile: null,
    pane: { paneId: "pane-1", terminalId: "terminal-1", tabId: "tab-1", openedByMuster: true }, owner: "owner-session", brief: null,
    state: "running", delivery: "proven", restarts: 0, restore: null, createdAt: at, updatedAt: at, events: [], ...patch });
  const project = JSON.parse(readFileSync(projectPath(dir), "utf8"));
  project.agents = [row]; writeFileSync(projectPath(dir), JSON.stringify(project));
  const events = createEventBus(); const turns = new TurnLog();
  const requests: Array<Record<string, unknown>> = [];
  events.on(RATKING_SEND, payload => {
    const request = payload as Record<string, unknown>; requests.push(request);
    events.emit(RATKING_SEND_RESULT, { requestId: request.requestId, ...answer });
  });
  let shutdown = async () => {};
  if (extension) {
    const previous = process.env.MUSTER_PROJECT;
    process.env.MUSTER_PROJECT = dir;
    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const pi = {
      registerTool() {}, registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, appendEntry() {},
      getFlag: () => undefined, getThinkingLevel: () => "medium", setThinkingLevel() {}, getAllTools: () => [{ name: "ratking" }], sendUserMessage() {},
      on: (name: string, fn: (...args: unknown[]) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), fn]), events,
    };
    const ctx = { cwd: dir, isIdle: () => false, hasUI: false,
      sessionManager: { getSessionId: () => "owner-session", getBranch: () => [], getEntries: () => [], getHeader: () => null },
      ui: { setStatus() {}, setWidget() {} } };
    muster(pi as never);
    for (const hook of hooks.get("session_start") ?? []) await hook({}, ctx);
    shutdown = async () => {
      for (const hook of hooks.get("session_shutdown") ?? []) await hook({}, ctx);
      if (previous === undefined) delete process.env.MUSTER_PROJECT; else process.env.MUSTER_PROJECT = previous;
    };
  } else registerPiPrompt(events, { project: dir, session: "owner-session", turns });
  const claim = vi.fn<(result: Promise<PiPromptResult>) => void>();
  const prompt = (patch: Record<string, unknown> = {}) => {
    events.emit("bellwether/pi-prompt/v1", { paneId: "pane-1", terminalId: "terminal-1", target: "worker", text: "Do this exact work", claim, ...patch });
    return claim.mock.calls.at(-1)?.[0];
  };
  const record = (state: "working" | "idle" | "done", at = new Date().toISOString(), agent = "pilot/worker") => turns.record(decodeTurnRecord({
    $type: "sh.mschf.agentgraph.turn", agent, at, state, session: row.sessionId, turnId: `${row.sessionId}:1`, version: "0.1",
  }));
  return { prompt, claim, requests, record, turns, events, shutdown };
}

it.each([{ owner: "someone-else" }, { state: "closed" }, { pane: null }])("does not claim an unowned, closed or unbound row: %j", async patch => {
  const s = await setup(patch); s.prompt(); expect(s.claim).not.toHaveBeenCalled(); expect(s.requests).toEqual([]);
});
it.each([{ paneId: "unknown" }, { terminalId: "other" }, { text: 42 }, { claim: null }, { target: null }, { terminalId: null }])("ignores unmatched or malformed requests: %j", async patch => {
  const s = await setup(); s.prompt(patch); expect(s.claim).not.toHaveBeenCalled(); expect(s.requests).toEqual([]);
});
it.each([{}, { terminalId: undefined }])("claims synchronously, sends exact text and returns only the send's receipt: %j", async patch => {
  const s = await setup(); vi.useFakeTimers();
  const result = s.prompt(patch)!; expect(s.claim).toHaveBeenCalledTimes(1); expect(s.requests).toEqual([]);
  await vi.advanceTimersByTimeAsync(10);
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0]).toMatchObject({ to: "pilot/worker", kind: "data" });
  expect(JSON.parse(s.requests[0]!.body as string)).toEqual({ type: "message", recipient: "worker-session", author: "owner-session", body: "Do this exact work" });
  s.record("working");
  await expect(result).resolves.toEqual({ outcome: "working", row: "worker", receipt: "real-mail-42" });
});
it("queues mail when only an older working record remains after 30 seconds", async () => {
  const s = await setup(); vi.useFakeTimers(); s.record("working", new Date(Date.now() - 5000).toISOString());
  const result = s.prompt()!; await vi.advanceTimersByTimeAsync(30_000);
  await expect(result).resolves.toEqual({ outcome: "queued", row: "worker", receipt: "real-mail-42" });
});
// S4 live proof, 2026-10-13: mail to a busy Pi ran as a follow-up inside the same run; only its done record followed.
it("mail to a busy row is queued when the running turn's done record follows the send", async () => {
  const s = await setup(); vi.useFakeTimers(); s.record("working", new Date(Date.now() - 5000).toISOString());
  const result = s.prompt()!; await vi.advanceTimersByTimeAsync(5000); s.record("done");
  await vi.advanceTimersByTimeAsync(10);
  await expect(result).resolves.toEqual({ outcome: "queued", row: "worker", receipt: "real-mail-42" });
});
it("an idle row's done record alone does not prove a prompt", async () => {
  const s = await setup(); vi.useFakeTimers(); s.record("done", new Date(Date.now() - 5000).toISOString());
  const result = s.prompt()!; await vi.advanceTimersByTimeAsync(1000); s.record("done");
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(result).resolves.toMatchObject({ outcome: "refused", reason: expect.stringContaining("PromptUnproven") });
});
it("refuses unproven mail with the real row and receipt, not another agent's working record", async () => {
  const s = await setup(); vi.useFakeTimers(); const result = s.prompt()!;
  s.record("working", new Date().toISOString(), "pilot/other"); s.record("idle");
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(result).resolves.toEqual({ outcome: "refused", row: "worker", receipt: "real-mail-42",
    reason: 'PromptUnproven: worker showed no working turn within 30 s of mail real-mail-42. Debug: comms_doctor row:"worker"' });
});
it("refuses a failed send immediately without waiting", async () => {
  const s = await setup({}, { status: "failed", id: "not-a-receipt" });
  const wait = vi.spyOn(s.turns, "waitWorking");
  await expect(s.prompt()).resolves.toMatchObject({ outcome: "refused", reason: expect.stringContaining("NOT DELIVERED") });
  expect(wait).not.toHaveBeenCalled();
});
it("refuses an unsupported launch before sending", async () => {
  const s = await setup({ restore: { cwd: "/work", argv: [], env: {} } });
  const wait = vi.spyOn(s.turns, "waitWorking");
  await expect(s.prompt()).resolves.toMatchObject({ outcome: "refused", reason: expect.stringContaining("TurnUnsupported: worker") });
  expect(s.requests).toEqual([]); expect(wait).not.toHaveBeenCalled();
});
it("the real extension logs working and idle records without delivery ids and releases its prompt hook", async () => {
  const s = await setup({}, undefined, true);
  try {
    vi.useFakeTimers();
    const wire = (state: "working" | "idle", at = new Date().toISOString()) => s.events.emit("ratking/record", { record: {
      $type: "sh.mschf.agentgraph.turn", agent: "pilot/worker", at, state,
      session: "worker-session", turnId: "worker-session:1", version: "0.1",
    } });
    const first = s.prompt()!; await vi.advanceTimersByTimeAsync(10); wire("working");
    await expect(first).resolves.toEqual({ outcome: "working", row: "worker", receipt: "real-mail-42" });
    await vi.advanceTimersByTimeAsync(3000); wire("idle");
    const second = s.prompt()!; await vi.advanceTimersByTimeAsync(30_000);
    await expect(second).resolves.toMatchObject({ outcome: "refused", reason: expect.stringContaining("PromptUnproven") });
  } finally { await s.shutdown(); }
  s.claim.mockClear(); s.prompt(); expect(s.claim).not.toHaveBeenCalled();
});
it("a delivered result without a message id refuses rather than fabricating a receipt", async () => {
  const s = await setup({}, { status: "delivered", id: "" });
  const wait = vi.spyOn(s.turns, "waitWorking");
  const result = await s.prompt();
  expect(result).toMatchObject({ outcome: "refused" }); expect(result).not.toHaveProperty("receipt");
  expect(s.requests).toHaveLength(1); expect(wait).not.toHaveBeenCalled();
});
it("TurnLog accepts working at the two-second tolerance and rejects older and idle records", async () => {
  const s = await setup(); vi.useFakeTimers(); const since = Date.now();
  s.record("working", new Date(since - 2000).toISOString());
  await expect(s.turns.waitWorking("pilot/worker", since, 30_000)).resolves.toBe(true);
  s.record("idle"); const wait = s.turns.waitWorking("pilot/worker", since, 30_000);
  s.record("working", new Date(since - 2001).toISOString());
  await vi.advanceTimersByTimeAsync(30_000); await expect(wait).resolves.toBe(false);
  expect(s.turns.latest("pilot/worker")?.state).toBe("idle");
});
