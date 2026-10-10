import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { deskInboxCard } from "./desk-inbox.ts";
import { sendDeskPhone, syncDeskPhone, receiveDeskPhone, dispatchDeskPhone, deskPhoneSnapshot } from "./desk-phone.ts";
import { deskPhoneConfigPath, deskPhoneStatePath, readDeskPhoneConfig } from "./desk-phone-store.ts";
import { decodeDeskPhoneState } from "./domain.ts";
import { appendDesk, queuePath, readDesk } from "./desk.ts";
import { Comms } from "./runtime.ts";
import { projectOpen, agentLaunchForeground } from "./ops.ts";
import { load } from "./store.ts";
import { deskPhone, registryPath } from "./switchboard-ops.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { phoneItem as item, phoneEvent as event, phoneIdentities as identities, phoneRatkingFake } from "./desk-record-fake.ts";

const card = deskInboxCard(item);
const privateFile = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };
function setup() {
  const h = harness(); const fake = phoneRatkingFake();
  privateFile(deskPhoneConfigPath(h.home), identities);
  appendDesk(queuePath("rats-nest", h.home), { id: item.itemId, ts: item.createdAt, from: "desk", kind: item.kind, title: item.title, body: item.body });
  const context = { home: h.home, identities, comms: fake.comms };
  const state = async () => decodeDeskPhoneState(JSON.parse(readFileSync(deskPhoneStatePath(h.home), "utf8")));
  const deliver = () => runWith(h, receiveDeskPhone({ ...context, event }));
  const sendItem = () => runWith(h, sendDeskPhone({ ...context, card, page: "phone-rats-nest" }));
  const tool = (action: "send" | "sync" | "poll") => runWith(h, deskPhone({ action, card }).pipe(Effect.provideService(Comms, fake.comms)));
  return { h, ...fake, context, state, deliver, sendItem, tool };
}

