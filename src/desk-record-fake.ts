import { createEventBus } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { RatkingComms } from "./comms-ratking.ts";
import { decodeDeskRecordItem, decodeDeskRecordAnswer } from "./domain.ts";

export const phoneIdentities = { switchboard: "did:web:switchboard.example.invalid", phone: "did:web:phone.example.invalid" };
export const phoneItem = decodeDeskRecordItem({
  $type: "sh.mschf.ratking.desk.item", project: "rats-nest", itemId: "sample-001", kind: "decision",
  title: "Ship?", why: "Choose a reversible path", body: "Queue context", createdAt: "2026-10-10T19:00:00.000Z", refs: ["Receipt"],
  choices: [{ key: "path", label: "Path", suggest: "hold", options: [
    { id: "hold", label: "Hold", outcome: "Keep it reversible" }, { id: "ship", label: "Ship", outcome: "Go live" },
  ] }], rows: { key: "checks", label: "Checks", items: [{ v: "codec", label: "Codec", on: true }] },
});
export const phoneAnswer = decodeDeskRecordAnswer({
  $type: "sh.mschf.ratking.desk.answer", project: phoneItem.project, itemId: phoneItem.itemId,
  inReplyTo: "item-1", values: { path: "hold" }, rows: { checks: ["codec"] }, note: "Keep it reversible.",
});
export const phoneEvent = { id: "answer-1", from: "joel-iphone", did: phoneIdentities.phone, verified: true, record: phoneAnswer };
/** The real event adapter with a bounded fake pi-ratking responder, no mailbox/lease/crypto. */
export function phoneRatkingFake() {
  const events = createEventBus();
  let sequence = 0;
  const send = vi.fn((request: { requestId: string; to: string; record: unknown; encrypt?: boolean }): Record<string, unknown> => ({
    requestId: request.requestId, status: "delivered", id: ++sequence === 1 ? "item-1" : `update-${sequence}`, seq: sequence, to: request.to,
  }));
  events.on("ratking/send", request => { events.emit("ratking/send:result", send(request as Parameters<typeof send>[0])); });
  events.on("ratking/status", request => events.emit("ratking/status:result", { requestId: (request as { requestId: string }).requestId,
    name: "switchboard", did: phoneIdentities.switchboard, reader: "live", leaseGeneration: 7, leaseUntil: "2026-10-11T00:00:00Z" }));
  const comms = RatkingComms({ events, createId: () => String(sequence + 1), sender: () => "switchboard", target: to => ({ name: String(to), session: String(to) }), timeoutMs: 30 });
  return { events, send, comms };
}
