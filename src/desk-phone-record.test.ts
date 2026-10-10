import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import muster from "./extension-main.ts";
import { sendDeskPhone } from "./desk-phone.ts";
import { deskInboxCard } from "./desk-inbox.ts";
import { deskPhoneConfigPath, deskPhoneStatePath } from "./desk-phone-store.ts";
import { appendDesk, queuePath, readDesk } from "./desk.ts";
import { harness } from "./test-support.ts";
import { phoneItem, phoneEvent, phoneIdentities, phoneRatkingFake } from "./desk-record-fake.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("the extension handles phone records once, never injects them as model text, and unregisters at shutdown", async () => {
  const h = harness(); const fake = phoneRatkingFake();
  vi.stubEnv("HOME", h.home); vi.stubEnv("RATKING_NAME", "switchboard");
  vi.stubEnv("MUSTER_PROJECT", ""); vi.stubEnv("MUSTER_MACHINE", "local"); vi.stubEnv("MUSTER_ROLE", "boss");
  const path = deskPhoneConfigPath(h.home); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(phoneIdentities), { mode: 0o600 });
  appendDesk(queuePath("rats-nest", h.home), { id: phoneItem.itemId, ts: phoneItem.createdAt, from: "desk", kind: phoneItem.kind, title: phoneItem.title });
  await Effect.runPromise(sendDeskPhone({ home: h.home, identities: phoneIdentities, comms: fake.comms, card: deskInboxCard(phoneItem), page: "record-test" }));
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const notify = vi.fn(); const sendUserMessage = vi.fn(); const sendMessage = vi.fn();
  const pi = {
    registerTool() {}, registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
    getFlag: () => undefined, getThinkingLevel: () => "medium", setThinkingLevel() {}, getAllTools: () => [{ name: "ratking" }],
    sendMessage, sendUserMessage, events: fake.events,
    on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, [...(hooks.get(event) ?? []), handler]),
  };
  const ctx = { cwd: h.home, hasUI: false, isIdle: () => true, ui: { notify, setStatus() {}, setWidget() {} },
    sessionManager: { getSessionId: () => "switchboard-session", getBranch: () => [], getEntries: () => [], getHeader: () => null } };
  muster(pi as never);
  const lifecycle = async (event: string) => { for (const handler of hooks.get(event) ?? []) await handler({}, ctx); };
  try {
    await lifecycle("session_start"); await lifecycle("session_start");
    fake.events.emit("ratking/record", { ...phoneEvent, id: "wrong-signer-record", did: "did:web:impostor.example.invalid", from: "joel-phone" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(readDesk(queuePath("rats-nest", h.home)).some(row => row.resolves)).toBe(false);
    notify.mockClear();
    fake.events.emit("ratking/record", { ...phoneEvent, id: "unverified-record", verified: false });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(readDesk(queuePath("rats-nest", h.home)).some(row => row.resolves)).toBe(false);
    notify.mockClear();
    fake.events.emit("ratking/record", phoneEvent);
    fake.events.emit("ratking/record", phoneEvent); // Concurrent replay must not enqueue another handler.
    await vi.waitFor(() => expect(JSON.parse(readFileSync(deskPhoneStatePath(h.home), "utf8")).entries[phoneItem.itemId].state).toBe("closed"));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(readDesk(queuePath("rats-nest", h.home)).filter(row => row.resolves)).toHaveLength(1);
    expect(fake.send).toHaveBeenCalledTimes(2);
    expect(sendUserMessage).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
  } finally { await lifecycle("session_shutdown"); }
  notify.mockClear(); fake.events.emit("ratking/record", phoneEvent);
  expect(notify).not.toHaveBeenCalled(); expect(fake.send).toHaveBeenCalledTimes(2);
});
