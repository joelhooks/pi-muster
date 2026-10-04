import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";

import { KIND_GLYPH, KIND_RANK, TICKER_WINDOW_MS, eventText, formatAge, itemRef, openCount } from "./switchboard.ts";
import type { FleetStats, InboxGroup, InboxItem, LatestPost, QueueEvent, SystemView, UnregisteredSpace } from "./switchboard.ts";

/** The slice of Pi's theme the view uses, so tests can pass a plain stub. */
export interface ViewTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type Row = { readonly type: "group"; readonly group: InboxGroup } | { readonly type: "item"; readonly item: InboxItem } | { readonly type: "unregistered"; readonly space: UnregisteredSpace };

export type Intent =
  | { readonly type: "desk"; readonly project: string; readonly item?: InboxItem }
  | { readonly type: "discuss"; readonly item: InboxItem }
  | { readonly type: "answer"; readonly item: InboxItem }
  | { readonly type: "done"; readonly item: InboxItem }
  | { readonly type: "close" };

export const OPEN_HINT = "alt+s";

/**
 * Inbox state shared by the widget and the overlay: which projects are open
 * and where the cursor is. A refresh keeps the cursor on the same item when it
 * still exists, so a new arrival never moves what Joel is reading.
 */
export class SwitchboardState {
  groups: readonly InboxGroup[] = [];
  unregistered: readonly UnregisteredSpace[] = [];
  posts: Readonly<Record<string, readonly number[]>> = {};
  fleet: FleetStats | null = null;
  latest: LatestPost | null = null;
  now = Date.now();
  events: readonly QueueEvent[] = [];
  readonly expanded = new Set<string>();
  cursor = 0;
  private seen = new Set<string>();

  setGroups(groups: readonly InboxGroup[], key: string | null = this.current() ? rowKey(this.current()!) : null): void {
    this.groups = groups;
    // A project that shows up for the first time opens, so a new ask is visible without a keypress.
    for (const group of groups) {
      if (!this.seen.has(group.project)) this.expanded.add(group.project);
      this.seen.add(group.project);
    }
    const rows = this.rows();
    const at = key ? rows.findIndex((row) => rowKey(row) === key) : -1;
    this.cursor = at >= 0 ? at : Math.min(this.cursor, Math.max(0, rows.length - 1));
  }

  setSystem(view: SystemView): void {
    const before = this.current();
    const key = before ? rowKey(before) : null;
    this.unregistered = view.unregistered ?? [];
    this.posts = view.posts;
    this.fleet = view.fleet;
    this.latest = view.latest;
    this.now = view.now;
    this.events = view.events ?? [];
    this.setGroups(view.groups, key);
  }

  rows(): Row[] {
    const rows: Row[] = [];
    for (const group of this.groups) {
      rows.push({ type: "group", group });
      if (this.expanded.has(group.project)) for (const item of group.items) rows.push({ type: "item", item });
    }
    for (const space of this.unregistered) rows.push({ type: "unregistered", space });
    return rows;
  }

  current(): Row | undefined {
    return this.rows()[this.cursor];
  }

  move(delta: number): void {
    const count = this.rows().length;
    if (count > 0) this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
  }

  /** Fold or unfold the project under the cursor; on an item, fold its project and land on the header. */
  toggle(open?: boolean): void {
    const row = this.current();
    if (!row || row.type === "unregistered") return;
    const project = row.type === "group" ? row.group.project : row.item.project;
    const next = open ?? !this.expanded.has(project);
    if (next) this.expanded.add(project);
    else this.expanded.delete(project);
    const header = this.rows().findIndex((candidate) => candidate.type === "group" && candidate.group.project === project);
    if (!next && header >= 0) this.cursor = header;
  }

  toggleAll(): void {
    const allOpen = this.groups.every((group) => this.expanded.has(group.project));
    for (const group of this.groups) {
      if (allOpen) this.expanded.delete(group.project);
      else this.expanded.add(group.project);
    }
    this.cursor = Math.min(this.cursor, Math.max(0, this.rows().length - 1));
  }
}

