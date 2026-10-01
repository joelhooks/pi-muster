import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { readDesk } from "./desk.ts";
import type { DeskItem, DeskKind, Project } from "./domain.ts";
import { TERMINAL_PACKET_STATES } from "./domain.ts";
import { openDeskItems } from "./tokens.ts";

/**
 * Switchboard ☎️: one inbox over every project's desk queue. It reads and
 * routes; it never runs a project. Project desks stay the authority for their
 * own work, and the queue files stay the only shared state.
 */

export type OpenKind = "blocked" | "approval" | "decision";
/** Blocked work costs the most per hour, then approvals, then decisions. */
export const KIND_RANK: Readonly<Record<OpenKind, number>> = { blocked: 0, approval: 1, decision: 2 };
export const KIND_GLYPH: Readonly<Record<OpenKind, string>> = { blocked: "⛔", approval: "✅", decision: "❓" };

export interface InboxItem {
  readonly project: string;
  readonly id: string;
  readonly kind: OpenKind;
  readonly title: string;
  readonly body: string | undefined;
  readonly refs: readonly string[];
  readonly from: string;
  readonly ts: string;
  readonly ageMs: number;
}

export interface InboxGroup {
  readonly project: string;
  readonly items: readonly InboxItem[];
  readonly counts: Readonly<Record<OpenKind, number>>;
  readonly oldestMs: number;
  /** A live owner or desk is bound to a different Herdr space. */
  readonly outsideSpace?: boolean;
}

export const queueDir = (home: string) => join(home, ".local", "state", "herdr-desk");

/** Every queue in the folder, keyed by project slug. */
export function readQueues(dir: string): Record<string, DeskItem[]> {
  if (!existsSync(dir)) return {};
  const queues: Record<string, DeskItem[]> = {};
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    queues[name.slice(0, -".jsonl".length)] = readDesk(join(dir, name));
  }
  return queues;
}

const rank = (item: InboxItem) => KIND_RANK[item.kind];

/** Open items grouped by project; the group holding the most urgent, oldest item comes first. */
export function inbox(queues: Readonly<Record<string, readonly DeskItem[]>>, now: number): InboxGroup[] {
  const groups: InboxGroup[] = [];
  for (const [project, items] of Object.entries(queues)) {
    const open = openDeskItems(items).map(
      (item): InboxItem => ({
        project,
        id: item.id,
        kind: item.kind as OpenKind,
        title: item.title,
        body: item.body,
        refs: item.refs ?? [],
        from: item.from,
        ts: item.ts,
        ageMs: Math.max(0, now - Date.parse(item.ts)),
      }),
    );
    if (open.length === 0) continue;
    open.sort((a, b) => rank(a) - rank(b) || b.ageMs - a.ageMs);
    const counts = { blocked: 0, approval: 0, decision: 0 };
    for (const item of open) counts[item.kind] += 1;
    groups.push({ project, items: open, counts, oldestMs: Math.max(...open.map((item) => item.ageMs)) });
  }
  const lead = (group: InboxGroup) => group.items[0] as InboxItem;
  return groups.sort((a, b) => rank(lead(a)) - rank(lead(b)) || b.oldestMs - a.oldestMs || a.project.localeCompare(b.project));
}

