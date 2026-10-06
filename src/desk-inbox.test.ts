import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it, vi } from "vitest";
import { consumeDeskAnswer, deskInbox, openDeskInbox, deskInboxCard, deskInboxItem, deskInboxUpdate } from "./desk-inbox.ts";
import { networkFencePath } from "./comms-network.ts";
import { Main as Item } from "./vendor/rat-king-lexicon/desk.item.ts";
import { Main as Answer } from "./vendor/rat-king-lexicon/desk.answer.ts";
import { Main as Update } from "./vendor/rat-king-lexicon/desk.update.ts";
import { Output } from "./vendor/rat-king-lexicon/mailbox.send.ts";
import { SigningPayload, DidDocument } from "./vendor/rat-king-lexicon/defs.ts";
import { seal, suite } from "./vendor/rat-king-envelope/envelope.ts";
import { Identity, layer, RatKingMailbox, type OpenedMessage } from "./vendor/rat-king-mailbox-client/index.ts";
import type { ReportCard } from "./desk-report.ts";

const SWITCHBOARD_DID = "did:web:switchboard.example.invalid";
const PHONE_DID = "did:web:phone.example.invalid";
const identities = { switchboard: SWITCHBOARD_DID, phone: PHONE_DID };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./vendor/rat-king-fixtures/${name}.json`, import.meta.url), "utf8"));
const item = Schema.decodeUnknownSync(Item)(fixture("desk-item"));
const answer = Schema.decodeUnknownSync(Answer)(fixture("desk-answer"));
const update = Schema.decodeUnknownSync(Update)(fixture("desk-update"));
const output = Schema.decodeUnknownSync(Output)(fixture("send.output"));
const card: ReportCard = deskInboxCard(item);
const queue = { id: item.itemId, ts: item.createdAt, from: "sample-owner", kind: item.kind, title: item.title, body: item.body, refs: ["https://private.example.invalid/receipt"] };
const pending = [{ item, messageTid: answer.inReplyTo, page: "sample-page" }];
const noThen = (value: unknown): void => {
  if (value && typeof value === "object") {
    expect(Object.keys(value)).not.toContain("then");
    for (const child of Object.values(value)) noThen(child);
  }
};
const emptyEnvelope = Schema.decodeUnknownSync(Schema.toType(SigningPayload))({
  aad: { senderDid: PHONE_DID, recipientDid: SWITCHBOARD_DID, recipientKeyId: `${SWITCHBOARD_DID}#encryption`, messageId: "3m5abcde23457" },
  body: new Uint8Array(), suite, version: 1,
});
const envelopeStub = { ...emptyEnvelope, enc: new Uint8Array(65), ciphertext: new Uint8Array(16) };
const opened = (body: unknown, senderDid = PHONE_DID): OpenedMessage => ({ body: JSON.stringify(body),
  senderDid: Schema.decodeUnknownSync(Schema.toType(SigningPayload))( { ...emptyEnvelope, aad: { ...emptyEnvelope.aad, senderDid } }).aad.senderDid,
  tid: emptyEnvelope.aad.messageId, verified: true });
const consume = (body: unknown, senderDid = PHONE_DID) => Effect.runPromise(consumeDeskAnswer({ identities, mailbox: { open: () => Effect.succeed(opened(body, senderDid)) }, envelope: envelopeStub, pending, }));

