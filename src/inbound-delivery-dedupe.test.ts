import { createEventBus } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import muster from "./extension-main.ts";
import { appendOwnerItem, ownerPath, readOwnerQueue } from "./owner-queue.ts";
import { harness } from "./test-support.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function setup() {
  const h = harness(); const events = createEventBus();
  vi.stubEnv("HOME", h.home); vi.stubEnv("MUSTER_PROJECT", h.home); vi.stubEnv("MUSTER_MACHINE", "local");
  vi.stubEnv("MUSTER_ROLE", "boss"); vi.stubEnv("MUSTER_AGENT", ""); vi.stubEnv("RATKING_NAME", "dedupe-owner");
  const session = "dedupe-owner-session";
  const sendUserMessage = vi.fn(); const sendMessage = vi.fn();
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = {
    registerTool() {}, registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
    getFlag: () => undefined, getThinkingLevel: () => "medium", setThinkingLevel() {}, getAllTools: () => [{ name: "ratking" }],
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
    s.events.emit("ratking/message", event); s.events.emit("ratking/message", event);
    await vi.waitFor(() => expect(s.sendMessage).toHaveBeenCalledOnce());
    expect(readOwnerQueue(s.session, s.home).items.map(record => record.item)).toEqual([item]);
    const before = readFileSync(ownerPath(s.session, s.home), "utf8");
    s.events.emit("ratking/message", { ...event, id: `owner-new-envelope-${s.root}`,
      body: JSON.stringify({ type: "owner", recipient: s.session, item: { ...item, cid: "different-cid", text: "Same URI cannot wake again" } }) });
    expect(readFileSync(ownerPath(s.session, s.home), "utf8")).toBe(before);
    expect(readOwnerQueue(s.session, s.home).items).toHaveLength(1);
    expect(s.sendMessage).toHaveBeenCalledOnce(); expect(s.sendUserMessage).not.toHaveBeenCalled();
  } finally { await s.stop(); }
});
