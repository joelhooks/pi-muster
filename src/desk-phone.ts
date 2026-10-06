import { Effect } from "effect";
import { deskInbox, deskInboxItem, consumeDeskAnswer, DeskInboxError, type DeskInboxMailbox } from "./desk-inbox.ts";
import { decodeDeskOpenedMessage, decodeDeskPhoneCards, type DeskInboxIdentities, type DeskPhoneEntry } from "./domain.ts";
import { queuePath, readDesk } from "./desk.ts";
import { openDeskItems } from "./tokens.ts";
import { deskAnswer } from "./switchboard-ops.ts";
import { stepDeskPhone } from "./machines.ts";
import { readDeskPhoneConfig, withDeskPhoneState } from "./desk-phone-store.ts";
import type { OpenedMessage } from "./vendor/rat-king-mailbox-client/index.ts";

export const PHONE_PROJECT = "rats-nest";
const refuse = (message: string) => new DeskInboxError(`desk_phone refused: ${message}`);
const boundary = <A>(f: () => A) => Effect.try({ try: f, catch: error => error instanceof DeskInboxError ? error : refuse("invalid input or queue") });
type PhoneContext = { home: string; mailbox: DeskInboxMailbox; identities: DeskInboxIdentities };
const queue = (home: string) => boundary(() => openDeskItems(readDesk(queuePath(PHONE_PROJECT, home))));
const accepted = (receipt: { state: string }) => ["accepted", "queued", "delivered", "acked"].includes(receipt.state);
const pending = (entry: Exclude<DeskPhoneEntry, { state: "sending" }>) => ({ item: entry.item, page: entry.page, messageTid: entry.messageTid });

/** Only explicit sends create cards. A send intent with no receipt is uncertain and is never retried blindly. */
export function sendDeskPhone(options: PhoneContext & { card: unknown; page: string }) {
  return withDeskPhoneState(options.home, options.identities, (state, save) => Effect.gen(function* () {
    const card = yield* boundary(() => {
      const value = decodeDeskPhoneCards([options.card])[0];
      if (!value) throw refuse("one report card required");
      return value;
    });
    const open = yield* queue(options.home);
    const item = open.find(item => item.id === card.id);
    if (!item || !["blocked", "approval", "decision"].includes(item.kind)) return yield* Effect.fail(refuse("card must name an open rats-nest decision, approval or blocker"));
    const previous = state.entries[item.id];
    if (previous?.state === "sending") return yield* Effect.fail(refuse("send intent has no confirmed receipt; reconcile the mailbox before retrying"));
    if (previous) return { action: "duplicate" as const, entry: previous };
    const record = yield* boundary(() => deskInboxItem({ project: PHONE_PROJECT, queueItem: item, card }));
    // Persist the exact card before the network side effect, so an ambiguous crash cannot create a second thread.
    state.entries[item.id] = { state: "sending", item: record, page: options.page };
    yield* save();
    const receipt = yield* deskInbox(options).sendItem({ project: PHONE_PROJECT, queueItem: item, card }).pipe(Effect.mapError(() => refuse("item send failed; sending intent retained with no confirmed receipt; reconcile the mailbox before retrying")));
    if (!accepted(receipt.receipt)) return yield* Effect.fail(refuse(`item send returned ${receipt.receipt.state}; receipt ${JSON.stringify(receipt.receipt)}; inspect pending.json before retrying`));
    yield* stepDeskPhone("sending", { type: "SENT" }, "pending");
    const entry: DeskPhoneEntry = { state: "pending", item: record, page: options.page, messageTid: receipt.receipt.message.messageId, receipt };
    state.entries[item.id] = entry;
    yield* save();
    return { action: "sent" as const, entry };
  }));
}

