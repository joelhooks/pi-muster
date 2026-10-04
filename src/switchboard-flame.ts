import { truncateToWidth } from "@earendil-works/pi-tui";
import { createActor, createMachine } from "xstate";
import type { DeskItem } from "./domain.ts";
import { formatAge, KIND_GLYPH, openCount } from "./switchboard.ts";
import type { InboxGroup } from "./switchboard.ts";
import type { ViewTheme } from "./switchboard-view.ts";

export const BUCKET_MS = 30_000;
const KINDS = ["blocked", "approval", "decision", "done", "fyi"] as const;
type ActivityKind = typeof KINDS[number];
export const ACTIVITY_COLOR: Record<ActivityKind, string> = {
  blocked: "error", approval: "warning", decision: "warning", done: "success", fyi: "dim",
};
const GLYPH: Record<ActivityKind, string> = { ...KIND_GLYPH, done: "✅", fyi: "📎" };
interface Bucket { count: number; kinds: Record<ActivityKind, number> }
interface LastEvent { project: string; kind: ActivityKind; ts: number }
const bucketAt = (now: number) => Math.floor(now / BUCKET_MS);

/** Derived from every decoded queue line, including FYIs and resolving lines.
 * No arrival cache: reopening reconstructs exactly the same timestamp buckets. */
export class ActivityState {
  private buckets = new Map<number, Bucket>();
  latest: LastEvent | undefined;
  update(queues: Readonly<Record<string, readonly DeskItem[]>>): boolean {
    const buckets = new Map<number, Bucket>();
    let latest: LastEvent | undefined;
    for (const [project, items] of Object.entries(queues)) for (const item of items) {
      const ts = Date.parse(item.ts);
      if (!Number.isFinite(ts)) continue;
      const kind = item.resolves ? "done" : item.kind;
      const at = bucketAt(ts);
      const bucket = buckets.get(at) ?? { count: 0, kinds: { blocked: 0, approval: 0, decision: 0, done: 0, fyi: 0 } };
      bucket.count++;
      bucket.kinds[kind]++;
      buckets.set(at, bucket);
      if (!latest || ts >= latest.ts) latest = { project, kind, ts };
    }
    const key = (map: Map<number, Bucket>) => JSON.stringify([...map].sort(([a], [b]) => a - b));
    const changed = key(buckets) !== key(this.buckets) || JSON.stringify(latest) !== JSON.stringify(this.latest);
    this.buckets = buckets;
    this.latest = latest;
    return changed;
  }
  columns(width: number, now: number): readonly (Bucket | undefined)[] {
    const right = bucketAt(now);
    return Array.from({ length: Math.max(0, width) }, (_, n) => this.buckets.get(right - width + 1 + n));
  }
}

export function activitySummary(groups: readonly InboxGroup[], activity: ActivityState, now: number): string {
  const counts = (["blocked", "approval", "decision"] as const).map((kind) => {
    const count = groups.reduce((n, group) => n + group.counts[kind], 0);
    return count ? `${KIND_GLYPH[kind]}${count}` : "";
  }).filter(Boolean).join(" ");
  // Ages change at bucket boundaries too, never on an unrelated host repaint.
  const clock = bucketAt(now) * BUCKET_MS;
  const last = activity.latest;
  const event = last && last.ts < clock + BUCKET_MS ? ` · ${last.project} ${GLYPH[last.kind]} ${formatAge(Math.max(0, clock - last.ts))}` : "";
  const dead = groups.filter((g) => g.deadDesk).map((g) => `☠${g.project}`).join(" ");
  const total = openCount(groups);
  return `${total ? `${total} open` : "0 open · inbox clear"}${counts ? ` ${counts}` : ""}${event}${dead ? ` · ${dead}` : ""}`;
}

export function activityEnabled(width: number, theme: ViewTheme, env: Readonly<Record<string, string | undefined>>): boolean {
  return width >= 40 && env.NO_COLOR === undefined && env.TERM !== "dumb" && ["error", "warning", "accent"].some((token) => theme.fg(token, "x") !== "x");
}

export function renderActivity(groups: readonly InboxGroup[], activity: ActivityState, width: number, theme: ViewTheme, now: number): string[] {
  const columns = activity.columns(width, now);
  const rows = 2;
  // Eight events is the minimum full-scale: a lone post is not a towering bar.
  const peak = Math.max(8, ...columns.map((column) => column?.count ?? 0));
  const lines = [1, 0].map((row) => columns.map((column) => {
    if (!column) return " ";
    const units = Math.ceil(column.count / peak * rows * 8) - row * 8;
    if (units <= 0) return " ";
    // Ties favor the more actionable kind; resolved lines count as done.
    const kind = KINDS.reduce((lead, candidate) => column.kinds[candidate] > column.kinds[lead] ? candidate : lead);
    return theme.fg(ACTIVITY_COLOR[kind], "▁▂▃▄▅▆▇█"[Math.min(8, units) - 1]!);
  }).join(""));
  lines.push(theme.fg("muted", `${activitySummary(groups, activity, now)} · alt+s`));
  return lines.map((line) => truncateToWidth(line, width));
}

// Lifecycle: hidden owns no clock; visible schedules one bucket boundary;
// focus loss pauses it until input restores focus. No idle animation.
const clockMachine = createMachine({ initial: "hidden", states: {
  hidden: { on: { SHOW: "visible" } },
  visible: { on: { HIDE: "hidden", BLUR: "paused" } },
  paused: { on: { HIDE: "hidden", FOCUS: "visible" } },
} });
export class ActivityClock {
  private actor = createActor(clockMachine).start();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly repaint: () => void, private readonly now: () => number = Date.now) {}
  get mode(): string { return String(this.actor.getSnapshot().value); }
  show(visible: boolean): void {
    if (!visible) { this.actor.send({ type: "HIDE" }); this.clear(); }
    else if (this.mode === "hidden") { this.actor.send({ type: "SHOW" }); this.arm(); }
  }
  input(data: string): void {
    if (data === "\x1b[O") { this.actor.send({ type: "BLUR" }); this.clear(); }
    else if (this.mode === "paused") { this.actor.send({ type: "FOCUS" }); this.repaint(); this.arm(); }
  }
  private arm(): void {
    if (this.timer || this.mode !== "visible") return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.mode !== "visible") return;
      this.repaint();
      this.arm();
    }, BUCKET_MS - this.now() % BUCKET_MS);
  }
  private clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  dispose(): void { this.clear(); this.actor.stop(); }
}