describe("desk inbox contract edge", () => {
  it("refuses missing identities at every entry point before mailbox use", async () => {
    const mailbox = { send: vi.fn(() => Effect.succeed(output)), open: vi.fn(() => Effect.succeed(opened(answer))) };
    // @ts-expect-error Required caller identities are also checked for JavaScript consumers.
    expect(() => deskInbox({ home: "/unused", mailbox })).toThrow("identities are required");
    // @ts-expect-error Required caller identities are also checked before network config is read.
    await expect(Effect.runPromise(openDeskInbox({ home: "/unused" }))).rejects.toThrow("identities are required");
    // @ts-expect-error Required caller identities are checked before opening an envelope.
    await expect(Effect.runPromise(consumeDeskAnswer({ mailbox, envelope: envelopeStub, pending }))).rejects.toThrow("identities are required");
    expect(mailbox.send).not.toHaveBeenCalled();
    expect(mailbox.open).not.toHaveBeenCalled();
  });
  it.each(["", "phone.example.invalid", "https://phone.example.invalid", "did:", "did:web:", "did:web:phone example.invalid"])("refuses malformed caller identities: %s", async value => {
    const mailbox = { send: vi.fn(() => Effect.succeed(output)), open: vi.fn(() => Effect.succeed(opened(answer))) };
    for (const key of ["switchboard", "phone"] as const) {
      const invalid = { ...identities, [key]: value };
      expect(() => deskInbox({ home: "/unused", mailbox, identities: invalid })).toThrow("must be did:");
      await expect(Effect.runPromise(openDeskInbox({ home: "/unused", identities: invalid }))).rejects.toThrow("must be did:");
      await expect(Effect.runPromise(consumeDeskAnswer({ identities: invalid, mailbox, envelope: envelopeStub, pending }))).rejects.toThrow("must be did:");
    }
    expect(mailbox.open).not.toHaveBeenCalled();
  });
  it("compares sender and recipient against the supplied identities exactly", async () => {
    const mailbox = { open: vi.fn(() => Effect.succeed(opened(answer))) };
    await expect(Effect.runPromise(consumeDeskAnswer({ identities: { ...identities, switchboard: "did:web:other.example.invalid" }, mailbox, envelope: envelopeStub, pending }))).rejects.toThrow("Switchboard identity mismatch");
    expect(mailbox.open).not.toHaveBeenCalled();
    await expect(Effect.runPromise(consumeDeskAnswer({ identities: { ...identities, phone: "did:web:other.example.invalid" }, mailbox, envelope: envelopeStub, pending }))).rejects.toThrow("not allowlisted");
  });
  it("vendors exact pinned bytes with per-file sha256, preserving earlier vendor pins", () => {
    for (const group of ["rat-king-lexicon", "rat-king-fixtures"]) {
      const manifest = Schema.decodeUnknownSync(Schema.Struct({ commit: Schema.String, files: Schema.Record(Schema.String,
        Schema.Struct({ source: Schema.String, sha256: Schema.String })) }))(JSON.parse(readFileSync(new URL(`./vendor/${group}/desk/VENDOR.json`, import.meta.url), "utf8")));
      expect(manifest.commit.startsWith("6f82c8b")).toBe(true);
      for (const [name, entry] of Object.entries(manifest.files)) {
        expect(createHash("sha256").update(readFileSync(new URL(`./vendor/${group}/${name}`, import.meta.url))).digest("hex")).toBe(entry.sha256);
      }
    }
  });
  it("round trips queue + report to the shared item fixture without private ref links", () => {
    const record = deskInboxItem({ project: item.project, queueItem: queue, card });
    expect(record).toEqual(item);
    expect(deskInboxCard(record)).toEqual(card);
    expect(record.choices[0]?.options[0]).toEqual({ id: "hold", label: "Hold", outcome: card.choices[0]?.options[0]?.then });
    noThen(record);
  });
  it("produces the shared resolution update, and other allowed update states", () => {
    expect(deskInboxUpdate({ project: item.project, itemId: item.itemId, state: "resolved", text: update.text })).toEqual(update);
    for (const state of ["resolved", "superseded", "followup"] as const) noThen(deskInboxUpdate({ project: item.project, itemId: item.itemId, state }));
  });
  it("maps phone fixture values, rows and note to desk feedback and a resolving input", async () => {
    const result = await consume(answer);
    expect(result.feedback).toEqual({ schema: "muster-desk-feedback.v1", page: "sample-page", items: {
      "sample-001": { path: "hold", checks: ["codec"], t: "Keep it reversible." },
    } });
    expect(result.deskAnswer).toEqual({ project: item.project, id: item.itemId,
      answer: "Path: Hold (suggested)\nChecks: Codec\nNote (overrides the ticks): Keep it reversible." });
    noThen(result);
  });
  it("refuses every other signer", async () => {
    await expect(consume(answer, SWITCHBOARD_DID)).rejects.toThrow("not allowlisted");
    await expect(consume(answer, "did:web:stranger.example.invalid")).rejects.toThrow("not allowlisted");
  });
  it.each([
    [{ ...answer, itemId: "unknown" }, "Unknown or resolved"],
    [{ ...answer, project: "other-project" }, "Unknown or resolved"],
    [{ ...answer, inReplyTo: "3m5abcde23457" }, "different message"],
    [{ ...answer, values: { path: "unknown" } }, "Unknown desk axis"],
    [{ ...answer, values: { t: "injected note" } }, "Unknown desk axis"],
    [{ ...answer, rows: { checks: ["unknown"] } }, "Unknown desk row"],
    [{ ...answer, rows: { path: ["hold"] } }, "Unknown desk row"],
    [{ ...answer, rows: { checks: ["codec", "codec"] } }, "Unknown desk row"],
  ])("refuses foreign, stale and invalid feedback %#", async (body, reason) => {
    await expect(consume(body)).rejects.toThrow(reason);
  });
  it("supports note-only answers, absent rows, and refuses resolved items", async () => {
    const result = await consume({ ...answer, values: {}, rows: undefined, note: "Different call" });
    expect(result.feedback.items[item.itemId]).toEqual({ t: "Different call" });
    await expect(Effect.runPromise(consumeDeskAnswer({ identities, mailbox: { open: () => Effect.succeed(opened(answer)) }, envelope: envelopeStub, pending: [] }))).rejects.toThrow("Unknown or resolved");
  });
  it("refuses ambiguous report cards and suggestions", () => {
    expect(() => deskInboxItem({ project: item.project, queueItem: queue, card: { ...card, extra_ids: ["other"] } })).toThrow("exactly one");
    expect(() => deskInboxItem({ project: item.project, queueItem: queue, card: { ...card, choices: card.choices.map(c => ({ ...c, suggest: "missing" })) } })).toThrow("suggestion");
    expect(() => deskInboxItem({ project: item.project, queueItem: queue, card: { ...card, choices: [...card.choices, ...card.choices] } })).toThrow("Ambiguous");
  });
  it("sends item and update to only the phone, borrowing the consumer fence without acquiring", async () => {
    const home = mkdtempSync(join(tmpdir(), "desk-inbox-"));
    const fence = { did: SWITCHBOARD_DID, leaseId: "3m5abcde23456", generation: 7 };
    const path = networkFencePath(home, SWITCHBOARD_DID);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(fence), { mode: 0o600 });
    const send = vi.fn(() => Effect.succeed(output));
    const api = deskInbox({ home, identities, mailbox: { send, open: () => Effect.succeed(opened(answer)) } });
    await Effect.runPromise(api.sendItem({ project: item.project, queueItem: queue, card }));
    await Effect.runPromise(api.sendUpdate({ project: item.project, itemId: item.itemId, state: "resolved", text: update.text }));
    expect(send.mock.calls).toEqual([[PHONE_DID, JSON.stringify(item), { fence }], [PHONE_DID, JSON.stringify(update), { fence }]]);
  });
});

