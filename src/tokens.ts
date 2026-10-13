import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDeploySection, DEPLOY_NAMES, DEPLOY_SECTION, type DeployLevel } from "./domain.ts";
import { formatAge } from "./switchboard.ts";
import type { AgentState, DeskItem, Lane, Project, TurnRecord } from "./domain.ts";
import { sessionChain } from "./ops.ts";
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

export function deployPosture(project: Project) {
  const path = join(project.dir, "VISION.md");
  let section: ReturnType<typeof decodeDeploySection>;
  try { section = existsSync(path) ? decodeDeploySection(readFileSync(path, "utf8")) : { missing: true }; }
  catch (error) { section = { missing: false, issue: `unreadable Deploy posture: ${String(error)}` }; }
  const level = section.level ?? project.policy?.deployLevel ?? 1;
  const source = section.level !== undefined ? "VISION.md" : project.policy?.deployLevel !== undefined ? "policy" : "default";
  const mismatch = section.level !== undefined && project.policy?.deployLevel !== undefined && section.level !== project.policy.deployLevel
    ? `policy ${project.policy.deployLevel} differs; VISION.md wins` : null;
  return { level, source, notes: [section.issue, mismatch, section.missing ? `Add to VISION.md:\n${DEPLOY_SECTION}` : null].filter((note): note is string => !!note) };
}
export function laneDeployLevel(lane: Lane, level: DeployLevel): DeployLevel {
  return lane.deployLevel === undefined || lane.deployLevel > level ? level : lane.deployLevel;
}
export function deployPostureLine(project: Project): string {
  const posture = deployPosture(project);
  return [`Deploy posture: Level: ${posture.level} (${DEPLOY_NAMES[posture.level]}), source: ${posture.source}`, ...posture.notes].join("\n");
}

