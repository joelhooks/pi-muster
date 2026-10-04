import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RelayKind = "packet_report" | "desk_note" | "desk_note_skipped_self" | "watch_retired";
export interface RelayEvent {
  readonly ts: string;
  readonly session: string;
  readonly kind: RelayKind;
  readonly project: string;
  readonly packetId?: string;
  readonly itemId?: string;
}

/** Explicit projection: even callers carrying queue bodies cannot leak them here. */
export function relayEvent(event: RelayEvent, home = homedir()): void {
  try {
    const path = join(home, ".local", "state", "muster", "relay-events.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ts: event.ts, session: event.session, kind: event.kind, project: event.project,
      ...(event.packetId === undefined ? {} : { packetId: event.packetId }),
      ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
    })}\n`, { mode: 0o600 });
  } catch {
    // Telemetry must never fail queue delivery or an otherwise successful tool.
  }
}

export const SELF_ENTRY = "muster-desk-self-post";
type Entry = { type?: string; customType?: string; data?: unknown };
const sessions = new Map<string, Set<string>>();

/** Session ids, not sender labels, isolate /new and other sessions in this process. */
export function selfPosts(session: string) {
  let ids = sessions.get(session);
  if (!ids) {
    ids = new Set();
    sessions.set(session, ids);
  }
  return {
    has: (id: string) => ids.has(id),
    record(id: string, appendEntry: (type: string, data: unknown) => void) {
      ids.add(id);
      try { appendEntry(SELF_ENTRY, { session, id }); } catch { /* Keep the in-memory fence if session persistence fails. */ }
    },
    restore(entries: readonly Entry[]) {
      for (const entry of entries) {
        if (entry.type !== "custom" || entry.customType !== SELF_ENTRY) continue;
        const data = entry.data;
        if (typeof data === "object" && data !== null && "session" in data && data.session === session && "id" in data && typeof data.id === "string") ids.add(data.id);
      }
    },
  };
}

/** Only desk tools reserve self ids. Async scope avoids classifying concurrent tools. */
export const deskWriteScope = new AsyncLocalStorage<{ readonly record: (id: string) => void }>();
export const watchEntries = new AsyncLocalStorage<readonly Entry[]>();

/** Receipts are hints, not access to Bellwether's live registry. Names are not pane ids. */
export function watchFallback(panes: readonly string[], entries = watchEntries.getStore() ?? []): string {
  const receipts = new Map<string, { status: string; target: string }>();
  for (const entry of entries) {
    if (entry.type !== "custom" || !["bellwether-herdr-watch-started", "bellwether-herdr-watch-resumed", "bellwether-herdr-watch-finished"].includes(entry.customType ?? "")) continue;
    const data = entry.data;
    if (typeof data !== "object" || data === null || !("id" in data) || typeof data.id !== "string" || !("status" in data) || typeof data.status !== "string") continue;
    const target = "pane" in data && typeof data.pane === "string" ? data.pane : "target" in data && typeof data.target === "string" ? data.target : "";
    receipts.set(data.id, { status: data.status, target });
  }
  const ids = [...receipts].filter(([, receipt]) => receipt.status === "running" && panes.includes(receipt.target)).map(([id]) => id);
  return `watch fallback: cancel this pane's Bellwether watches with herdr_watch action=cancel before agent_close or lane_close (Muster cannot access the private registry)${ids.length ? `; watch ids to cancel from session receipts: ${ids.join(", ")}` : "; no pane-targeted watch ids discoverable; list watches first (named targets may also match)"}`;
}
export function withDeskWrites(pi: ExtensionAPI): ExtensionAPI {
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    if (!["desk_post", "desk_answer", "desk_rulings"].includes(tool.name)) return pi.registerTool(tool);
    pi.registerTool({
      ...tool,
      async execute(...args) {
        const ctx = args[4];
        const posted = selfPosts(ctx.sessionManager.getSessionId());
        posted.restore(ctx.sessionManager.getBranch());
        return deskWriteScope.run({ record: (id) => posted.record(id, (type, data) => pi.appendEntry(type, data)) }, () => tool.execute(...args));
      },
    });
  };
  return new Proxy(pi, { get: (target, key, receiver) => key === "registerTool" ? registerTool : Reflect.get(target, key, receiver) });
}

export function deskWriteId(id: string): string {
  // Reserve before writing: a later nudge failure must not make a committed line echo.
  deskWriteScope.getStore()?.record(id.slice(0, 8));
  return id;
}
