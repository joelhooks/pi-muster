import { RatkingComms, RATKING_SEND, RATKING_SEND_RESULT, ratkingInbound } from "./comms-ratking.ts";
import { commsAddress } from "./comms.ts";
import { decodeNetworkPayload, type Project } from "./domain.ts";
import { registeredCatalogs } from "./comms-ratking.ts";
import { ingestOwnerItem } from "./owner-queue.ts";

/** pi-ratking event fake shared by orchestration tests. The wire stays identical to deployed Muster. */
export function fakeRatking(home: string, sender: () => string, sent: Array<{ to: string; message: string }>, catalogs: () => readonly Project[] = () => registeredCatalogs(home)) {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let id = 0;
  const requests: Array<{ requestId: string; to?: string; replyTo?: string; body: string; kind?: string; summary?: string }> = [];
  const events = {
    on(event: string, listener: (value: unknown) => void) { const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); return () => { group.delete(listener); }; },
    emit(event: string, value: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(value);
      if (event !== RATKING_SEND) return;
      const request = value as { requestId: string; to?: string; replyTo?: string; body: string; kind?: string; summary?: string };
      requests.push(request);
      const messageId = `fake-${++id}`;
      if (request.kind === "message") {
        const projects = catalogs();
        const recipient = projects.flatMap(project => project.agents.map(row => ({ name: `${project.slug}/${row.name}`, row }))).find(value => value.name === request.to);
        const to = recipient?.row.sessionId ?? request.to ?? "reply";
        sent.push({ to, message: request.body });
        ratkingInbound({ ...request, id: messageId, verified: true, from: target(sender()).name }, {
          catalogs,
          owner: item => { try { ingestOwnerItem(to, item, home); } catch { /* delivery and local projection are separate */ } }, message() {},
        });
      } else {
        const payload = decodeNetworkPayload(JSON.parse(request.body));
        const to = payload.recipient;
        sent.push({ to, message: payload.type === "message" ? payload.body : payload.item.text });
        if (payload.type === "owner") { try { ingestOwnerItem(to, payload.item, home); } catch { /* delivery and local projection are separate */ } }
      }
      events.emit(RATKING_SEND_RESULT, { requestId: request.requestId, status: "delivered", id: messageId, to: request.to });
    },
  };
  const target = (to: import("./runtime.ts").CommsTarget) => {
    const address = commsAddress(to);
    if (address.kind === "did") throw new Error("names only");
    if (address.kind === "session") {
      for (const project of catalogs()) {
        const row = project.agents.find(row => row.sessionId === address.id);
        if (row) return { name: `${project.slug}/${row.name}`, session: row.sessionId };
      }
      return { name: address.id, session: address.id };
    }
    const project = catalogs().find(project => project.slug === address.project);
    const row = project?.agents.find(row => row.name === address.row);
    if (!row) throw new Error("unknown alias");
    return { name: `${address.project}/${address.row}`, session: row.sessionId };
  };
  const service = RatkingComms({ events, createId: () => String(++id), sender, target });
  return { service, events, requests };
}