/** Role and retro tabs are not feature WIP. Archived undelivered work still counts. */
export function inFlight(project: Project): Lane[] {
  const { level } = deployPosture(project);
  return project.lanes.filter(lane => lane.kind === "work" &&
    !(lane.delivery === "deployed" && laneDeployLevel(lane, level) >= 2) &&
    (lane.state === "open" || lane.state === "draining" ||
      (lane.state === "closed" && (lane.delivery === "landed" || lane.delivery === "deployed"))));
}
/** Unranked work follows ranked work; creation order breaks ties. */
export function backlog(project: Project): Lane[] {
  return project.lanes.filter(lane => lane.kind === "work" && lane.state === "proposed" && !lane.archived)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
export function openSlots(project: Project): number | null {
  const limit = project.policy?.wipLimit ?? null;
  return limit === null ? null : Math.max(0, limit - inFlight(project).length);
}
export function wipRefusal(project: Project, slug: string, kind: Lane["kind"], now: number): string | null {
  if (kind === "retro") {
    const running = project.lanes.find(lane => lane.kind === "retro" && lane.slug !== slug && (lane.state === "open" || lane.state === "draining"));
    return running ? `retro: ${running.slug} is ${running.state}; finish it before opening another retro lane.` : null;
  }
  const lanes = inFlight(project);
  const limit = project.policy?.wipLimit ?? null;
  if (kind !== "work" || limit === null || lanes.some(lane => lane.slug === slug) || lanes.length < limit) return null;
  return `WIP ${lanes.length}/${limit}: ${lanes.map(lane => `${lane.slug} (${lane.delivery ?? "none"}, ${formatAge(Math.max(0, now - Date.parse(lane.createdAt)))})`).join(", ")}. Park it in the backlog with lane_open open: false; rank it with rank, or lift the project's wipLimit with project_update.`;
}
export function flowLine(project: Project, now: number = Date.now()): string {
  const lanes = inFlight(project);
  const limit = project.policy?.wipLimit ?? null;
  const history = project.lanes.filter(lane => lane.kind === "work").flatMap(lane => lane.deliveryHistory ??
    (lane.deliveryAt ? [{ stage: lane.delivery ?? "none", at: lane.deliveryAt, evidence: lane.deliveryEvidence ?? "" }] : []));
  // Count lanes, not repeated proof entries. First proof ends that lane's cycle.
  const proven = project.lanes.filter(lane => lane.kind === "work").flatMap(lane => {
    const times = (lane.deliveryHistory ?? []).filter(entry => entry.stage === "proven").map(entry => Date.parse(entry.at));
    if (!times.length && lane.delivery === "proven" && lane.deliveryAt) times.push(Date.parse(lane.deliveryAt));
    if (!times.length) return [];
    const at = Math.min(...times);
    return at <= now ? [{ at, cycle: at - Date.parse(lane.openedAt ?? lane.createdAt) }] : [];
  }).sort((a, b) => b.at - a.at);
  const cycles = proven.slice(0, 10).map(entry => entry.cycle).filter(ms => ms >= 0).sort((a, b) => a - b);
  const middle = Math.floor(cycles.length / 2);
  const median = cycles.length ? (cycles[middle]! + cycles[Math.floor((cycles.length - 1) / 2)]!) / 2 : null;
  const lastProven = proven[0]?.at;
  const lastMove = Math.max(lastProven ?? 0, ...history.map(entry => Date.parse(entry.at)));
  const oldest = lanes.length ? Math.min(...lanes.map(lane => Date.parse(lane.createdAt))) : now;
  const stalled = lanes.length > 0 && now - Math.max(lastMove, oldest) > (project.policy?.flowStallMin ?? 120) * 60_000;
  const unlanded = project.packets.some(packet => !TERMINAL_PACKET_STATES.includes(packet.state) && now - Date.parse(packet.reportedAt) > (project.policy?.landWaitMin ?? 30) * 60_000);
  const { level } = deployPosture(project);
  const watching = project.lanes.filter(lane => lane.kind === "work" && lane.delivery === "deployed" && laneDeployLevel(lane, level) >= 2);
  const landedAll = lanes.filter(lane => lane.delivery === "landed" || lane.delivery === "deployed");
  // Owl (drovr), 2026-10-12: a lane landed on a long-lived branch waits for that branch to merge, not for a release.
  const landed = landedAll.filter(lane => releaseBase(lane.base));
  const onBranch = new Map<string, typeof landedAll>();
  for (const lane of landedAll) if (!releaseBase(lane.base)) onBranch.set(lane.base!, [...(onBranch.get(lane.base!) ?? []), lane]);
  const age = (lane: (typeof landedAll)[number]) => `${lane.slug} ${formatAge(Math.max(0, now - Date.parse(lane.deliveryAt ?? lane.updatedAt)))}`;
  const slots = openSlots(project);
  const next = backlog(project)[0];
  const retro = project.lanes.find(lane => lane.kind === "retro" && (lane.state === "open" || lane.state === "draining"));
  const ago = (at: number) => { const age = formatAge(Math.max(0, now - at)); return age === "now" ? "just now" : `${age} ago`; };
  return [
    `${stalled || unlanded ? "⚠ not flowing · " : ""}WIP ${lanes.length}/${limit ?? "off"}`,
    ...(slots ? [`${slots} open`, next ? `next: ${next.slug}` : "backlog empty"] : []),
    ...(retro ? [`retro: running ${retro.slug}`] : []),
    `landed, not live: ${landed.map(age).join(", ") || "none"}`,
    ...[...onBranch].map(([branch, waiting]) => `waiting on ${branch} to merge: ${waiting.map(age).join(", ")}`),
    ...(watching.length ? [`watching: ${watching.map(lane => lane.slug).join(", ")}`] : []),
    ...(lanes.length ? [`oldest in flight ${formatAge(Math.max(0, now - oldest))}`] : []),
    ...(lastProven !== undefined ? [`last proven ${ago(lastProven)}`] : []),
    ...(median !== null ? [`cycle ${formatAge(median)}`] : []),
    ...(proven.length ? [`${proven.filter(entry => now - entry.at <= 7 * 86_400_000).length}/wk`] : []),
  ].join(" · ").replace(/[\r\n]+/g, " ");
}

/** A null base is the repo default branch; `main`/`master`, optionally `<remote>/`, also ship with a release. */
export const releaseBase = (base: string | null | undefined) => !base || /^(?:[\w.-]+\/)?(?:main|master)$/.test(base);

/**
 * S5 live proof, 2026-10-13: detached launch jobs and other Pis publish with an empty turn log, and their row-state
 * `$agents` overwrote the owner's turn-derived one ("2 working · 1 idle" became "4 run"). A publisher that has no
 * usable turn record for any live turn-enabled row leaves `$agents` alone; Herdr keeps a token a report omits.
 */
export function lacksTurnEvidence(project: Project, turns: ReadonlyMap<string, TurnRecord>): boolean {
  const enabled = project.agents.filter(row => row.state !== "closed" && (row.restore?.env ?? row.profile.env).RATKING_TURN_RECORDS === "1");
  return enabled.length > 0 && !enabled.some(row => {
    const record = turns.get(`${project.slug}/${row.name}`);
    return record !== undefined && sessionChain(row).includes(record.session);
  });
}

export function deriveTokens(project: Project, desk: readonly DeskItem[], live: LiveCounts = {}, turns: ReadonlyMap<string, TurnRecord> = new Map()): Tokens {
  const work = project.lanes.filter((lane) => lane.kind === "work" && !lane.archived);
  const lanesDone = work.filter((lane) => lane.state === "closed" && lane.delivery !== "landed" && lane.delivery !== "deployed").length;
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
  const turnCounts = { working: 0, blocked: 0, idle: 0, gone: 0 };
  const fallback = project.agents.filter(row => {
    if (row.state === "closed") return false;
    const record = turns.get(`${project.slug}/${row.name}`);
    if (!record || !sessionChain(row).includes(record.session)) return true;
    const bucket = record.state === "crashed" ? "gone" : record.state === "done" ? "idle" : record.state;
    turnCounts[bucket]++;
    return false;
  });
  for (const [label, count] of Object.entries(turnCounts)) {
    if (count > 0) agentParts.push(`${count} ${label}`);
  }
  for (const [label, states] of AGENT_BUCKETS) {
    const count = fallback.filter((agent) => states.includes(agent.state)).length;
    if (count > 0) agentParts.push(`${count} ${label}`);
  }

  return { now, progress, agents: fit(agentParts), needs: needsToken(openDeskItems(desk)) };
}
