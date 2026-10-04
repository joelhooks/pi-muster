import { readFileSync, readdirSync } from "node:fs";
import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { receiptDelivery } from "./comms.ts";
import type { CommsDelivery } from "./runtime.ts";
import { Unsupported } from "./runtime.ts";
import { AckInput, AckOutput, Aad, AtUri, Bytes, Cid, Datetime, Lease, ListInput, ListOutput, MessageRef, Receipt, SendInput, SendOutput, Suite, deliveryStateKnownValues, integer, object, Uri } from "./ratking-lexicon.ts";

// Fixture-only auxiliary shapes. NetworkComms has no signing/profile/theme API.
const SignedMessage = object({ canonicalSigningBytes: Bytes, appSignature: object({ algorithm: Schema.String, keyId: Uri, signature: Bytes, publicKeyMultibase: Schema.optionalKey(Schema.String) }) });
const SigningPayload = object({ version: integer(1), suite: Suite, aad: Aad, body: Bytes, createdAt: Schema.optionalKey(Datetime), replyTo: Schema.optionalKey(MessageRef) });
const Profile = object({
  $type: Schema.Literal("sh.mschf.ratking.agent.profile"),
  birthContext: object({ operator: Schema.String, project: Schema.String, createdAt: Schema.optionalKey(Datetime) }),
  genesisCid: Cid, callSign: Schema.optionalKey(Schema.String), emoji: Schema.optionalKey(Schema.String), themeRef: Schema.optionalKey(AtUri), updatedAt: Schema.optionalKey(Datetime),
  icon: Schema.optionalKey(object({ $type: Schema.Literal("blob"), ref: object({ $link: Cid }), mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]), size: integer(1, 1_000_000) })),
});
const Theme = object({ $type: Schema.Literal("sh.mschf.ratking.desk.theme"), universe: Schema.String, tone: Schema.optionalKey(Schema.String), namePool: Schema.optionalKey(Schema.Array(Schema.String)), updatedAt: Schema.optionalKey(Datetime) });
const fixtures = new URL("./__fixtures__/ratking-v0/", import.meta.url);
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const cases = [
  ["send.input.json", SendInput, "envelope"], ["send.output.json", SendOutput, "receipt"],
  ["ack.input.json", AckInput, "generation"], ["ack.output.json", AckOutput, "receipt"],
  ["list.params.json", ListInput, "recipientDid"], ["list.output.json", ListOutput, "events"],
  ["lease.object.json", Lease, "leaseId"], ["profile.record.json", Profile, "genesisCid"],
  ["theme.record.json", Theme, "universe"], ["signed-message.object.json", SignedMessage, "appSignature"],
  ["signing-payload.object.json", SigningPayload, "body"],
] as const;

describe("Rat King v0 fixture contract (80bf0c0)", () => {
  it("covers every vendored fixture", () => {
    expect(readdirSync(fixtures).sort()).toEqual(cases.map(([name]) => name).sort());
  });
  for (const [name, schema, required] of cases) {
    it(`decodes ${name} losslessly and refuses a broken copy`, () => {
      const original = fixture(name);
      const decode = Schema.decodeUnknownSync(schema);
      expect(decode(original)).toEqual(original);
      const broken = JSON.parse(JSON.stringify(original));
      delete broken[required];
      expect(() => decode(broken)).toThrow();
    });
  }
  it("carries both fencing fields and refuses invalid numbers", () => {
    const lease = Schema.decodeUnknownSync(Lease)(fixture("lease.object.json"));
    expect(lease).toMatchObject({ leaseId: "3jzfcijpj2z2b", generation: 1 });
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => Schema.decodeUnknownSync(Lease)({ ...lease, generation })).toThrow();
      expect(() => Schema.decodeUnknownSync(AckInput)({ ...Schema.decodeUnknownSync(AckInput)(fixture("ack.input.json")), generation })).toThrow();
    }
    expect(() => Schema.decodeUnknownSync(AckInput)({ ...Schema.decodeUnknownSync(AckInput)(fixture("ack.input.json")), leaseId: undefined })).toThrow();
  });
  it("validates known union tags strictly without falling through to unknown", () => {
    const lease = Schema.decodeUnknownSync(Lease)(fixture("lease.object.json"));
    expect(() => Schema.decodeUnknownSync(Lease)({ ...lease, harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: 7 } })).toThrow();
    expect(() => Schema.decodeUnknownSync(Lease)({ ...lease, harness: { $type: "sh.mschf.ratking.runtime.lease#other" } })).toThrow();
    const future = { ...lease, harness: { $type: "example.future", binding: "opaque" } };
    expect(Schema.decodeUnknownSync(Lease)(future)).toEqual(future);
    expect(() => Schema.decodeUnknownSync(ListOutput)({ throughSeq: 1, events: [{ $type: "sh.mschf.ratking.defs#receiptEvent", seq: 1 }] })).toThrow();
    const futureLog = { throughSeq: 1, events: [{ $type: "example.future", opaque: true }] };
    expect(Schema.decodeUnknownSync(ListOutput)(futureLog)).toEqual(futureLog);
  });
  it("preserves unknown nested fields without accepting floats", () => {
    const input = Schema.decodeUnknownSync(SendInput)(fixture("send.input.json"));
    const extended = { ...input, envelope: { ...input.envelope, aad: { ...input.envelope.aad, future: { flag: true } } } };
    expect(Schema.decodeUnknownSync(SendInput)(extended)).toEqual(extended);
    expect(() => Schema.decodeUnknownSync(SendInput)({ ...extended, future: 1.5 })).toThrow();
    expect(() => Schema.decodeUnknownSync(SendInput)({ ...input, envelope: { ...input.envelope, enc: { $bytes: "" } } })).toThrow();
    expect(() => Schema.decodeUnknownSync(ListInput)({ recipientDid: input.envelope.aad.recipientDid, limit: 101 })).toThrow();
  });
});

describe("receipt to CommsDelivery", () => {
  const base = Schema.decodeUnknownSync(SendOutput)(fixture("send.output.json")).receipt;
  it.each(deliveryStateKnownValues)("maps %s independently of wake", async state => {
    const receipt = Schema.decodeUnknownSync(Receipt)({ ...base, state, detail: "receipt detail", woke: state !== "delivered", wakeReason: "separate" });
    expect(await Effect.runPromise(receiptDelivery(receipt))).toEqual({ status: state, detail: "receipt detail" });
  });
  it("decodes an unknown state but returns typed Unsupported, never a delivery cast", async () => {
    const receipt = Schema.decodeUnknownSync(Receipt)({ ...base, state: "future-success", woke: true });
    const result = receiptDelivery(receipt);
    expectTypeOf(result).toEqualTypeOf<Effect.Effect<CommsDelivery, Unsupported>>();
    await expect(Effect.runPromise(result)).rejects.toBeInstanceOf(Unsupported);
    expect(await Effect.runPromise(Effect.result(result))).toMatchObject({ _tag: "Failure", failure: { _tag: "Unsupported" } });
  });
});
