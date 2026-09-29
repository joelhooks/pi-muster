import { Schema } from "effect";

export class InputError extends Schema.TaggedErrorClass<InputError>()("InputError", {
  message: Schema.String,
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  kind: Schema.String,
  id: Schema.String,
  message: Schema.String,
}) {}

export class IllegalTransition extends Schema.TaggedErrorClass<IllegalTransition>()("IllegalTransition", {
  machine: Schema.Literals(["agent", "lane", "project"]),
  id: Schema.String,
  from: Schema.String,
  event: Schema.String,
  message: Schema.String,
}) {}

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("StoreError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class ProcError extends Schema.TaggedErrorClass<ProcError>()("ProcError", {
  command: Schema.String,
  code: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  message: Schema.String,
}) {}

export class HerdrFailure extends Schema.TaggedErrorClass<HerdrFailure>()("HerdrFailure", {
  operation: Schema.String,
  code: Schema.NullOr(Schema.String),
  message: Schema.String,
}) {}

export class PacketCheckFailed extends Schema.TaggedErrorClass<PacketCheckFailed>()("PacketCheckFailed", {
  packet: Schema.String,
  failures: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class GuardFailed extends Schema.TaggedErrorClass<GuardFailed>()("GuardFailed", {
  guard: Schema.String,
  message: Schema.String,
}) {}

export class HeavyJobBusy extends Schema.TaggedErrorClass<HeavyJobBusy>()("HeavyJobBusy", {
  holder: Schema.String,
  message: Schema.String,
}) {}

export type MusterError =
  | InputError
  | NotFound
  | IllegalTransition
  | StoreError
  | ProcError
  | HerdrFailure
  | PacketCheckFailed
  | GuardFailed
  | HeavyJobBusy;
