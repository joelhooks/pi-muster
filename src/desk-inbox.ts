import { Effect, Schema } from "effect";
import { decodeDeskItem, decodeRatkingRecord, decodeDeskRecordItem, decodeDeskRecordAnswer, decodeDeskRecordUpdate, decodeDeskInboxIdentities, type DeskInboxIdentities, type DeskRecordItem, type DeskRecordUpdate } from "./domain.ts";
import { RatkingMissing } from "./comms-ratking.ts";
import type { CommsShape } from "./runtime.ts";
import { FEEDBACK_SCHEMA, rulingText, rulings, type Feedback, type FeedbackValue, type ReportCard } from "./desk-report.ts";
import type { DeskAnswerInput } from "./switchboard-ops.ts";

export type { DeskInboxIdentities } from "./domain.ts";
export type DeskInboxTransport = Pick<CommsShape, "sendRecord">;
export class DeskInboxError extends Error {
  readonly _tag = "DeskInboxError";
}
const refuse = (reason: string): never => { throw new DeskInboxError(reason); };
const boundary = <A>(f: () => A) => Effect.try({ try: f, catch: error => error instanceof DeskInboxError ? error : new DeskInboxError("Invalid desk record") });
const decodeItem = decodeDeskRecordItem;
const decodeAnswer = decodeDeskRecordAnswer;
const decodeUpdate = decodeDeskRecordUpdate;
const identitiesFrom = (value: unknown): DeskInboxIdentities => {
  try { return { ...decodeDeskInboxIdentities(value) }; }
  catch { return refuse("Desk inbox identities are required and must be did: strings"); }
};

/** The only then/outcome translation lives at this edge. No report object is spread into a record. */
export function deskInboxItem(options: { project: string; queueItem: unknown; card: ReportCard; supersedes?: string }): DeskRecordItem {
  const queue = decodeDeskItem(options.queueItem);
  const { card } = options;
  if (card.id !== queue.id || card.extra_ids?.length) refuse("One card must cover exactly one desk item");
  const record = decodeItem({
    $type: "sh.mschf.ratking.desk.item", project: options.project, itemId: queue.id,
    kind: queue.kind, title: queue.title, why: card.why, body: queue.body ?? "",
    choices: card.choices.map(choice => ({ key: choice.key, label: choice.label, suggest: choice.suggest,
      options: choice.options.map(option => ({ id: option.v, label: option.label, outcome: option.then })) })),
    ...(card.rows ? { rows: { key: card.rows.key, label: card.rows.label,
      items: card.rows.items.map(([v, label, on]) => ({ v, label, on })) } } : {}),
    refs: (card.refs ?? []).map(([label]) => label), createdAt: queue.ts,
    ...(options.supersedes !== undefined ? { supersedes: options.supersedes } : {}),
  });
  validateAxes(record);
  return record;
}

function validateAxes(item: DeskRecordItem): void {
  const keys = item.choices.map(choice => choice.key);
  if (item.rows) keys.push(item.rows.key);
  if (keys.includes("t") || new Set(keys).size !== keys.length) refuse("Ambiguous desk axes");
  for (const choice of item.choices) {
    const ids = choice.options.map(option => option.id);
    if (new Set(ids).size !== ids.length || !ids.includes(choice.suggest)) refuse("Invalid desk options or suggestion");
  }
  if (item.rows && new Set(item.rows.items.map(row => row.v)).size !== item.rows.items.length) refuse("Duplicate desk rows");
}

/** Rebuild only the report fields carried by the wire contract; presentation context stays with the owner. */
export function deskInboxCard(value: unknown): ReportCard {
  const item = decodeItem(value);
  validateAxes(item);
  return {
    id: item.itemId, kind: item.kind, title: item.title, why: item.why,
    group: item.project, age: "", timeline: item.body, shows: [], not_shows: [],
    choices: item.choices.map(choice => ({ key: choice.key, label: choice.label, suggest: choice.suggest,
      options: choice.options.map(option => ({ v: option.id, label: option.label, then: option.outcome })) })),
    ...(item.rows ? { rows: { key: item.rows.key, label: item.rows.label,
      items: item.rows.items.map(row => [row.v, row.label, row.on] as const) } } : {}),
    refs: item.refs.map(label => [label, null] as const),
  };
}