describe("desk phone over pi-ratking records", () => {
  it("sends once, resolves through deskAnswer, nudges owner and closes with a record receipt", async () => {
    const s = setup(); const dir = makeRepo(join(s.h.root, "rats-nest"));
    await runWith(s.h, projectOpen({ dir, slug: "rats-nest", outcome: "o", reviewTrigger: "r", nextAction: "n", space: "w1", ephemeral: true, desk: true, musterExtension: "/m", deskExtension: null }));
    privateFile(registryPath(s.h.home), { slug: "rats-nest", dir, spaceId: "w1", ts: s.h.now.toISOString() });
    await runWith(s.h, agentLaunchForeground(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: dir }));
    const desk = (await runWith(s.h, load(dir))).agents.find(row => row.name === "desk")!; s.h.live = [desk.sessionId];
    await s.sendItem(); expect((await s.state()).entries[item.itemId]?.state).toBe("pending");
    expect((await s.sendItem()).action).toBe("duplicate"); expect(s.send).toHaveBeenCalledOnce();
    expect(s.send.mock.calls[0]![0]).toMatchObject({ to: "joel-phone", record: { $type: "sh.mschf.ratking.desk.item", choices: [{ suggest: "hold" }] }, encrypt: true });
    await s.deliver(); expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
    expect(s.h.sent.some(row => row.to === desk.sessionId && row.message.includes("Joel answered"))).toBe(true);
    expect(s.send.mock.calls[1]![0].record).toMatchObject({ $type: "sh.mschf.ratking.desk.update", state: "resolved", itemId: item.itemId });
    expect(statSync(deskPhoneStatePath(s.h.home)).mode & 0o777).toBe(0o600);
    await s.deliver(); await runWith(s.h, receiveDeskPhone({ ...s.context, event: { ...event, id: "answer-replay" } }));
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
  });
  it("serializes concurrent tool and record writes with no duplicate resolution", async () => {
    const s = setup();
    const result = await runWith(s.h, Effect.all([sendDeskPhone({ ...s.context, card, page: "page" }), sendDeskPhone({ ...s.context, card, page: "page" })], { concurrency: "unbounded" }));
    expect(result.map(row => row.action).sort()).toEqual(["duplicate", "sent"]);
    await runWith(s.h, Effect.all([receiveDeskPhone({ ...s.context, event }), receiveDeskPhone({ ...s.context, event })], { concurrency: "unbounded" }));
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
  });
  it.each([{ did: identities.switchboard, from: "joel-phone" }, { verified: false }])("refuses foreign or unverified records without resolving %#", async overrides => {
    const s = setup(); await s.sendItem(); const rogue = { ...event, ...overrides };
    await expect(runWith(s.h, receiveDeskPhone({ ...s.context, event: rogue }))).rejects.toThrow();
    const notice = await runWith(s.h, dispatchDeskPhone({ ...s.context, ownDid: identities.switchboard, event: rogue }));
    expect(notice).toContain("answer failed"); expect((await s.state()).entries[item.itemId]?.state).toBe("pending");
    expect(readDesk(queuePath("rats-nest", s.h.home)).some(row => row.resolves)).toBe(false);
    expect(s.send).toHaveBeenCalledOnce();
  });
  it("closes a thread resolved in chat once", async () => {
    const s = setup(); await s.sendItem();
    appendDesk(queuePath("rats-nest", s.h.home), { id: "elsewhere", from: "desk", ts: item.createdAt, title: "Resolved", kind: "done", resolves: item.itemId });
    await runWith(s.h, syncDeskPhone(s.context)); await runWith(s.h, syncDeskPhone(s.context));
    expect(s.send).toHaveBeenCalledTimes(2); expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
  });
  it("keeps a negative update retryable without resolving twice", async () => {
    const s = setup(); await s.sendItem();
    s.send.mockImplementationOnce(request => ({ requestId: request.requestId, status: "not-delivered", code: "TransportUnavailable", reason: "try again" }));
    await expect(s.deliver()).rejects.toThrow("update send returned failed");
    expect((await s.state()).entries[item.itemId]?.state).toBe("resolved");
    await s.deliver(); expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
  });
  it("resumes a persisted ruling after a crash before the queue write", async () => {
    const s = setup(); await s.sendItem(); const state = await s.state(); const entry = state.entries[item.itemId];
    if (!entry || entry.state !== "pending") throw new Error("pending required");
    privateFile(deskPhoneStatePath(s.h.home), { ...state, entries: { [item.itemId]: { ...entry, state: "answered", answer: { tid: event.id, text: "Hold. Keep it reversible." } } } });
    await runWith(s.h, syncDeskPhone(s.context)); expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
  });
  it.each(["timeout", "negative", "missing-id"] as const)("never blindly retries an uncertain item send: %s", async mode => {
    const s = setup();
    s.send.mockImplementationOnce(request => mode === "timeout" ? { requestId: "unrelated", status: "delivered" }
      : mode === "missing-id" ? { requestId: request.requestId, status: "delivered" }
      : { requestId: request.requestId, status: "not-delivered", code: "Refused" });
    await expect(s.sendItem()).rejects.toThrow("item send returned");
    await expect(s.sendItem()).rejects.toThrow("reconcile the mailbox");
    expect(s.send).toHaveBeenCalledOnce(); expect((await s.state()).entries[item.itemId]?.state).toBe("sending");
  });
  it("keeps previously sent pending threads readable across the receipt format change", async () => {
    const s = setup();
    privateFile(deskPhoneStatePath(s.h.home), { identities, entries: { [item.itemId]: { state: "pending", item, page: "old-page", messageTid: "item-1",
      receipt: { receipt: { state: "delivered", message: { messageId: "item-1", senderDid: identities.switchboard, recipientDid: identities.phone } } },
    } } });
    expect((await s.sendItem()).action).toBe("duplicate"); expect(s.send).not.toHaveBeenCalled();
    await s.deliver(); expect((await s.state()).entries[item.itemId]?.state).toBe("closed"); expect(s.send).toHaveBeenCalledOnce();
  });
  it("refuses unsafe config, changed identities and public sidecars", async () => {
    const s = setup();
    await expect(Effect.runPromise(readDeskPhoneConfig(harness().home))).rejects.toThrow("desk-inbox.json");
    await expect(runWith(harness(), deskPhone({ action: "poll" }))).rejects.toThrow("desk-inbox.json");
    chmodSync(deskPhoneConfigPath(s.h.home), 0o644); await expect(Effect.runPromise(readDeskPhoneConfig(s.h.home))).rejects.toThrow("0600");
    await s.sendItem();
    await expect(Effect.runPromise(deskPhoneSnapshot(s.h.home, { ...identities, phone: identities.switchboard }))).rejects.toThrow("different identities");
    chmodSync(deskPhoneStatePath(s.h.home), 0o644); await expect(Effect.runPromise(deskPhoneSnapshot(s.h.home, identities))).rejects.toThrow("not private");
  });
  it("routes tool send, poll and sync through the current pi-ratking identity without a legacy cache or lease", async () => {
    const s = setup(); await s.tool("send");
    const poll = await s.tool("poll"); expect(poll).toHaveProperty("receiving", expect.stringContaining("ratking/record"));
    await s.tool("sync"); expect(s.send).toHaveBeenCalledOnce();
    await expect(runWith(s.h, deskPhone({ action: "send", card }).pipe(Effect.provideService(Comms, { ...s.comms, status: () => Effect.succeed(undefined) })))).rejects.toThrow("pi-ratking not loaded");
    await expect(runWith(s.h, deskPhone({ action: "send", card }).pipe(Effect.provideService(Comms, { ...s.comms, status: () => Effect.succeed({ requestId: "s", name: "foreign", did: identities.phone, reader: "live" }) })))).rejects.toThrow("configured DID differs");
    expect(s.send).toHaveBeenCalledOnce();
  });
  it("refuses absent, unrelated and unmarked cards before sending", async () => {
    const s = setup();
    await expect(runWith(s.h, sendDeskPhone({ ...s.context, card: { ...card, id: "unknown" }, page: "page" }))).rejects.toThrow("open rats-nest");
    await expect(runWith(s.h, sendDeskPhone({ ...s.context, card: { ...card, choices: card.choices.map(choice => ({ ...choice, suggest: "unknown" })) }, page: "page" }))).rejects.toThrow("suggestion");
    expect(s.send).not.toHaveBeenCalled();
  });
});
