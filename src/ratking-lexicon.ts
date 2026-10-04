// temporary; replaced by the generated @rat-king/lexicon
import { Schema } from "effect";

// Draft v0 at 80bf0c0. JSON wire shapes only: no crypto, auth or lease authority.
export const deliveryStateKnownValues = ["accepted", "queued", "delivered", "acked", "expired", "failed"] as const;
export type KnownDeliveryState = typeof deliveryStateKnownValues[number];
export const DeliveryState = Schema.String; // Lexicon knownValues is open, not an enum.

export type LexValue = null | boolean | string | number | readonly LexValue[] | { readonly [key: string]: LexValue };
function isLexValue(value: unknown): value is LexValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(isLexValue);
  return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isLexValue);
}
const LexValue = Schema.declare(isLexValue);
/** Keep future fields. Never reconstruct signed data from a stripped projection. */
export const object = <const F extends Schema.Struct.Fields>(fields: F) => Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, LexValue)]);
export const Did = Schema.declare((value: unknown): value is `did:${string}` => typeof value === "string" && /^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._%-]$/.test(value));
export const Tid = Schema.String.check(Schema.isPattern(/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/));
export const Datetime = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/), Schema.makeFilter(value => Number.isFinite(Date.parse(value))));
export const Uri = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]+$/));
export const AtUri = Schema.String.check(Schema.isPattern(/^at:\/\/[^\s/]+(?:\/[^\s/]+(?:\/[^\s/]+)?)?$/));
// Syntax only; the generated package will own official format validators.
export const Cid = Schema.String.check(Schema.isPattern(/^(?:b[a-z2-7]+|z[1-9A-HJ-NP-Za-km-z]+|Qm[1-9A-HJ-NP-Za-km-z]{44})$/));
export const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) => Schema.Int.check(Schema.isBetween({ minimum, maximum }));
export const Bytes = object({ $bytes: Schema.String.check(Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/)) });
const NonemptyBytes = Bytes.check(Schema.makeFilter(value => Buffer.from(value.$bytes, "base64").length > 0));
export const Suite = object({ kemId: integer(0, 65535), kdfId: integer(0, 65535), aeadId: integer(0, 65535) });
export const Aad = object({ senderDid: Did, recipientDid: Did, messageId: Tid, recipientKeyId: Uri, expiresAt: Schema.optionalKey(Datetime) });
export const Envelope = object({ version: integer(1), suite: Suite, enc: NonemptyBytes, ciphertext: NonemptyBytes, aad: Aad });
export const MessageRef = object({ senderDid: Did, messageId: Tid, uri: Schema.optionalKey(AtUri), cid: Schema.optionalKey(Cid) });
export type MessageRef = typeof MessageRef.Type;
export const Receipt = object({
  message: MessageRef, recipientDid: Did, state: DeliveryState, seq: integer(1),
  recordedAt: Schema.optionalKey(Datetime), detail: Schema.optionalKey(Schema.String),
  woke: Schema.optionalKey(Schema.Boolean), wakeReason: Schema.optionalKey(Schema.String),
});
export type Receipt = typeof Receipt.Type;

const leasePrefix = "sh.mschf.ratking.runtime.lease#";
const bindings = { sessionId: Schema.optionalKey(Schema.String), paneId: Schema.optionalKey(Schema.String), executionId: Schema.optionalKey(Schema.String) };
const harnessTags = ["pi", "claude", "codex", "opencode", "other"].map(kind => leasePrefix + kind);
const UnknownHarness = object({ $type: Schema.String.check(Schema.makeFilter(tag => !harnessTags.includes(tag))) });
export const Harness = Schema.Union([
  ...["pi", "claude", "codex", "opencode"].map(kind => object({ $type: Schema.Literal(leasePrefix + kind), ...bindings })),
  object({ $type: Schema.Literal(leasePrefix + "other"), kind: Schema.String, ...bindings }),
  UnknownHarness,
]);
export const Lease = object({ did: Did, leaseId: Tid, generation: integer(1), expiresAt: Datetime, harness: Harness, issuedAt: Schema.optionalKey(Datetime) });
export type Lease = typeof Lease.Type;
export type LeaseFence = Pick<Lease, "did" | "leaseId" | "generation">;
export const SendInput = object({ envelope: Envelope });
export type SendInput = typeof SendInput.Type;
export const SendOutput = object({ receipt: Receipt });
export type SendOutput = typeof SendOutput.Type;
export const AckInput = object({ message: MessageRef, recipientDid: Did, leaseId: Tid, generation: integer(1) });
export type AckInput = typeof AckInput.Type;
export const AckOutput = SendOutput;
export type AckOutput = typeof AckOutput.Type;
export const ListInput = object({ recipientDid: Did, cursor: Schema.optionalKey(Schema.String), afterSeq: Schema.optionalKey(integer(0)), limit: Schema.optionalKey(integer(1, 100)) });
export type ListInput = typeof ListInput.Type;
const messageTag = "sh.mschf.ratking.defs#messageEvent";
const receiptTag = "sh.mschf.ratking.defs#receiptEvent";
const UnknownEvent = object({ $type: Schema.String.check(Schema.makeFilter(tag => tag !== messageTag && tag !== receiptTag)) });
export const LogEvent = Schema.Union([
  object({ $type: Schema.Literal(messageTag), seq: integer(1), envelope: Envelope, receipt: Receipt }),
  object({ $type: Schema.Literal(receiptTag), seq: integer(1), receipt: Receipt }),
  UnknownEvent,
]);
export const ListOutput = object({ events: Schema.Array(LogEvent).check(Schema.isMaxLength(100)), throughSeq: integer(0), cursor: Schema.optionalKey(Schema.String) });
export type ListOutput = typeof ListOutput.Type;
