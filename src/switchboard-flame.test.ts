import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ActivityClock, ActivityState, BUCKET_MS, activitySummary, renderActivity } from "./switchboard-flame.ts";
import { SwitchboardState, renderWidget, renderOverlay } from "./switchboard-view.ts";
import { registerSwitchboard } from "./switchboard-ext.ts";
import { QueueReader, queueDir, inbox } from "./switchboard.ts";
import { queuePath } from "./desk.ts";
import { harness } from "./test-support.ts";
import type { DeskItem } from "./domain.ts";
const now = Date.parse("2026-10-04T00:00:00Z");
const post = (kind: DeskItem["kind"], ts = now, id: string = kind): DeskItem => ({ id, kind, from: "desk", title: "界 🌈", ts: new Date(ts).toISOString() });
const plain = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const codes: Record<string, number> = { error: 31, warning: 33, success: 32, accent: 93, muted: 90, dim: 2 };
const ansi = { ...plain, fg: (c: string, s: string) => `\x1b[${codes[c] ?? 0}m${s}\x1b[0m` };

describe("timestamp activity chart", () => {
  it("buckets every line across queues; reloads the same history, not just five ticker events", () => {
    const queues = { a: [post("blocked", now - 1), post("fyi", now - BUCKET_MS), post("done", now - BUCKET_MS - 1)], b: Array.from({ length: 12 }, (_, n) => post("decision", now, String(n))) };
    const activity = new ActivityState();
    expect(activity.update(queues)).toBe(true);
    expect(activity.columns(3, now).map((b) => b?.count)).toEqual([1, 2, 12]);
    expect(activity.update(queues)).toBe(false);
    const reload = new ActivityState(); reload.update(queues);
    expect(renderActivity([], reload, 40, ansi, now)).toEqual(renderActivity([], activity, 40, ansi, now));
    expect(activity.columns(3, now + BUCKET_MS).map((b) => b?.count)).toEqual([2, 12, undefined]);
  });
  it("grows the right edge, scrolls on rollover, and captures three successive renders", () => {
    const activity = new ActivityState(); activity.update({ p: [post("fyi")] });
    const before = renderActivity([], activity, 40, plain, now);
    expect(before[0]).toBe(" ".repeat(40));
    expect(before[1]).toBe(" ".repeat(39) + "▂");
    activity.update({ p: [post("fyi"), post("fyi", now + 1, "second"), post("fyi", now + 2, "third")] });
    const after = renderActivity([], activity, 40, plain, now + 2);
    expect(after[1]).toBe(" ".repeat(39) + "▆");
    const rollover = renderActivity([], activity, 40, plain, now + BUCKET_MS);
    expect(rollover[1]).toBe(" ".repeat(38) + "▆ ");
    writeFileSync("/tmp/activity-chart-frames.txt", [before, after, rollover].map((lines, n) => `FRAME ${n + 1}\n${lines.join("\n")}`).join("\n\n") + "\n");
  });
  it("is blank when quiet and never jitters between arrivals or rollovers", () => {
    const activity = new ActivityState();
    expect(renderActivity([], activity, 40, plain, now).slice(0, 2)).toEqual([" ".repeat(40), " ".repeat(40)]);
    activity.update({ p: [post("done", now - 60_000)] });
    const before = renderActivity([], activity, 80, ansi, now);
    expect(renderActivity([], activity, 80, ansi, now + 29_999)).toEqual(before);
    expect(renderActivity([], activity, 80, ansi, now + BUCKET_MS)).not.toEqual(before);
  });
  it("uses dominant-kind theme tokens, with resolving lines green", () => {
    for (const [kind, token] of [["blocked", "error"], ["approval", "warning"], ["decision", "warning"], ["done", "success"], ["fyi", "dim"]] as const) {
      const activity = new ActivityState(); activity.update({ p: [post(kind)] });
      const fg = vi.fn(ansi.fg);
      renderActivity([], activity, 40, { ...ansi, fg }, now);
      expect(fg).toHaveBeenCalledWith(token, "▂");
    }
    const activity = new ActivityState();
    activity.update({ p: [post("blocked"), { ...post("fyi"), resolves: "b" }, post("done")] });
    expect(renderActivity([], activity, 40, ansi, now)[1]).toContain("\x1b[32m▆");
  });
  it("summarizes open counts, latest event and dead desks", () => {
    const activity = new ActivityState(); activity.update({ drovr: [post("done", now - 120_000)] });
    const groups = inbox({ p: [post("blocked"), post("decision")] }, now).map((g) => ({ ...g, deadDesk: true }));
    expect(activitySummary(groups, activity, now)).toBe("2 open ⛔1 ❓1 · drovr ✅ 2m · ☠p");
  });
  it("fits narrow and wide glyphs at 40, 80, 160 and falls back for NO_COLOR", () => {
    const state = new SwitchboardState(); state.now = now;
    const queues = { "界🌈project": [post("blocked")] };
    state.activity.update(queues); state.setGroups(inbox(queues, now).map((g) => ({ ...g, deadDesk: true })));
    for (const width of [0, 20, 39, 40, 80, 160]) {
      renderWidget(state, width, ansi, {}, now).forEach((line) => expect(visibleWidth(line)).toBeLessThanOrEqual(width));
      renderOverlay(state, width, 28, ansi).forEach((line) => expect(visibleWidth(line)).toBeLessThanOrEqual(width));
    }
    for (const env of [{ NO_COLOR: "" }, { TERM: "dumb" }]) {
      const lines = renderWidget(state, 80, ansi, env, now);
      expect(lines).toHaveLength(1); expect(lines[0]).not.toContain("\x1b"); expect(lines[0]).toContain("☠");
      for (const width of [1, 20, 40, 80, 160]) {
        const fallback = renderWidget(state, width, ansi, env, now);
        expect(fallback[0]).not.toContain("\x1b");
        expect(visibleWidth(fallback[0]!)).toBeLessThanOrEqual(width);
      }
    }
    expect(renderWidget(state, 80, plain, {}, now)).toHaveLength(1);
    expect(renderWidget(state, 80, ansi, {}, now)).toHaveLength(3);
  });
  it("reconstructs resolved and FYI history from real queue files", () => {
    const h = harness(); const path = queuePath("p", h.home); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(post("blocked")) + "\n");
    appendFileSync(path, JSON.stringify({ ...post("fyi", now + 1), resolves: "blocked" }) + "\n");
    const reader = new QueueReader(); const activity = new ActivityState(); activity.update(reader.read(queueDir(h.home)));
    expect(activity.columns(1, now)[0]).toMatchObject({ count: 2, kinds: { blocked: 1, done: 1 } });
    expect(inbox(reader.read(queueDir(h.home)), now + 1)).toEqual([]);
  });
});