export function openCount(groups: readonly InboxGroup[]): number {
  return groups.reduce((sum, group) => sum + group.items.length, 0);
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return "now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** A reference Joel can paste to the agent: `[project#id]`. */
export const itemRef = (item: Pick<InboxItem, "project" | "id">) => `[${item.project}#${item.id}]`;

export interface AnswerPost {
  readonly from: string;
  readonly kind: Extract<DeskKind, "done" | "fyi">;
  readonly title: string;
  readonly body?: string | undefined;
  readonly resolves: string;
}

/**
 * The line that answers an item in its own project's queue. A long answer goes
 * in the body with a short title, because the title is what a sidebar shows.
 */
export function answerPost(answer: string, item: Pick<InboxItem, "id">, kind: AnswerPost["kind"] = "done"): AnswerPost {
  const text = answer.trim().replace(/\s+/g, " ");
  if (!text) throw new Error("an answer needs text");
  const short = text.length <= 80 ? text : `${text.slice(0, 79)}…`;
  return { from: "☎️ switchboard", kind, title: short, ...(text.length > 80 ? { body: answer.trim() } : {}), resolves: item.id };
}

/** Sidebar `needs` for the Switchboard's own space. */
export function switchboardNeeds(groups: readonly InboxGroup[]): string | null {
  const total = openCount(groups);
  if (total === 0) return null;
  return `🙋 ${total} · ${groups.length} project${groups.length === 1 ? "" : "s"}`;
}

/** How far back the widget's heat strips reach. */
export const HEAT_WINDOW_MS = 24 * 3_600_000;

/** Post times per project inside the heat window. Every kind counts: a `done` is activity too. */
export function recentPosts(queues: Readonly<Record<string, readonly DeskItem[]>>, now: number, windowMs = HEAT_WINDOW_MS): Record<string, number[]> {
  const posts: Record<string, number[]> = {};
  for (const [project, items] of Object.entries(queues)) {
    const times = items.map((item) => Date.parse(item.ts)).filter((ts) => now - ts >= 0 && now - ts < windowMs);
    if (times.length > 0) posts[project] = times;
  }
  return posts;
}

/** Posts per bucket across the window, oldest bucket first, newest last. */
export function activity(times: readonly number[], now: number, cells: number, windowMs = HEAT_WINDOW_MS): number[] {
  const out = Array.from({ length: Math.max(0, cells) }, () => 0);
  if (cells <= 0) return out;
  const size = windowMs / cells;
  for (const ts of times) {
    const age = now - ts;
    if (age < 0 || age >= windowMs) continue;
    const at = cells - 1 - Math.floor(age / size);
    out[at] = (out[at] ?? 0) + 1;
  }
  return out;
}

export interface FleetStats {
  readonly projects: number;
  readonly lanes: number;
  readonly lanesClosed: number;
  readonly running: number;
  readonly toLand: number;
}

const RUNNING = new Set(["launching", "running", "restarted", "restoring"]);

/** The Muster side of the system: live projects, their work lanes, running agents, packets not yet landed. */
export function fleetStats(projects: readonly Project[]): FleetStats {
  const live = projects.filter((project) => project.state !== "archived");
  const lanes = live.flatMap((project) => project.lanes.filter((lane) => lane.kind === "work" && !lane.archived));
  return {
    projects: live.length,
    lanes: lanes.length,
    lanesClosed: lanes.filter((lane) => lane.state === "closed").length,
    running: live.reduce((sum, project) => sum + project.agents.filter((agent) => RUNNING.has(agent.state)).length, 0),
    toLand: live.reduce((sum, project) => sum + project.packets.filter((packet) => !TERMINAL_PACKET_STATES.includes(packet.state)).length, 0),
  };
}

export interface LatestPost {
  readonly project: string;
  readonly kind: DeskKind;
  readonly title: string;
  readonly ts: number;
}

/** The newest line in any queue: what the system did last. */
export function latestPost(queues: Readonly<Record<string, readonly DeskItem[]>>): LatestPost | null {
  let latest: LatestPost | null = null;
  for (const [project, items] of Object.entries(queues)) {
    for (const item of items) {
      const ts = Date.parse(item.ts);
      if (!Number.isNaN(ts) && (!latest || ts > latest.ts)) latest = { project, kind: item.kind, title: item.title, ts };
    }
  }
  return latest;
}

export interface UnregisteredSpace {
  readonly spaceId: string;
  readonly label: string;
}

/** Keep quiet registered projects visible, without changing ask ranking. */
export function fleetGroups(groups: readonly InboxGroup[], slugs: readonly string[], outside: ReadonlySet<string> = new Set()): InboxGroup[] {
  const known = new Set(groups.map((group) => group.project));
  return [
    ...groups.map((group) => ({ ...group, outsideSpace: outside.has(group.project) })),
    ...[...new Set(slugs)].filter((slug) => !known.has(slug)).sort().map((project) => ({
      project, items: [], counts: { blocked: 0, approval: 0, decision: 0 }, oldestMs: 0, outsideSpace: outside.has(project),
    })),
  ];
}

/** Everything the widget and the sidebar draw, read in one pass. */
export interface SystemView {
  readonly groups: readonly InboxGroup[];
  readonly unregistered?: readonly UnregisteredSpace[];
  readonly posts: Readonly<Record<string, readonly number[]>>;
  readonly fleet: FleetStats | null;
  readonly latest: LatestPost | null;
  readonly now: number;
}

const POST_GLYPH: Readonly<Record<DeskKind, string>> = { ...KIND_GLYPH, done: "🏁", fyi: "📎" };
const TOKEN_CHARS = 32;
const clip = (text: string) => {
  const chars = [...text];
  return chars.length <= TOKEN_CHARS ? text : `${chars.slice(0, TOKEN_CHARS - 1).join("")}…`;
};
/** Whole parts in priority order; a part that does not fit drops, never half-shown. */
const fit = (parts: readonly string[]) => {
  let out = "";
  for (const part of parts) {
    const next = out ? `${out} · ${part}` : part;
    if ([...next].length > TOKEN_CHARS) break;
    out = next;
  }
  return out || null;
};

/**
 * The Switchboard space's sidebar. `now` is the newest desk line and its age,
 * so the row moves as the system does; `agents` is the Muster fleet.
 */
export function switchboardTokens(view: Pick<SystemView, "groups" | "fleet" | "latest" | "now">) {
  const latest = view.latest;
  const fleet = view.fleet;
  const fleetParts = fleet
    ? [`🐑 ${fleet.projects}p`, fleet.running > 0 ? `${fleet.running} run` : "", fleet.toLand > 0 ? `${fleet.toLand} to land` : "", fleet.lanes > 0 ? `${fleet.lanesClosed}/${fleet.lanes} lanes` : ""].filter(Boolean)
    : [];
  return {
    progress: "☎️ switchboard",
    now: latest ? clip(`${POST_GLYPH[latest.kind]} ${formatAge(Math.max(0, view.now - latest.ts))} ${latest.project}: ${latest.title}`) : null,
    agents: fit(fleetParts),
    needs: switchboardNeeds(view.groups),
  };
}
