import { Effect, Schema } from "effect";
import { openNetworkMailbox, readNetworkIdentities, sendWithConsumerFence } from "./comms-network.ts";
import { decodeDeskItem, decodeDeskOpenedMessage } from "./domain.ts";
import { FEEDBACK_SCHEMA, rulingText, rulings, type Feedback, type FeedbackValue, type ReportCard } from "./desk-report.ts";
import type { DeskAnswerInput } from "./switchboard-ops.ts";
import * as Item from "./vendor/rat-king-lexicon/desk.item.ts";
import * as Answer from "./vendor/rat-king-lexicon/desk.answer.ts";
import * as Update from "./vendor/rat-king-lexicon/desk.update.ts";

export const SWITCHBOARD_DID = "did:web:switchboard.ratking-fleet.invalid";
export const PHONE_DID = "did:web:joel-iphone.ratking-fleet.invalid";
export type DeskInboxMailbox = Pick<Effect.Success<ReturnType<typeof openNetworkMailbox>>, "send" | "open">;
export class DeskInboxError extends Error {
  readonly _tag = "DeskInboxError";
}
const refuse = (reason: string): never => { throw new DeskInboxError(reason); };
const boundary = <A>(f: () => A) => Effect.try({ try: f, catch: error => error instanceof DeskInboxError ? error : new DeskInboxError("Invalid desk record") });
const decodeItem = Schema.decodeUnknownSync(Item.Main);
const decodeAnswer = Schema.decodeUnknownSync(Answer.Main);
const decodeUpdate = Schema.decodeUnknownSync(Update.Main);

/** The only then/outcome translation lives at this edge. No report object is spread into a record. */
export function deskInboxItem(options: { project: string; queueItem: unknown; card: ReportCard; supersedes?: string }): Item.MainValue {
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

function validateAxes(item: Item.MainValue): void {
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
  readonly item: Item.MainValue;
  /** Persist the send result's tid. Keep only unresolved items in this list. */
  readonly messageTid: string;
  readonly page: string;
}

/** Open verifies HPKE/AAD/signature using the mailbox's DID resolver before any feedback is produced.
 * The caller owns pending state, deduplication, queue writes, notification, and deliver/ack.
 * Refusals never write a resolving line or ack a message.
 */
export function consumeDeskAnswer(options: {
  mailbox: Pick<DeskInboxMailbox, "open">;
  envelope: Parameters<DeskInboxMailbox["open"]>[0];
  pending: readonly PendingDeskItem[];
}) {
  return Effect.gen(function* () {
    const opened = yield* options.mailbox.open(options.envelope);
    return yield* boundary(() => {
      const message = decodeDeskOpenedMessage(opened);
      if (message.senderDid !== PHONE_DID) refuse("Desk answer sender is not allowlisted");
      const answer = decodeAnswer(JSON.parse(message.body));
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
      return { feedback, deskAnswer: { project: answer.project, id: answer.itemId, answer: rulingText(ruling) } satisfies DeskAnswerInput, answerTid: message.tid };
    });
  });
}

export function deskInboxUpdate(options: { project: string; itemId: string; state: Update.MainValue["state"]; text?: string }): Update.MainValue {
  return decodeUpdate({ $type: "sh.mschf.ratking.desk.update", project: options.project, itemId: options.itemId,
    state: options.state, ...(options.text !== undefined ? { text: options.text } : {}) });
}

/** Call once with the Switchboard's already-open mailbox, or load its existing network.json identity.
 * No poller, timer, cursor, lease acquisition, or tool registration belongs to this library.
 */
export function openDeskInbox(options: { home: string; configPath?: string }) {
  return Effect.gen(function* () {
    const mailbox = yield* openNetworkMailbox({ ...options, agent: "switchboard" });
    yield* boundary(() => {
      if (readNetworkIdentities(options.home).switchboard?.did !== SWITCHBOARD_DID) refuse("Switchboard identity mismatch");
    });
    return deskInbox({ home: options.home, mailbox });
  });
}

export function deskInbox(options: { home: string; mailbox: DeskInboxMailbox }) {
  const send = (record: Item.MainValue | Update.MainValue) => sendWithConsumerFence({
    home: options.home, did: SWITCHBOARD_DID,
    send: opts => options.mailbox.send(PHONE_DID, JSON.stringify(record), opts),
  });
  return {
    sendItem: (input: Parameters<typeof deskInboxItem>[0]) => boundary(() => deskInboxItem(input)).pipe(Effect.flatMap(send)),
    sendUpdate: (input: Parameters<typeof deskInboxUpdate>[0]) => boundary(() => deskInboxUpdate(input)).pipe(Effect.flatMap(send)),
    consumeAnswer: (input: Omit<Parameters<typeof consumeDeskAnswer>[0], "mailbox">) => consumeDeskAnswer({ ...input, mailbox: options.mailbox }),
  };
}