const rowKey = (row: Row) => row.type === "unregistered" ? `s:${row.space.spaceId}` : (row.type === "group" ? `g:${row.group.project}` : `i:${row.item.project}#${row.item.id}`);

/** Left text and right text on one line, the right edge flush with `width`. */
function spread(left: string, right: string, width: number): string {
  const room = width - visibleWidth(right) - 1;
  if (room < 8) return truncateToWidth(left, width);
  const shown = truncateToWidth(left, room);
  return `${shown}${" ".repeat(Math.max(1, width - visibleWidth(shown) - visibleWidth(right)))}${right}`;
}

function counts(group: InboxGroup, theme: ViewTheme): string {
  return (["blocked", "approval", "decision"] as const)
    .filter((kind) => group.counts[kind] > 0)
    .map((kind) => `${KIND_GLYPH[kind]}${group.counts[kind]}`)
    .map((part) => theme.fg("muted", part))
    .join(" ");
}

/** `gutter` reserves a cursor column in the overlay; the widget has no cursor. */
function groupLine(group: InboxGroup, open: boolean, width: number, theme: ViewTheme, selected = false, gutter = false): string {
  const marker = open ? "▾" : "▸";
  const name = selected ? theme.fg("accent", theme.bold(group.project)) : theme.bold(group.project);
  const cursor = gutter ? (selected ? theme.fg("accent", "▶ ") : "  ") : "";
  const outside = group.outsideSpace ? theme.fg("warning", " ↗") : "";
  if (group.items.length === 0) return truncateToWidth(`${cursor}${theme.fg("dim", `${marker} ${group.project} 0 · quiet`)}${outside}`, width);
  const left = `${cursor}${theme.fg(selected ? "accent" : "dim", marker)} ${name} ${theme.fg("accent", String(group.items.length))}  ${counts(group, theme)}${outside}`;
  return spread(left, theme.fg("dim", formatAge(group.oldestMs)), width);
}

function itemLine(item: InboxItem, width: number, theme: ViewTheme, selected = false): string {
  const title = selected ? theme.fg("accent", item.title) : item.title;
  const left = `${selected ? theme.fg("accent", "  ▶ ") : "    "}${KIND_GLYPH[item.kind]} ${title}`;
  return spread(left, theme.fg("dim", formatAge(item.ageMs)), width);
}

export function headline(groups: readonly InboxGroup[], theme: ViewTheme): string {
  const total = openCount(groups);
  if (total === 0) return `${theme.fg("accent", "☎️ Switchboard")} ${theme.fg("muted", "· inbox clear")}`;
  return `${theme.fg("accent", "☎️ Switchboard")} ${theme.fg("muted", `· ${total} open · ${groups.length} project${groups.length === 1 ? "" : "s"}`)}`;
}

const HEAT = [
  ["dim", "░"],
  ["muted", "▒"],
  ["accent", "▓"],
  ["warning", "█"],
] as const;

/** One cell per bucket: a dim dot for quiet, then four shades scaled to the busiest cell on screen. */
export function heatStrip(counts: readonly number[], peak: number, theme: ViewTheme): string {
  return counts
    .map((count) => {
      if (count === 0 || peak === 0) return theme.fg("dim", "·");
      const [color, glyph] = HEAT[Math.min(HEAT.length - 1, Math.ceil((count / peak) * HEAT.length) - 1)] ?? HEAT[0];
      return theme.fg(color, glyph);
    })
    .join("");
}

