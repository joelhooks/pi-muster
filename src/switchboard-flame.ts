import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createActor, createMachine } from "xstate";
import { formatAge, KIND_GLYPH, openCount } from "./switchboard.ts";
import type { InboxGroup, OpenKind } from "./switchboard.ts";
import type { ViewTheme } from "./switchboard-view.ts";

export const FLARE_MS = 1500;
export const SETTLE_MS = 2000;
export const IDLE_MS = 60_000;
export const FRAME_MS = 140;
export const WEIGHT: Record<OpenKind, number> = { blocked: 3, approval: 2, decision: 1 };
// Logarithmic age: each doubling of hours adds heat and height; 3 days adds ~6.2.
export const ageHeat = (ms: number) => Math.log2(1 + Math.max(0, ms) / 3_600_000);
export const flameWeight = (group: InboxGroup) => group.items.reduce((sum, item) => sum + WEIGHT[item.kind] * (1 + ageHeat(item.ageMs)), 0);
// Semantic theme tokens, not fixed RGB: error → warning → text is the hot white core.
export const PALETTE: Record<OpenKind, readonly string[]> = {
  blocked: ["error", "warning", "text"], approval: ["warning", "warning", "text"], decision: ["warning", "warning", "warning"],
};
export function flameSummary(groups: readonly InboxGroup[]): string {
  const total = openCount(groups);
  if (!total) return "inbox clear";
  const counts = (["blocked", "approval", "decision"] as const).map((kind) => {
    const count = groups.reduce((n, group) => n + group.counts[kind], 0);
    return count ? `${KIND_GLYPH[kind]}${count}` : "";
  }).filter(Boolean).join(" ");
  return `${total} open · ${counts} · oldest ${formatAge(Math.max(0, ...groups.map((g) => g.oldestMs)))}`;
}
export function flameEnabled(width: number, theme: ViewTheme, env: Readonly<Record<string, string | undefined>>): boolean {
  return width >= 40 && env.NO_COLOR === undefined && env.TERM !== "dumb" && ["error", "warning", "accent"].some((token) => theme.fg(token, "x") !== "x");
}
const noise = (project: string, frame: number, cell: number) => {
  let seed = (frame * 16777619 + cell * 374761393) | 0;
  for (const char of project) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  seed = Math.imul(seed ^ (seed >>> 16), 2246822507);
  return (seed >>> 0) / 0xffffffff;
};
interface Pulse { at: number; type: "flare" | "settle"; previous: InboxGroup }
export class FlameState {
  frame = 0;
  private initialized = false;
  private groups: readonly InboxGroup[] = [];
  private pulses = new Map<string, Pulse>();
  update(groups: readonly InboxGroup[], now: number): boolean {
    const before = new Map(this.groups.map((group) => [group.project, group]));
    let changed = false;
    for (const group of groups) {
      const old = before.get(group.project);
      const oldIds = new Set(old?.items.map((item) => item.id));
      const ids = new Set(group.items.map((item) => item.id));
      const added = group.items.some((item) => !oldIds.has(item.id));
      const removed = old?.items.some((item) => !ids.has(item.id));
      if (added || removed) {
        changed = true;
        if (this.initialized) this.pulses.set(group.project, { at: now, type: removed ? "settle" : "flare", previous: old ?? group });
      }
      before.delete(group.project);
    }
    for (const old of before.values()) if (old.items.length) {
      changed = true;
      if (this.initialized) this.pulses.set(old.project, { at: now, type: "settle", previous: old });
    }
    this.groups = groups;
    this.initialized = true;
    for (const [slug, pulse] of this.pulses) if (now - pulse.at >= (pulse.type === "flare" ? FLARE_MS : SETTLE_MS)) this.pulses.delete(slug);
    return changed;
  }
  land(project: string, now: number): void {
    const group = this.groups.find((g) => g.project === project);
    if (group && !this.pulse(project, now).settle) this.pulses.set(project, { at: now, type: "flare", previous: group });
  }
  pulse(project: string, now: number): { flare: number; settle: number; previous?: InboxGroup } {
    const pulse = this.pulses.get(project);
    const remaining = pulse ? Math.max(0, 1 - (now - pulse.at) / (pulse.type === "flare" ? FLARE_MS : SETTLE_MS)) : 0;
    return { flare: pulse?.type === "flare" ? remaining : 0, settle: pulse?.type === "settle" ? remaining : 0, ...(remaining && pulse ? { previous: pulse.previous } : {}) };
  }
  columns(now: number): readonly InboxGroup[] {
    const groups = [...this.groups];
    for (const [slug, pulse] of this.pulses) if (!groups.some((g) => g.project === slug) && this.pulse(slug, now).settle) groups.push({ ...pulse.previous, items: [], counts: { blocked: 0, approval: 0, decision: 0 }, oldestMs: 0 });
    return groups;
  }
}

