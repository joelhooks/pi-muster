import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { deskInboxCard } from "./desk-inbox.ts";
import { sendDeskPhone, syncDeskPhone, receiveDeskPhone, dispatchDeskPhone, deskPhoneSnapshot } from "./desk-phone.ts";
import { deskPhoneConfigPath, deskPhoneStatePath, readDeskPhoneConfig } from "./desk-phone-store.ts";
import { decodeDeskPhoneState, decodeDeskPhoneQuarantine } from "./domain.ts";
import { appendDesk, queuePath, readDesk } from "./desk.ts";
import { networkFencePath } from "./phone-mailbox.ts";
import { CommsError } from "./runtime.ts";
import { Output as ListOutput } from "./vendor/rat-king-lexicon/mailbox.list.ts";
import { Main as Lease } from "./vendor/rat-king-lexicon/runtime.lease.ts";
import { Main as Item } from "./vendor/rat-king-lexicon/desk.item.ts";
import { Output, type OutputValue } from "./vendor/rat-king-lexicon/mailbox.send.ts";
import { MailboxClientError } from "./vendor/rat-king-mailbox-client/error.ts";
import { EncryptedEnvelope, MessageEvent } from "./vendor/rat-king-lexicon/defs.ts";
import { Main as Answer } from "./vendor/rat-king-lexicon/desk.answer.ts";
import type { OpenedMessage, SendOptions } from "./vendor/rat-king-mailbox-client/index.ts";
import { projectOpen, agentLaunchForeground } from "./ops.ts";
import { load } from "./store.ts";
import { deskPhone, registryPath } from "./switchboard-ops.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./vendor/rat-king-fixtures/${name}.json`, import.meta.url), "utf8"));
const identities = { switchboard: "did:web:switchboard.example.invalid", phone: "did:web:phone.example.invalid" };
const item = Schema.decodeUnknownSync(Item)({ ...Schema.decodeUnknownSync(Item)(fixture("desk-item")), project: "rats-nest" });
const card = deskInboxCard(item);
const receipt = Schema.decodeUnknownSync(Output)(fixture("send.output"));
const answer = Schema.decodeUnknownSync(Answer)({ ...Schema.decodeUnknownSync(Answer)(fixture("desk-answer")), project: "rats-nest", inReplyTo: receipt.receipt.message.messageId });
const firstEvent = Schema.decodeUnknownSync(Schema.toType(MessageEvent))(Schema.decodeUnknownSync(ListOutput)(fixture("list.output")).events[0]);
const baseEnvelope = firstEvent.envelope;
const envelope = { ...baseEnvelope, aad: { ...baseEnvelope.aad, senderDid: Schema.decodeUnknownSync(EncryptedEnvelope.schema.fields.aad.schema.fields.senderDid)(identities.phone), recipientDid: Schema.decodeUnknownSync(EncryptedEnvelope.schema.fields.aad.schema.fields.recipientDid)(identities.switchboard) } };
const opened: OpenedMessage = { senderDid: envelope.aad.senderDid, tid: envelope.aad.messageId, body: JSON.stringify(answer), verified: true };
const privateFile = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };
function setup() {
  const h = harness();
  privateFile(deskPhoneConfigPath(h.home), identities);
  privateFile(networkFencePath(h.home, identities.switchboard), { did: identities.switchboard, leaseId: "3m5abcde23456", generation: 1 });
  appendDesk(queuePath("rats-nest", h.home), { id: item.itemId, ts: item.createdAt, from: "desk", kind: item.kind, title: item.title, body: item.body });
  const send = vi.fn((_to: string, _body: string, _options?: SendOptions): Effect.Effect<OutputValue, MailboxClientError> => Effect.succeed(receipt));
  const mailbox = { send, open: () => Effect.succeed(opened) };
  const context = { home: h.home, identities, mailbox };
  const state = async () => decodeDeskPhoneState(JSON.parse(readFileSync(deskPhoneStatePath(h.home), "utf8")));
  const deliver = () => runWith(h, receiveDeskPhone({ ...context, envelope, opened }));
  const sendItem = () => runWith(h, sendDeskPhone({ ...context, card, page: "phone-rats-nest" }));
  return { h, send, context, state, deliver, sendItem };
}