/** Real HPKE + ES256 through the vendored mailbox; no network endpoint is called. */
async function cryptoMailbox() {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const agreement = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const identity = Schema.decodeUnknownSync(Identity)({ did: SWITCHBOARD_DID,
    signing: await crypto.subtle.exportKey("jwk", signing.privateKey), agreement: await crypto.subtle.exportKey("jwk", agreement.privateKey) });
  const phone = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const document = Schema.decodeUnknownSync(Schema.toType(DidDocument))({ id: PHONE_DID, verificationMethod: [{ id: `${PHONE_DID}#atproto`, controller: PHONE_DID,
    publicKeyJwk: await crypto.subtle.exportKey("jwk", phone.publicKey) }], authentication: [`${PHONE_DID}#atproto`], keyAgreement: [] });
  const mailbox = await Effect.runPromise(RatKingMailbox.pipe(Effect.provide(layer({ identity, documents: [document], endpoint: "https://unused.example.invalid", serviceDid: "did:web:mailbox.example.invalid" }).pipe(Layer.provide(FetchHttpClient.layer)))));
  const makeEnvelope = async (signingKey = phone.privateKey) => Effect.runPromise(seal({
    payload: Schema.decodeUnknownSync(Schema.toType(SigningPayload))({ ...emptyEnvelope, body: new TextEncoder().encode(JSON.stringify(answer)) }),
    signingKeyId: `${PHONE_DID}#atproto`, signingKey, recipientKeyId: `${SWITCHBOARD_DID}#encryption`, recipientKey: agreement.publicKey,
  }));
  return { mailbox, makeEnvelope };
}

describe("desk inbox authenticated envelopes", () => {
  it("accepts a sealed phone answer after real signature verification", async () => {
    const { mailbox, makeEnvelope } = await cryptoMailbox();
    const result = await Effect.runPromise(consumeDeskAnswer({ identities, mailbox, envelope: await makeEnvelope(), pending }));
    expect(result.feedback.items[item.itemId]?.path).toBe("hold");
  });
  it("rejects an envelope signed with a different key claiming the phone DID", async () => {
    const { mailbox, makeEnvelope } = await cryptoMailbox();
    const rogue = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    await expect(Effect.runPromise(consumeDeskAnswer({ identities, mailbox, envelope: await makeEnvelope(rogue.privateKey), pending }))).rejects.toThrow();
  });
  it("rejects altered ciphertext before parsing feedback", async () => {
    const { mailbox, makeEnvelope } = await cryptoMailbox();
    const envelope = await makeEnvelope();
    const ciphertext = new Uint8Array(envelope.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    await expect(Effect.runPromise(consumeDeskAnswer({ identities, mailbox, envelope: { ...envelope, ciphertext }, pending }))).rejects.toThrow();
  });
});
