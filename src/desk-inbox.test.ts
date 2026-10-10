import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { consumeDeskAnswer, deskInbox, deskInboxCard, deskInboxItem, deskInboxUpdate } from "./desk-inbox.ts";
import { phoneItem as item, phoneAnswer as answer, phoneEvent as event, phoneIdentities as identities, phoneRatkingFake } from "./desk-record-fake.ts";

const card = deskInboxCard(item);
const queue = { id: item.itemId, ts: item.createdAt, from: "sample-owner", kind: item.kind, title: item.title, body: item.body, refs: ["https://private.example.invalid/receipt"] };
const pending = [{ item, messageTid: answer.inReplyTo, page: "sample-page" }];
const consume = (record: unknown, overrides = {}) => Effect.runPromise(consumeDeskAnswer({ identities, event: { ...event, record, ...overrides }, pending }));
const noThen = (value: unknown): void => {
  if (value && typeof value === "object") {
    expect(Object.keys(value)).not.toContain("then");
    for (const child of Object.values(value)) noThen(child);
  }
};

describe("desk inbox record contract edge", () => {
  it("refuses missing identities before transport use", async () => {
    const fake = phoneRatkingFake();
    // @ts-expect-error Required identities are also checked for JavaScript callers.
    expect(() => deskInbox({ home: "/unused", comms: fake.comms })).toThrow("identities are required");
    // @ts-expect-error Required identities are checked before reading an answer.
    await expect(Effect.runPromise(consumeDeskAnswer({ event, pending }))).rejects.toThrow("identities are required");
    expect(fake.send).not.toHaveBeenCalled();
  });
  it.each(["", "phone.example.invalid", "https://phone.example.invalid", "did:", "did:web:", "did:web:phone example.invalid"])("refuses malformed caller identities: %s", async value => {
    const fake = phoneRatkingFake();
    for (const key of ["switchboard", "phone"] as const) {
      const invalid = { ...identities, [key]: value };
      expect(() => deskInbox({ home: "/unused", comms: fake.comms, identities: invalid })).toThrow("must be did:");
      await expect(Effect.runPromise(consumeDeskAnswer({ identities: invalid, event, pending }))).rejects.toThrow("must be did:");
    }
    expect(fake.send).not.toHaveBeenCalled();
  });
  it("round trips queue and report to an explicit wire record without private ref links", () => {
    const record = deskInboxItem({ project: item.project, queueItem: queue, card });
    expect(record).toEqual(item); expect(deskInboxCard(record)).toEqual(card);
    expect(record.choices[0]?.options[0]?.outcome).toBe(card.choices[0]?.options[0]?.then);
    expect(JSON.stringify(record)).not.toContain("private.example"); noThen(record);
  });
  it("produces resolution updates and other allowed update states", () => {
    for (const state of ["resolved", "superseded", "followup"] as const) {
      const update = deskInboxUpdate({ project: item.project, itemId: item.itemId, state, text: "Resolved" });
      expect(update).toEqual({ $type: "sh.mschf.ratking.desk.update", project: item.project, itemId: item.itemId, state, text: "Resolved" }); noThen(update);
    }
  });
  it("maps values, rows and note to feedback and a resolving input", async () => {
    const result = await consume(answer);
    expect(result.feedback).toEqual({ schema: "muster-desk-feedback.v1", page: "sample-page", items: {
      "sample-001": { path: "hold", checks: ["codec"], t: "Keep it reversible." },
    } });
    expect(result.deskAnswer).toEqual({ project: item.project, id: item.itemId,
      answer: "Path: Hold (suggested)\nChecks: Codec\nNote (overrides the ticks): Keep it reversible." });
    noThen(result);
  });
  it("checks verified and the configured signed DID, never trusting from alone", async () => {
    await expect(consume(answer, { did: identities.switchboard, from: "joel-phone" })).rejects.toThrow("not allowlisted");
    await expect(consume(answer, { did: "did:web:stranger.example.invalid", from: "joel-iphone" })).rejects.toThrow("not allowlisted");
    await expect(consume(answer, { verified: false })).rejects.toThrow("Invalid desk record");
    // Canonical name, alias or another directory label is harmless when the verified DID is correct.
    expect((await consume(answer, { from: "another-phone-label" })).deskAnswer.id).toBe(item.itemId);
  });
  it.each([
    [{ ...answer, itemId: "unknown" }, "Unknown or resolved"],
    [{ ...answer, project: "other-project" }, "Unknown or resolved"],
    [{ ...answer, inReplyTo: "other-message" }, "different message"],
    [{ ...answer, values: { path: "unknown" } }, "Unknown desk axis"],
    [{ ...answer, values: { t: "injected note" } }, "Unknown desk axis"],
    [{ ...answer, values: { path: 1 } }, "Unknown desk axis"],
    [{ ...answer, rows: { checks: ["unknown"] } }, "Unknown desk row"],
    [{ ...answer, rows: { path: ["hold"] } }, "Unknown desk row"],
    [{ ...answer, rows: { checks: ["codec", "codec"] } }, "Unknown desk row"],
  ])("refuses foreign, stale and invalid feedback %#", async (body, reason) => {
    await expect(consume(body)).rejects.toThrow(reason);
  });
  it("supports note-only answers, absent rows and refuses resolved items", async () => {
    const { rows: _rows, ...note } = answer;
    const result = await consume({ ...note, values: {}, note: "Different call" });
    expect(result.feedback.items[item.itemId]).toEqual({ t: "Different call" });
    await expect(Effect.runPromise(consumeDeskAnswer({ identities, event, pending: [] }))).rejects.toThrow("Unknown or resolved");
  });
  it("refuses ambiguous cards and suggestions", () => {
    expect(() => deskInboxItem({ project: item.project, queueItem: queue, card: { ...card, extra_ids: ["other"] } })).toThrow("exactly one");
    expect(() => deskInboxItem({ project: item.project, queueItem: queue, card: { ...card, choices: card.choices.map(c => ({ ...c, suggest: "missing" })) } })).toThrow("suggestion");
    expect(() => deskInboxItem({ project: item.project, queueItem: queue, card: { ...card, choices: [...card.choices, ...card.choices] } })).toThrow("Ambiguous");
    expect(() => deskInboxItem({ project: item.project, queueItem: queue, card: { ...card, choices: card.choices.map(c => ({ ...c, key: "t" })) } })).toThrow("Ambiguous");
  });
  it("sends encrypted records as-is only to joel-phone, with no body or legacy fence", async () => {
    const fake = phoneRatkingFake();
    const api = deskInbox({ home: "/unused", identities, comms: fake.comms });
    await Effect.runPromise(api.sendItem({ project: item.project, queueItem: queue, card }));
    await Effect.runPromise(api.sendUpdate({ project: item.project, itemId: item.itemId, state: "resolved" }));
    expect(fake.send.mock.calls.map(([request]) => ({ to: request.to, record: request.record, encrypt: request.encrypt }))).toEqual([
      { to: "joel-phone", record: item, encrypt: true },
      { to: "joel-phone", record: deskInboxUpdate({ project: item.project, itemId: item.itemId, state: "resolved" }), encrypt: true },
    ]);
    for (const [request] of fake.send.mock.calls) { expect(request).not.toHaveProperty("body"); expect(request).not.toHaveProperty("fence"); }
  });
  it("fails loudly with no pi-ratking record adapter", async () => {
    const api = deskInbox({ home: "/unused", identities, comms: {} });
    expect(await Effect.runPromise(api.sendItem({ project: item.project, queueItem: queue, card }))).toMatchObject({ status: "failed", detail: expect.stringContaining("pi-ratking not loaded") });
  });
});