describe("desk phone routing", () => {
  it("sends once, records pending, resolves through deskAnswer, nudges owner and closes thread with receipt", async () => {
    const s = setup();
    const dir = makeRepo(join(s.h.root, "rats-nest"));
    await runWith(s.h, projectOpen({ dir, slug: "rats-nest", outcome: "o", reviewTrigger: "r", nextAction: "n", space: "w1", ephemeral: true, desk: true, musterExtension: "/m", deskExtension: null }));
    privateFile(registryPath(s.h.home), { slug: "rats-nest", dir, spaceId: "w1", ts: s.h.now.toISOString() });
    await runWith(s.h, agentLaunchForeground(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: dir }));
    const desk = (await runWith(s.h, load(dir))).agents.find(row => row.name === "desk")!;
    s.h.live = [desk.sessionId];
    await s.sendItem();
    expect((await s.state()).entries[item.itemId]?.state).toBe("pending");
    expect((await s.sendItem()).action).toBe("duplicate");
    expect(s.send).toHaveBeenCalledOnce();
    expect(JSON.parse(s.send.mock.calls[0]![1])).toMatchObject({ $type: "sh.mschf.ratking.desk.item", choices: [{ suggest: "hold" }] });
    await s.deliver();
    expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
    expect(s.h.sent.some(row => row.to === desk.sessionId && row.message.includes("Joel answered"))).toBe(true);
    expect(JSON.parse(s.send.mock.calls[1]![1])).toMatchObject({ $type: "sh.mschf.ratking.desk.update", state: "resolved", itemId: item.itemId });
    expect(statSync(deskPhoneStatePath(s.h.home)).mode & 0o777).toBe(0o600);
    await s.deliver();
    await runWith(s.h, receiveDeskPhone({ ...s.context, envelope, opened: { ...opened, tid: Schema.decodeUnknownSync(EncryptedEnvelope.schema.fields.aad.schema.fields.messageId)("3m5abcde23457") } }));
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
  });
  it("serializes concurrent tool and consumer state writes without a busy refusal or duplicate resolution", async () => {
    const s = setup();
    const result = await runWith(s.h, Effect.all([sendDeskPhone({ ...s.context, card, page: "page" }), sendDeskPhone({ ...s.context, card, page: "page" })], { concurrency: "unbounded" }));
    expect(result.map(row => row.action).sort()).toEqual(["duplicate", "sent"]);
    await runWith(s.h, Effect.all([receiveDeskPhone({ ...s.context, envelope, opened }), receiveDeskPhone({ ...s.context, envelope, opened })], { concurrency: "unbounded" }));
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
  });
  it("refuses a foreign signer without resolving and reports the failure", async () => {
    const s = setup(); await s.sendItem();
    const rogue = { ...opened, senderDid: envelope.aad.recipientDid };
    await expect(runWith(s.h, receiveDeskPhone({ ...s.context, envelope, opened: rogue }))).rejects.toThrow("not allowlisted");
    const notice = await runWith(s.h, dispatchDeskPhone({ ...s.context, ownDid: identities.switchboard, envelope, opened: rogue }));
    expect(notice).toContain("answer failed");
    expect((await s.state()).entries[item.itemId]?.state).toBe("pending");
    expect(readDesk(queuePath("rats-nest", s.h.home)).some(row => row.resolves)).toBe(false);
  });
  it("closes a thread resolved in chat, once", async () => {
    const s = setup(); await s.sendItem();
    appendDesk(queuePath("rats-nest", s.h.home), { id: "elsewhere", from: "desk", ts: item.createdAt, title: "Resolved", kind: "done", resolves: item.itemId });
    await runWith(s.h, syncDeskPhone(s.context));
    await runWith(s.h, syncDeskPhone(s.context));
    expect(s.send).toHaveBeenCalledTimes(2);
    expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
  });
  it("keeps a failed update retryable without resolving twice", async () => {
    const s = setup(); await s.sendItem();
    s.send.mockImplementationOnce(() => Effect.fail(new MailboxClientError({ reason: "transport failed" })));
    await expect(s.deliver()).rejects.toThrow("update send failed");
    expect((await s.state()).entries[item.itemId]?.state).toBe("resolved");
    await s.deliver();
    expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
  });
  it("resumes a persisted ruling after a crash before the queue write", async () => {
    const s = setup(); await s.sendItem();
    const state = await s.state(); const entry = state.entries[item.itemId];
    if (!entry || entry.state !== "pending") throw new Error("pending fixture required");
    privateFile(deskPhoneStatePath(s.h.home), { ...state, entries: { [item.itemId]: { ...entry, state: "answered", answer: { tid: opened.tid, text: "Hold. Keep it reversible." } } } });
    await runWith(s.h, syncDeskPhone(s.context));
    expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
    expect(readDesk(queuePath("rats-nest", s.h.home)).filter(row => row.resolves === item.itemId)).toHaveLength(1);
  });
  it("reports a negative update receipt and leaves resolution retryable", async () => {
    const s = setup(); await s.sendItem();
    s.send.mockImplementationOnce(() => Effect.succeed({ ...receipt, receipt: { ...receipt.receipt, state: "failed" } }));
    await expect(s.deliver()).rejects.toThrow("update send returned failed; receipt");
    expect((await s.state()).entries[item.itemId]?.state).toBe("resolved");
    await runWith(s.h, syncDeskPhone(s.context));
    expect((await s.state()).entries[item.itemId]?.state).toBe("closed");
  });
  it("never blindly retries an ambiguous item send", async () => {
    const s = setup(); s.send.mockImplementationOnce(() => Effect.fail(new MailboxClientError({ reason: "timeout after acceptance" })));
    await expect(s.sendItem()).rejects.toThrow("item send failed");
    await expect(s.sendItem()).rejects.toThrow("reconcile the mailbox");
    expect(s.send).toHaveBeenCalledOnce();
    expect((await s.state()).entries[item.itemId]?.state).toBe("sending");
  });
  it("refuses missing or public config, changed sidecar identities and unsafe sidecar permissions", async () => {
    const s = setup();
    await expect(Effect.runPromise(readDeskPhoneConfig(harness().home))).rejects.toThrow("desk-inbox.json");
    await expect(runWith(harness(), deskPhone({ action: "poll" }))).rejects.toThrow("desk-inbox.json");
    chmodSync(deskPhoneConfigPath(s.h.home), 0o644);
    await expect(Effect.runPromise(readDeskPhoneConfig(s.h.home))).rejects.toThrow("0600");
    await s.sendItem();
    await expect(Effect.runPromise(deskPhoneSnapshot(s.h.home, { ...identities, phone: identities.switchboard }))).rejects.toThrow("different identities");
    chmodSync(deskPhoneStatePath(s.h.home), 0o644);
    await expect(Effect.runPromise(deskPhoneSnapshot(s.h.home, identities))).rejects.toThrow("not private");
  });
  ;
  ;
  ;
  it("refuses absent, unrelated and unmarked cards before sending", async () => {
    const s = setup();
    await expect(runWith(s.h, sendDeskPhone({ ...s.context, card: { ...card, id: "unknown" }, page: "page" }))).rejects.toThrow("open rats-nest");
    await expect(runWith(s.h, sendDeskPhone({ ...s.context, card: { ...card, choices: card.choices.map(choice => ({ ...choice, suggest: "unknown" })) }, page: "page" }))).rejects.toThrow("suggestion");
    expect(s.send).not.toHaveBeenCalled();
  });
});