describe("bucket clock lifecycle", () => {
  it("only repaints at boundaries; stops hidden, blurred or disposed", () => {
    vi.useFakeTimers(); vi.setSystemTime(now + 12_345);
    try {
      const repaint = vi.fn(); const clock = new ActivityClock(repaint, () => Date.now());
      expect(vi.getTimerCount()).toBe(0); clock.show(true);
      vi.advanceTimersByTime(17_654); expect(repaint).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); expect(repaint).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(BUCKET_MS); expect(repaint).toHaveBeenCalledTimes(2);
      clock.input("\x1b[O"); expect(clock.mode).toBe("paused"); expect(vi.getTimerCount()).toBe(0);
      clock.input("\x1b[I"); expect(clock.mode).toBe("visible"); expect(vi.getTimerCount()).toBe(1);
      clock.show(false); expect(vi.getTimerCount()).toBe(0);
      clock.show(true); clock.dispose(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("deactivation removes the widget clock, input listener and queue poll", async () => {
    const h = harness(); const path = queuePath("p", h.home);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(post("blocked")) + "\n");
    vi.useFakeTimers(); vi.setSystemTime(now);
    const handlers = new Map<string, Function>(); const commands = new Map<string, Function>();
    const render = vi.fn(); const removeInput = vi.fn();
    let widget: { render(width: number): string[] } | undefined;
    const ctx = { sessionManager: { getSessionId: () => "activity-test" }, ui: { setStatus() {}, setWidget: (_: string, factory?: Function) => { widget = factory?.({ requestRender: render, addInputListener: () => removeInput }, ansi); }, notify() {} } };
    registerSwitchboard({ registerFlag() {}, registerShortcut() {}, registerCommand: (name: string, opts: { handler: Function }) => commands.set(name, opts.handler), registerTool() {}, getFlag: () => true, on: (name: string, fn: Function) => handlers.set(name, fn) } as never, { env: { HOME: h.home }, layer: () => h.layer, run: async () => { throw new Error("no model turn"); } });
    try {
      await handlers.get("session_start")!(null, ctx); widget?.render(80);
      expect(vi.getTimerCount()).toBe(2);
      const count = render.mock.calls.length;
      vi.advanceTimersByTime(420); expect(render).toHaveBeenCalledTimes(count);
      widget?.render(20); expect(vi.getTimerCount()).toBe(1);
      widget?.render(80); expect(vi.getTimerCount()).toBe(2);
      await commands.get("switchboard")!("off", ctx);
      expect(removeInput).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(BUCKET_MS); expect(render).toHaveBeenCalledTimes(count);
    } finally { handlers.get("session_shutdown")!(); vi.useRealTimers(); }
  });
});
