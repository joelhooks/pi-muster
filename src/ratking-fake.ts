import { RatkingComms, RATKING_SEND, RATKING_SEND_RESULT } from "./comms-ratking.ts";
import { commsAddress } from "./comms.ts";
import { decodeProject, decodeNetworkPayload } from "./domain.ts";
import { registeredCatalogs } from "./comms-ratking.ts";
import { ingestOwnerItem } from "./owner-queue.ts";

/** pi-ratking event fake shared by orchestration tests. The wire stays identical to deployed Muster. */
export function fakeRatking(home: string, sender: () => string, sent: Array<{ to: string; message: string }>) {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let id = 0;
  const events = {
    on(event: string, listener: (value: unknown) => void) { const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); return () => { group.delete(listener); }; },
    emit(event: string, value: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value);
      if (event !== RATKING_SEND) return;
      const request = value as { requestId: string; to?: string; replyTo?: string; body: string; kind?: string };
      const payload = decodeNetworkPayload(JSON.parse(request.body));
      const to = payload.recipient;
      sent.push({ to, message: payload.type === "message" ? payload.body : payload.item.text });
      if (payload.type === "owner") { try { ingestOwnerItem(to, payload.item, home); } catch { /* delivery and local projection are separate */ } }
      events.emit(RATKING_SEND_RESULT, { requestId: request.requestId, status: "delivered", id: `fake-${++id}`, to: request.to });
    },
  };
  const service = RatkingComms({ events, createId: () => String(++id), sender, target: to => {
    const address = commsAddress(to);
    if (address.kind === "did") throw new Error("names only");
    if (address.kind === "session") return { name: address.id, session: address.id };
    const project = registeredCatalogs(home).find(project => project.slug === address.project);
    const row = project?.agents.find(row => row.name === address.row);
    if (!row) throw new Error("unknown alias");
    return { name: `${address.project}/${address.row}`, session: row.sessionId };
  } });
  return { service, events };
}