export function renderFlame(groups: readonly InboxGroup[], flame: FlameState, width: number, theme: ViewTheme, now: number): string[] {
  const rows = width >= 80 ? 6 : 4;
  const all = flame.columns(now);
  const hot = all.filter((g) => g.items.length || flame.pulse(g.project, now).settle || flame.pulse(g.project, now).flare);
  const cold = all.filter((g) => !hot.includes(g));
  // Quiet embers yield first. At extreme fleet sizes, the ranked leading projects win.
  const columns = [...hot, ...cold.slice(0, Math.max(0, Math.floor(width / 7) - hot.length))].slice(0, Math.floor(width / 2));
  if (!columns.length) return [truncateToWidth(`☎️ ${flameSummary(groups)} · alt+s`, width)];
  const cellWidth = Math.max(1, Math.floor(width / columns.length) - 1);
  const weights = columns.map((group) => {
    const pulse = flame.pulse(group.project, now);
    return flameWeight(group) * (1 + pulse.flare * 0.45) + pulse.flare + (pulse.previous ? Math.max(0, flameWeight(pulse.previous) - flameWeight(group)) * pulse.settle : 0);
  });
  // Scale against the non-flaring peak so a new line can visibly lick above its old height.
  const peak = Math.max(1, ...columns.map((g) => flameWeight(g)), ...columns.map((g) => { const p = flame.pulse(g.project, now); return p.previous ? flameWeight(p.previous) : 0; }));
  const lines: string[] = [];
  for (let y = rows - 1; y >= 0; y--) {
    lines.push(columns.map((group, index) => {
      const weight = weights[index] ?? 0;
      if (!weight) return y === 0 ? theme.fg("dim", "·".padStart(Math.ceil(cellWidth / 2)).padEnd(cellWidth)) : " ".repeat(cellWidth);
      const pulse = flame.pulse(group.project, now);
      const kind = group.items[0]?.kind ?? pulse.previous?.items[0]?.kind ?? "decision";
      const palette = PALETTE[kind];
      const heat = ageHeat(group.oldestMs || pulse.previous?.oldestMs || 0);
      return Array.from({ length: cellWidth }, (_, x) => {
        const edge = Math.abs((x + 0.5) / cellWidth * 2 - 1);
        const height = Math.min(rows, weight / peak * (rows - 0.7)) * (1 - edge * 0.65) + (noise(group.project, flame.frame, x) - 0.5) * 0.9;
        const fill = height - y;
        if (fill <= 0) return " ";
        const glyph = fill < 1 ? "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor(fill * 8))]! : edge > 0.8 ? "░" : edge > 0.6 ? "▒" : edge > 0.35 ? "▓" : "█";
        const core = edge < 0.35 && y < height * (0.45 + Math.min(0.25, heat / 25));
        return theme.fg(palette[core ? 2 : edge < 0.65 ? 1 : 0]!, glyph);
      }).join("");
    }).join(" "));
  }
  lines.push(columns.map((g) => {
    const label = truncateToWidth(`${g.deadDesk ? "☠" : ""}${g.project}`, cellWidth, "");
    return theme.fg(g.items.length ? "muted" : "dim", label + " ".repeat(Math.max(0, cellWidth - visibleWidth(label))));
  }).join(" "));
  lines.push(theme.fg("muted", `${flameSummary(groups)} · alt+s`));
  return lines.map((line) => truncateToWidth(line, width));
}

// Lifecycle sketch: hidden → animated → frozen; SHOW/WAKE resume, HIDE stops.
// No terminal-focus event exists in pi-tui 0.84.3. CSI focus reports, if supplied
// by a host, can still pause via the input listener; otherwise idle is the floor.
const animationMachine = createMachine({
  initial: "hidden", states: {
    hidden: { on: { SHOW: "animated" } },
    animated: { on: { HIDE: "hidden", FREEZE: "frozen", WAKE: "animated" } },
    frozen: { on: { HIDE: "hidden", WAKE: "animated" } },
  },
});
export class FlameAnimation {
  private actor = createActor(animationMachine).start();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastActivity = Date.now();
  private focused = true;
  constructor(private readonly repaint: () => void) {}
  get mode(): string { return String(this.actor.getSnapshot().value); }
  show(visible: boolean): void {
    if (!visible) { this.actor.send({ type: "HIDE" }); this.clear(); }
    else if (this.mode === "hidden") { this.actor.send({ type: "SHOW" }); this.wake(); }
  }
  input(data: string): void {
    if (data === "\x1b[O") { this.focused = false; this.actor.send({ type: "FREEZE" }); this.clear(); }
    else { this.focused = true; this.wake(); }
  }
  wake(): void {
    this.lastActivity = Date.now();
    if (this.mode === "hidden" || !this.focused) return;
    this.actor.send({ type: "WAKE" });
    if (!this.timer) this.arm();
  }
  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (Date.now() - this.lastActivity >= IDLE_MS) { this.actor.send({ type: "FREEZE" }); return; }
      if (this.mode !== "animated") return;
      this.repaint();
      if (this.mode === "animated") this.arm();
    }, FRAME_MS);
  }
  private clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  dispose(): void { this.clear(); this.actor.stop(); }
}
