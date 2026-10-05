import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isCid } from "@atproto/lex-data";
import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { receiptDelivery } from "./comms.ts";
import type { CommsDelivery } from "./runtime.ts";
import { Unsupported } from "./runtime.ts";
import { Input as AckInput, Output as AckOutput } from "./vendor/rat-king-lexicon/mailbox.ack.ts";
import { Input as SendInput, Output as SendOutput } from "./vendor/rat-king-lexicon/mailbox.send.ts";
import { Params as ListInput, Output as ListOutput } from "./vendor/rat-king-lexicon/mailbox.list.ts";
import { Main as Lease } from "./vendor/rat-king-lexicon/runtime.lease.ts";
import { Main as Profile } from "./vendor/rat-king-lexicon/agent.profile.ts";
import { Main as Theme } from "./vendor/rat-king-lexicon/desk.theme.ts";
import { SignedMessage, SigningPayload, Receipt, DeliveryStateKnownValues as deliveryStateKnownValues } from "./vendor/rat-king-lexicon/defs.ts";

const vendor = new URL("./vendor/rat-king-lexicon/", import.meta.url);
const Hashes = Schema.Record(Schema.String, Schema.String);
const VendorManifest = Schema.Struct({ repo: Schema.String, commit: Schema.String, sourcePath: Schema.String, files: Hashes, fixtures: Hashes });
const manifest = Schema.decodeUnknownSync(VendorManifest)(JSON.parse(readFileSync(new URL("VENDOR.json", vendor), "utf8")));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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

describe("Rat King v0 generated fixture contract (0e895a3)", () => {
  it("pins every generated file to the upstream commit without drift", () => {
    expect(manifest.repo).toBe("https://github.com/joelhooks/rat-king");
    expect(manifest.commit).toBe("0e895a3");
    expect(manifest.sourcePath).toBe("packages/lexicon/src");
    // VENDOR.json is the hash inventory, not a self-hashing payload.
    expect(readdirSync(vendor).sort()).toEqual([...Object.keys(manifest.files), "VENDOR.json"].sort());
    for (const [name, hash] of Object.entries(manifest.files)) {
      expect(sha256(readFileSync(new URL(name, vendor))), name).toBe(hash);
    }
  });
  it("keeps fixture bytes identical to the source pinned in VENDOR.json", () => {
    expect(Object.keys(manifest.fixtures).sort()).toEqual(readdirSync(fixtures).sort());
    for (const [name, hash] of Object.entries(manifest.fixtures)) {
      expect(sha256(readFileSync(new URL(name, fixtures))), name).toBe(hash);
    }
  });
  it("decodes bytes and links to the approved native atproto values", () => {
    const input = Schema.decodeUnknownSync(SendInput)(fixture("send.input.json"));
    expect(input.envelope.enc).toBeInstanceOf(Uint8Array);
    const profile = Schema.decodeUnknownSync(Profile)(fixture("profile.record.json"));
    expect(isCid(profile.icon?.ref)).toBe(true);
  });
  it("covers every vendored fixture", () => {
    expect(readdirSync(fixtures).sort()).toEqual(cases.map(([name]) => name).sort());
  });
  for (const [name, schema, required] of cases) {
    it(`roundtrips ${name} losslessly and refuses a broken copy`, () => {
      const original = fixture(name);
      const decode = Schema.decodeUnknownSync(schema);
      // Generated codecs decode native bytes/CIDs; losslessness is the JSON roundtrip.
      expect(Schema.encodeUnknownSync(schema)(decode(original))).toEqual(original);
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
    const input = Schema.encodeSync(SendInput)(Schema.decodeUnknownSync(SendInput)(fixture("send.input.json")));
    const extended = { ...input, envelope: { ...input.envelope, aad: { ...input.envelope.aad, future: { flag: true } } } };
    expect(Schema.encodeSync(SendInput)(Schema.decodeUnknownSync(SendInput)(extended))).toEqual(extended);
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
