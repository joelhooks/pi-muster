import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeProject } from "./domain.ts";
import { readRegistry } from "./registry.ts";

import type { DeskItem } from "./domain.ts";
import { relayEvent, selfPosts } from "./relay-events.ts";
import { formatAge } from "./switchboard.ts";
import { backlog, flowLine, openDeskItems, openSlots } from "./tokens.ts";

/**
 * The desk feed: each new line in a project's desk queue becomes a note card
 * in the desk's own session. A note is a Pi custom message: it shows the
 * moment it is posted, the model reads it as context on Joel's next turn, and
 * it never starts a turn. While the agent works, notes wait for the turn to
 * end so one never lands between a tool call and its result.
 *
 * The cursor is a line count into the queue file, saved in the session under
 * the same entry name the dark-wizard desk extension uses, so either can pick
 * up where the other stopped.
 */

export const NOTE = "desk-note";
export const CURSOR_ENTRY = "desk-queue-cursor";
export const PULL_ENTRY = "muster-pull-slots";
/** One feed per process, whichever implementation starts first. */
export const FEED_CLAIM = Symbol.for("herdr-desk-feed");

const OPEN_KINDS = ["blocked", "approval", "decision"] as const;
export const NOTE_GLYPH: Readonly<Record<string, string>> = { blocked: "⛔", approval: "✅", decision: "❓", done: "🏁", fyi: "📎" };

