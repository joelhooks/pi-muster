import type { AgentState, DeskItem, Project } from "./domain.ts";
import { TERMINAL_PACKET_STATES } from "./domain.ts";

/**
 * Sidebar tokens are a projection of machine state and the desk queue. They
 * never feed back into a decision. Herdr's widest sidebar is 36 columns.
 */
export const TOKEN_SOURCE = "user:muster.v1";
export const TOKEN_MAX_CHARS = 32;
/** A lost owner stops refreshing; its tokens expire instead of lying for days. */
export const TOKEN_TTL_MS = 2 * 60 * 60_000;

export interface Tokens {
  /** What the space is doing: the owner's headline, else the next action. */
  readonly now: string | null;
  readonly progress: string | null;
  readonly agents: string | null;
  readonly needs: string | null;
}

function clip(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length <= TOKEN_MAX_CHARS ? chars.join("") : `${chars.slice(0, TOKEN_MAX_CHARS - 1).join("")}…`;
}

/** Join parts in priority order, dropping whole trailing parts rather than cutting a word. */
function fit(parts: readonly string[]): string | null {
  let out = "";
  for (const part of parts) {
    const next = out ? `${out} · ${part}` : part;
    if ([...next].length > TOKEN_MAX_CHARS) break;
    out = next;
  }
  return out || (parts[0] ? clip(parts[0]) : null);
}

const AGENT_BUCKETS: ReadonlyArray<readonly [string, readonly AgentState[]]> = [
  ["run", ["launching", "running", "restarted", "restoring"]],
  ["silent", ["silent", "nudged"]],
  ["rpt", ["reported", "verified"]],
  ["intr", ["interrupted"]],
  ["fail", ["failed"]],
];

/** Desk items that still wait on Joel: a decision, approval, or block no later item resolved. */
export function openDeskItems(items: readonly DeskItem[]): DeskItem[] {
  const resolved = new Set(items.flatMap((item) => (item.resolves ? [item.resolves] : [])));
  return items.filter(
    (item) => (item.kind === "decision" || item.kind === "approval" || item.kind === "blocked") && !resolved.has(item.id),
  );
}

/** Facts only an owner pass observes, never stored: they would go stale between passes. */
export interface LiveCounts {
  /** Bridge lanes whose newest turn failed prompt capture and that nobody has typed to since. */
  readonly stuck?: number;
}

/** Joel reads `needs` as a sentence: the oldest open item by name, then how many more. */
function needsToken(open: readonly DeskItem[]): string | null {
  const first = open[0];
  if (!first) return null;
  const more = open.length > 1 ? ` +${open.length - 1}` : "";
  const room = TOKEN_MAX_CHARS - [...more].length - 3;
  const title = [...first.title.replace(/\s+/g, " ").trim()];
  return `🙋 ${title.length <= room ? title.join("") : `${title.slice(0, room - 1).join("")}…`}${more}`;
}

export function deriveTokens(project: Project, desk: readonly DeskItem[], live: LiveCounts = {}): Tokens {
  const work = project.lanes.filter((lane) => lane.kind === "work" && !lane.archived);
  const lanesDone = work.filter((lane) => lane.state === "closed").length;
  const toLand = project.packets.filter((packet) => !TERMINAL_PACKET_STATES.includes(packet.state)).length;
  const progress =
    project.state === "archived"
      ? "🐑 archived"
      : fit(
          [
            work.length > 0 ? `🐑 ${lanesDone}/${work.length} lanes` : "🐑 no lanes",
            toLand > 0 ? `${toLand} to land` : "",
            project.state === "reviewing" ? "review" : "",
          ].filter(Boolean),
        );
  const headline = (project.headline ?? project.nextAction).trim();
  const now = project.state === "archived" || !headline ? null : clip(headline);

  const agentParts: string[] = live.stuck ? [`⚠️ ${live.stuck} stuck`] : [];
  for (const [label, states] of AGENT_BUCKETS) {
    const count = project.agents.filter((agent) => states.includes(agent.state)).length;
    if (count > 0) agentParts.push(`${count} ${label}`);
  }

  return { now, progress, agents: fit(agentParts), needs: needsToken(openDeskItems(desk)) };
}