export interface PendingDeskItem {
  readonly item: DeskRecordItem;
  /** Persist the send result's tid. Keep only unresolved items in this list. */
  readonly messageTid: string;
  readonly page: string;
}

/** pi-ratking owns cryptography and ack. This edge checks the configured signed phone DID,
 * the pending reference and feedback axes before producing any resolving input. */
export function consumeDeskAnswer(options: {
  identities: DeskInboxIdentities;
  event: unknown;
  pending: readonly PendingDeskItem[];
}) {
  return Effect.gen(function* () {
    const identities = yield* boundary(() => identitiesFrom(options.identities));
    return yield* boundary(() => {
      const message = decodeRatkingRecord(options.event);
      if (message.did !== identities.phone) refuse("Desk answer sender is not allowlisted");
      const answer = decodeAnswer(message.record);
      const pending = options.pending.find(entry => entry.item.project === answer.project && entry.item.itemId === answer.itemId);
      if (!pending) return refuse("Unknown or resolved desk item");
      if (answer.inReplyTo !== pending.messageTid) refuse("Desk answer references a different message");
      const card = deskInboxCard(pending.item);
      const item = decodeItem(pending.item);
      const entries: [string, FeedbackValue][] = [];
      for (const [key, value] of Object.entries(answer.values)) {
        const choice = item.choices.find(axis => axis.key === key);
        if (!choice || typeof value !== "string" || !choice.options.some(option => option.id === value)) refuse("Unknown desk axis or option");
        // value has been checked against the referenced option set.
        if (typeof value === "string") entries.push([key, value]);
      }
      for (const [key, value] of Object.entries(answer.rows ?? {})) {
        if (!item.rows || key !== item.rows.key || !Array.isArray(value) ||
          !value.every(v => typeof v === "string" && item.rows?.items.some(row => row.v === v)) || new Set(value).size !== value.length) refuse("Unknown desk row selection");
        // Decode the validated wire array to a typed feedback value.
        entries.push([key, Schema.decodeUnknownSync(Schema.Array(Schema.String))(value)]);
      }
      if (answer.note !== undefined) entries.push(["t", answer.note]);
      const feedback: Feedback = { schema: FEEDBACK_SCHEMA, page: pending.page,
        items: { [answer.itemId]: Object.fromEntries(entries) } };
      const result = rulings({ schema: "muster-desk-report.items.v1", slug: pending.page, snapshot: "", seed: "", groups: [], items: [card] }, feedback);
      const ruling = result.rulings[0];
      if (!ruling) return refuse("No desk ruling");
      return { feedback, deskAnswer: { project: answer.project, id: answer.itemId, answer: rulingText(ruling) } satisfies DeskAnswerInput, answerTid: message.id };
    });
  });
}

export function deskInboxUpdate(options: { project: string; itemId: string; state: DeskRecordUpdate["state"]; text?: string }): DeskRecordUpdate {
  return decodeUpdate({ $type: "sh.mschf.ratking.desk.update", project: options.project, itemId: options.itemId,
    state: options.state, ...(options.text !== undefined ? { text: options.text } : {}) });
}

/** Sends only named, encrypted records. No mailbox, cursor, consumer or lease belongs here. */
export function deskInbox(options: { home: string; comms: DeskInboxTransport; identities: DeskInboxIdentities }) {
  const identities = identitiesFrom(options.identities);
  const send = (record: DeskRecordItem | DeskRecordUpdate) =>
    (options.comms.sendRecord ?? RatkingMissing.sendRecord!)("joel-phone", record, { encrypt: true });
  return {
    sendItem: (input: Parameters<typeof deskInboxItem>[0]) => boundary(() => deskInboxItem(input)).pipe(Effect.flatMap(send)),
    sendUpdate: (input: Parameters<typeof deskInboxUpdate>[0]) => boundary(() => deskInboxUpdate(input)).pipe(Effect.flatMap(send)),
    consumeAnswer: (input: Omit<Parameters<typeof consumeDeskAnswer>[0], "identities">) => consumeDeskAnswer({ ...input, identities }),
  };
}