function fleetLine(fleet: FleetStats): string {
  return [
    `🐑 ${fleet.projects} project${fleet.projects === 1 ? "" : "s"}`,
    fleet.lanes > 0 ? `${fleet.lanesClosed}/${fleet.lanes} lanes` : "",
    fleet.running > 0 ? `${fleet.running} running` : "",
    fleet.toLand > 0 ? `${fleet.toLand} to land` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Row one: the whole system in a line. Open asks by kind and age, then the
 * Muster fleet. When it does not fit `room`, whole parts drop, the oldest age
 * first and the fleet next, so a narrow pane never shows half a part.
 */
export function systemLine(state: SwitchboardState, theme: ViewTheme, room = Number.POSITIVE_INFINITY): string {
  const total = openCount(state.groups);
  const tally = { blocked: 0, approval: 0, decision: 0 };
  for (const group of state.groups) for (const kind of ["blocked", "approval", "decision"] as const) tally[kind] += group.counts[kind];
  const oldest = Math.max(0, ...state.groups.map((group) => group.oldestMs));
  const asks =
    total === 0
      ? theme.fg("muted", "inbox clear")
      : `${theme.fg("accent", theme.bold(`${total} open`))} ${(["blocked", "approval", "decision"] as const)
          .filter((kind) => tally[kind] > 0)
          .map((kind) => theme.fg("muted", `${KIND_GLYPH[kind]}${tally[kind]}`))
          .join(" ")}`;
  const age = total === 0 ? "" : ` ${theme.fg("dim", `· oldest ${formatAge(oldest)}`)}`;
  const fleet = state.fleet ? `${theme.fg("dim", " │ ")}${theme.fg("muted", fleetLine(state.fleet))}` : "";
  const head = `${theme.fg("accent", "☎️")} ${asks}`;
  const fits = (line: string) => visibleWidth(line) <= room;
  return [`${head}${age}${fleet}`, `${head}${fleet}`, `${head}${age}`].find(fits) ?? head;
}

/** Actions win space. Ticker uses the remaining rows; quiet desks get one count. */
export function renderWidget(state: SwitchboardState, width: number, theme: ViewTheme): string[] {
  const hint = theme.fg("dim", OPEN_HINT);
  const lines = [spread(systemLine(state, theme, width - visibleWidth(hint) - 1), hint, width)];
  const actions = state.groups.flatMap((group) => group.items.map((item) => ({ item, group })))
    .sort((a, b) => KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind] || b.item.ageMs - a.item.ageMs || a.item.project.localeCompare(b.item.project));
  for (const { item, group } of actions.slice(0, 4)) {
    const flag = group.deadDesk ? " ☠ no live desk" : "";
    // Keep the liveness marker visible even when the title is long.
    lines.push(spread(`${KIND_GLYPH[item.kind]} ${item.project}#${item.id} ${item.title.replace(/\s+/g, " ")}`, `${formatAge(item.ageMs)}${flag}`, width));
  }
  if (actions.length > 4) lines.push(theme.fg("dim", `+${actions.length - 4} more`));
  const quiet = state.groups.filter((group) => group.items.length === 0).length;
  const events = state.events.filter((event) => state.now - event.ts < TICKER_WINDOW_MS && event.ts <= state.now).slice(0, 5);
  for (const event of events.slice(0, 10 - lines.length - (quiet ? 1 : 0))) lines.push(theme.fg("muted", eventText(event, state.now)));
  if (quiet) lines.push(theme.fg("dim", `+${quiet} quiet`));
  return lines.map((line) => truncateToWidth(line, width));
}

const HELP = "↑↓ · space/c fold · enter desk · e discuss here · a answer · d done · esc";

/** The overlay body: the same rows with a cursor, then the selected item's detail. */
export function renderOverlay(state: SwitchboardState, width: number, height: number, theme: ViewTheme): string[] {
  const inner = Math.max(20, width - 4);
  const border = (text: string) => theme.fg("border", text);
  const frame = (content: string) => `${border("│")} ${truncateToWidth(content, inner)}${" ".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(content, inner))))} ${border("│")}`;
  const title = ` ${headline(state.groups, theme)} `;
  const top = `${border("╭─")}${title}${border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(title)))}╮`)}`;
  const bottom = border(`╰${"─".repeat(Math.max(0, width - 2))}╯`);

  const rows = state.rows();
  const current = state.current();
  const group = current?.type === "group" ? current.group : current?.type === "item" ? state.groups.find((group) => group.project === current.item.project) : undefined;
  const detail = current?.type === "item" ? detailLines(current.item, inner, theme) : [];
  if (group?.outsideSpace) detail.push(theme.fg("warning", "↗ owner/desk outside space"));
  const listRoom = Math.max(3, height - 4 - (detail.length ? detail.length + 1 : 0));
  const start = Math.max(0, Math.min(state.cursor - Math.floor(listRoom / 2), rows.length - listRoom));
  const list = rows.slice(start, start + listRoom).map((row, offset) => {
    const selected = start + offset === state.cursor;
    if (row.type === "unregistered") return truncateToWidth(`${selected ? "▶ " : "  "}${theme.fg("dim", `${row.space.label} · unregistered · project_open adopts it`)}`, inner);
    return row.type === "group"
      ? groupLine(row.group, state.expanded.has(row.group.project), inner, theme, selected, true)
      : itemLine(row.item, inner, theme, selected);
  });
  if (rows.length === 0) list.push(theme.fg("muted", "Nothing waits on you."));

  const out = [top, ...list.map(frame)];
  if (detail.length) out.push(frame(theme.fg("border", "─".repeat(inner))), ...detail.map(frame));
  out.push(frame(theme.fg("dim", HELP)), bottom);
  return out.map((line) => truncateToWidth(line, width));
}

function detailLines(item: InboxItem, width: number, theme: ViewTheme): string[] {
  const meta = theme.fg("dim", `${itemRef(item)} · ${item.kind} · from ${item.from} · ${formatAge(item.ageMs)} ago`);
  const body = item.body ? wrapTextWithAnsi(item.body, width).slice(0, 4) : [];
  const refs = item.refs.length ? [theme.fg("muted", `refs: ${item.refs.join(", ")}`)] : [];
  return [meta, ...body, ...refs];
}

/** Map one keypress to a state change or an intent for the caller. */
export function handleKey(state: SwitchboardState, data: string): Intent | null {
  if (matchesKey(data, "escape") || data === "q") return { type: "close" };
  if (matchesKey(data, "up") || data === "k") state.move(-1);
  else if (matchesKey(data, "down") || data === "j") state.move(1);
  else if (matchesKey(data, "space") || matchesKey(data, "tab")) state.toggle();
  else if (matchesKey(data, "left") || data === "h") state.toggle(false);
  else if (matchesKey(data, "right") || data === "l") state.toggle(true);
  else if (data === "c") state.toggleAll();
  else {
    const row = state.current();
    if (!row) return null;
    if (matchesKey(data, "enter") && row.type !== "unregistered") {
      return row.type === "group" ? { type: "desk", project: row.group.project } : { type: "desk", project: row.item.project, item: row.item };
    } else if (row.type === "item" && data === "e") return { type: "discuss", item: row.item };
    else if (row.type === "item" && data === "a") return { type: "answer", item: row.item };
    else if (row.type === "item" && data === "d") return { type: "done", item: row.item };
  }
  return null;
}

/** The overlay component: it owns no data, only renders `state` and reports intents. */
export class SwitchboardOverlay implements Component, Focusable {
  focused = false;

  constructor(
    private readonly state: SwitchboardState,
    private readonly theme: ViewTheme,
    private readonly rows: () => number,
    private readonly done: (intent: Intent) => void,
    private readonly redraw: () => void,
  ) {}

  handleInput(data: string): void {
    const intent = handleKey(this.state, data);
    if (intent) this.done(intent);
    else this.redraw();
  }

  render(width: number): string[] {
    return renderOverlay(this.state, width, this.rows(), this.theme);
  }

  invalidate(): void {}
}