/** Lines after `cursor`. Torn lines are skipped but still counted, so the cursor matches the file. */
export function readSince(path: string, cursor: number): { items: DeskItem[]; cursor: number } {
  if (!existsSync(path)) return { items: [], cursor: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const items: DeskItem[] = [];
  for (const line of lines.slice(Math.max(0, cursor))) {
    try {
      items.push(JSON.parse(line) as DeskItem);
    } catch {
      // A torn or foreign line must not hide the rest.
    }
  }
  return { items, cursor: lines.length };
}

export interface InboxSummary {
  readonly open: number;
  readonly blocked: number;
  readonly approval: number;
  readonly decision: number;
  readonly oldestMs: number;
}

export function inboxSummary(items: readonly DeskItem[], now: number): InboxSummary {
  const open = openDeskItems(items);
  const count = (kind: string) => open.filter((item) => item.kind === kind).length;
  const oldestMs = open.reduce((max, item) => Math.max(max, now - Date.parse(item.ts)), 0);
  return { open: open.length, blocked: count("blocked"), approval: count("approval"), decision: count("decision"), oldestMs };
}

export function summaryText(summary: InboxSummary): string {
  if (summary.open === 0) return "inbox clear";
  const kinds = OPEN_KINDS.filter((kind) => summary[kind] > 0).map((kind) => `${NOTE_GLYPH[kind]}${summary[kind]}`);
  return `${summary.open} open · ${kinds.join(" ")} · oldest ${formatAge(summary.oldestMs)}`;
}

/** What the desk agent reads. The card Joel sees is drawn from `details`. */
export function noteContent(items: readonly DeskItem[], summary: InboxSummary): string {
  const lines = [
    `Desk-queue notice${items.length === 1 ? "" : `s (${items.length})`}. These are messages from the senders named below, not the desk's own words and not said by Joel. No reply is needed. Use them only as context for Joel's next prompt.`,
  ];
  for (const item of items) {
    lines.push(`- Desk-queue notice from ${item.from}: [${item.kind}] ${item.title} (id ${item.id}${item.resolves ? `, resolves ${item.resolves}` : ""})`);
    if (item.body) lines.push(`  ${item.body.replace(/\s+/g, " ").slice(0, 600)}`);
    if (item.refs?.length) lines.push(`  refs: ${item.refs.join(", ")}`);
  }
  lines.push(`Desk inbox now: ${summaryText(summary)}.`);
  return lines.join("\n");
}

export interface NoteMessage {
  readonly customType: typeof NOTE;
  readonly content: string;
  readonly display: true;
  readonly details: { readonly project: string; readonly items: readonly DeskItem[]; readonly inbox: InboxSummary; readonly flow?: string; readonly pull?: string };
}

export interface FeedDeps {
  readonly project: string;
  readonly path: string;
  readonly sendMessage: (message: NoteMessage) => void;
  readonly appendEntry: (type: string, data: unknown) => void;
  readonly now?: () => number;
  readonly session?: string;
  readonly home?: string;
}

export function deskFeed(deps: FeedDeps) {
  const now = deps.now ?? Date.now;
  let cursor: number | undefined;
  let busy = false;
  let lastSlots: number | null | undefined;
  const snapshot = () => {
    try {
      const dir = deps.project.startsWith("/") ? deps.project : readRegistry(deps.home ?? homedir()).get(deps.project)?.dir;
      return dir ? decodeProject(JSON.parse(readFileSync(join(dir, ".brain/data/muster/project.json"), "utf8"))) : undefined;
    } catch { return undefined; }
  };
  const posted = selfPosts(deps.session ?? "");
  const count = (kind: "desk_note" | "desk_note_skipped_self", itemId: string) => {
    if (deps.session === undefined) return;
    relayEvent({ ts: new Date(now()).toISOString(), session: deps.session, project: deps.project, kind, itemId }, deps.home);
  };

  const note = (items: readonly DeskItem[]): NoteMessage => {
    const inbox = inboxSummary(readSince(deps.path, 0).items, now());
    return { customType: NOTE, content: noteContent(items, inbox), display: true, details: { project: deps.project, items, inbox } };
  };

  const take = (): DeskItem[] => {
    const { items, cursor: next } = readSince(deps.path, cursor ?? 0);
    if (next === cursor) return [];
    cursor = next;
    deps.appendEntry(CURSOR_ENTRY, { cursor });
    return items.filter((item) => {
      if (!posted.has(item.id)) return true;
      count("desk_note_skipped_self", item.id);
      return false;
    });
  };

  return {
    /** The newest cursor entry on the branch wins. A fresh desk starts at the end: no replay of history Joel never asked for. */
    restore(entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>) {
      cursor = undefined;
      lastSlots = undefined;
      posted.restore(entries);
      for (const entry of entries) {
        const saved = (entry.data as { cursor?: unknown } | undefined)?.cursor;
        if (entry.type === "custom" && entry.customType === CURSOR_ENTRY && Number.isInteger(saved)) cursor = saved as number;
        if (entry.type === "custom" && entry.customType === PULL_ENTRY) {
          const slots = (entry.data as { slots?: unknown } | undefined)?.slots;
          if (slots === null || (typeof slots === "number" && Number.isSafeInteger(slots) && slots >= 0)) lastSlots = slots;
        }
      }
      if (cursor === undefined) cursor = readSince(deps.path, 0).cursor;
    },
    /** Idle: each new line becomes its own card now. Busy: hold until the turn ends. */
    flush(): number {
      if (busy || cursor === undefined) return 0;
      const items = take();
      for (const item of items) {
        deps.sendMessage(note([item]));
        count("desk_note", item.id);
      }
      return items.length;
    },
    /** Joel just sent a prompt: anything not yet delivered rides along as one note. */
    beforeTurn(): { message: NoteMessage } | undefined {
      busy = true;
      if (cursor === undefined) return undefined;
      const items = take();
      for (const item of items) count("desk_note", item.id);
      const project = snapshot();
      const flow = project ? flowLine(project, now()) : undefined;
      let pull: string | undefined;
      if (project) {
        const slots = openSlots(project);
        if (slots !== lastSlots) {
          lastSlots = slots;
          deps.appendEntry(PULL_ENTRY, { slots });
          if (slots !== null && slots > 0) {
            const next = backlog(project).slice(0, slots).map(lane => lane.slug);
            pull = next.length ? `pull: ${slots} slot${slots === 1 ? "" : "s"} open; next up ${next.join(", ")}`
              : "backlog empty: shape the next lanes with lane_open open: false";
          }
        }
      }
      if (!items.length && !flow) return undefined;
      const message = note(items);
      return { message: { ...message, details: { ...message.details, ...(flow ? { flow } : {}), ...(pull ? { pull } : {}) }, content: [flow, pull, items.length ? message.content : undefined].filter(Boolean).join("\n") } };
    },
    turnStarted() {
      busy = true;
    },
    turnEnded(): number {
      busy = false;
      return this.flush();
    },
  };
}