/** Resume recorded phone rulings and close threads resolved by chat. No poll, timer or lease acquisition. */
export function syncDeskPhone(options: PhoneContext) {
  return withDeskPhoneState(options.home, options.identities, (state, save) => Effect.gen(function* () {
    const updates = [];
    for (const [id, initial] of Object.entries(state.entries)) {
      if (initial.state === "sending") return yield* Effect.fail(refuse(`item ${id} has an uncertain send; reconcile its receipt first`));
      if (initial.state === "closed") continue;
      let entry = initial;
      const open = yield* queue(options.home);
      if (entry.state === "answered" && open.some(item => item.id === id)) {
        const result = yield* deskAnswer({ project: PHONE_PROJECT, id, answer: entry.answer.text });
        updates.push({ itemId: id, resolution: result });
      } else if (entry.state === "pending" && open.some(item => item.id === id)) continue;
      if (entry.state !== "resolved") {
        yield* stepDeskPhone(entry.state, { type: "RESOLVE" }, "resolved");
        entry = { ...pending(entry), receipt: entry.receipt, state: "resolved" };
        state.entries[id] = entry;
        yield* save();
      }
      const updateReceipt = yield* deskInbox(options).sendUpdate({ project: PHONE_PROJECT, itemId: id, state: "resolved", text: "Resolved in the desk queue; owner notification follows the existing desk answer path." }).pipe(Effect.mapError(() => refuse("update send failed; queue resolution retained; run sync to retry the phone update")));
      if (!accepted(updateReceipt.receipt)) return yield* Effect.fail(refuse(`update send returned ${updateReceipt.receipt.state}; receipt ${JSON.stringify(updateReceipt.receipt)}; run sync to retry`));
      yield* stepDeskPhone("resolved", { type: "UPDATE" }, "closed");
      state.entries[id] = { ...entry, state: "closed", updateReceipt };
      yield* save();
      updates.push({ itemId: id, updateReceipt });
    }
    return { updates, entries: state.entries };
  }));
}

/** Called only with the existing consumer's authenticated envelope and opened message. */
export function receiveDeskPhone(options: PhoneContext & {
  envelope: Parameters<DeskInboxMailbox["open"]>[0]; opened: OpenedMessage;
}) {
  return Effect.gen(function* () {
    const result = yield* withDeskPhoneState(options.home, options.identities, (state, save) => Effect.gen(function* () {
      const opened = yield* boundary(() => decodeDeskOpenedMessage(options.opened));
      if (opened.senderDid !== options.identities.phone || options.envelope.aad.recipientDid !== options.identities.switchboard) return yield* Effect.fail(refuse("answer signer or recipient is not allowlisted"));
      // Validate the record, reference, axes and ruling even on replays. The library owns this translation.
      const candidates = Object.values(state.entries).filter(entry => entry.state !== "sending").map(pending);
      const answer = yield* consumeDeskAnswer({ identities: options.identities, envelope: options.envelope,
        mailbox: { open: () => Effect.succeed(options.opened) }, pending: candidates });
      if (answer.deskAnswer.project !== PHONE_PROJECT) return yield* Effect.fail(refuse("only rats-nest is enabled"));
      const id = answer.deskAnswer.id;
      const entry = state.entries[id];
      if (!entry || entry.state === "sending") return yield* Effect.fail(refuse("unknown item"));
      if (entry.state !== "pending") return { action: "duplicate" as const, itemId: id };
      yield* stepDeskPhone("pending", { type: "ANSWER" }, "answered");
      state.entries[id] = { ...entry, state: "answered", answer: { tid: answer.answerTid, text: answer.deskAnswer.answer } };
      yield* save();
      return { action: "recorded" as const, itemId: id };
    }));
    // Replays also resume a previous ruling whose queue write or update failed.
    const sync = yield* syncDeskPhone(options);
    return { ...result, ...sync };
  });
}

export function deskPhoneSnapshot(home: string, identities: DeskInboxIdentities) {
  return withDeskPhoneState(home, identities, state => Effect.succeed({ entries: state.entries, receiving: "The existing NetworkComms consumer receives answers; poll starts no second consumer or lease." }));
}

/** Dispatch never treats a phone answer as agent text. A refusal is surfaced to the Switchboard, not thrown into its consumer. */
export function dispatchDeskPhone(options: { home: string; ownDid: string; mailbox: DeskInboxMailbox;
  envelope: Parameters<DeskInboxMailbox["open"]>[0]; opened: OpenedMessage;
}) {
  return Effect.gen(function* () {
    const identities = yield* readDeskPhoneConfig(options.home);
    if (identities.switchboard !== options.ownDid) return yield* Effect.fail(refuse("desk answers belong to the configured Switchboard consumer"));
    const result = yield* receiveDeskPhone({ ...options, identities });
    return `desk_phone ${result.action}: ${PHONE_PROJECT}#${result.itemId}. Updates: ${result.updates.length}.`;
  }).pipe(Effect.catch(error => Effect.succeed(`desk_phone answer failed: ${error instanceof DeskInboxError ? error.message : "queue or transport unavailable; recorded rulings and resolved updates can be retried with sync"}. Inspect the private sidecar and run desk_phone sync; never decide for Joel.`)));
}
