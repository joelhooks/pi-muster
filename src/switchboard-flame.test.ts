import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerSwitchboard } from "./switchboard-ext.ts";
import { queuePath } from "./desk.ts";
import { harness } from "./test-support.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FlameAnimation, FlameState, FLARE_MS, SETTLE_MS, IDLE_MS, ageHeat, flameWeight, PALETTE, renderFlame } from "./switchboard-flame.ts";
import { SwitchboardState, renderWidget, renderOverlay } from "./switchboard-view.ts";
import { QueueReader, queueDir, fleetGroups, inbox } from "./switchboard.ts";
import type { DeskItem } from "./domain.ts";
const now = Date.parse("2026-10-04T00:00:00Z");
const ask = (kind: DeskItem["kind"], id: string = kind, age = 0): DeskItem => ({ id, kind, from: "desk", title: "界 🌈", ts: new Date(now - age).toISOString() });
const groups = inbox({ "界🌈project": [ask("blocked", "b", 3 * 86400000)], approval: [ask("approval")], decision: [ask("decision")] }, now);
const plain = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const codes: Record<string, number> = { error: 31, warning: 33, text: 37, accent: 93, muted: 90, dim: 2 };
const ansi = { ...plain, fg: (c: string, s: string) => `\x1b[${codes[c] ?? 0}m${s}\x1b[0m` };
describe("flame renderer", () => {
  it("weights kind and logarithmic age", () => {
    for (const [kind, weight] of [["blocked", 3], ["approval", 2], ["decision", 1]] as const)
      expect(flameWeight(inbox({ p: [ask(kind)] }, now)[0]!)).toBe(weight);
    expect(ageHeat(0)).toBe(0);
    expect(ageHeat(3600000)).toBe(1);
    expect(flameWeight(groups[0]!)).toBeCloseTo(3 * (1 + Math.log2(73)));
    expect(PALETTE.blocked).toEqual(["error", "warning", "text"]);
    expect(PALETTE.approval).not.toEqual(PALETTE.decision);
  });
  it("pins both stripped and ANSI deterministic frames", () => {
    const flame = new FlameState(); flame.update(groups, now); flame.frame = 7;
    expect(renderFlame(groups, flame, 40, plain, now).join("\n")).toMatchSnapshot();
    expect(renderFlame(groups, flame, 40, ansi, now).join("\n")).toMatchSnapshot();
    const before = renderFlame(groups, flame, 80, ansi, now);
    expect(renderFlame(groups, flame, 80, ansi, now)).toEqual(before);
    flame.frame++; expect(renderFlame(groups, flame, 80, ansi, now)).not.toEqual(before);
  });
  it("flares arrivals, settles even the last resolved item, expires both without replay", () => {
    const flame = new FlameState(); flame.update([], now);
    flame.update(groups, now);
    expect(flame.pulse(groups[0]!.project, now).flare).toBe(1);
    expect(flame.pulse(groups[0]!.project, now + FLARE_MS / 2).flare).toBe(0.5);
    expect(flame.pulse(groups[0]!.project, now + FLARE_MS).flare).toBe(0);
    flame.update([], now + FLARE_MS);
    expect(flame.columns(now + FLARE_MS)).toHaveLength(3);
    expect(flame.pulse(groups[0]!.project, now + FLARE_MS + SETTLE_MS / 2).settle).toBe(0.5);
    expect(flame.columns(now + FLARE_MS + SETTLE_MS)).toEqual([]);
    flame.update([], now + FLARE_MS + SETTLE_MS);
    expect(flame.columns(now + FLARE_MS + SETTLE_MS)).toEqual([]);
  });
  it("keeps cold embers only while there is room", () => {
    const flame = new FlameState();
    const all = fleetGroups(groups, ["quiet", ...Array.from({ length: 25 }, (_, n) => `cold${n}`)]);
    flame.update(all, now);
    const small = renderFlame(all, flame, 40, plain, now).join("\n");
    expect(renderFlame(all, flame, 40, plain, now).slice(0, 4).join("\n")).toContain("·"); expect(small).not.toContain("quiet");
    expect(renderFlame(all, flame, 160, plain, now).join("\n")).toContain("cold");
    expect(renderFlame(all, flame, 160, plain, now)).toHaveLength(8);
  });
  it("fits wide glyphs, labels dead desks, and falls back without color", () => {
    const state = new SwitchboardState(); state.now = now;
    state.setGroups(groups.map((g) => ({ ...g, deadDesk: true })));
    for (const width of [0, 20, 39, 40, 80, 160]) {
      const lines = renderWidget(state, width, ansi, {}, now);
      expect(lines.length).toBeLessThanOrEqual(8);
      lines.forEach((line) => expect(visibleWidth(line)).toBeLessThanOrEqual(width));
      renderOverlay(state, width, 28, ansi).forEach((line) => expect(visibleWidth(line)).toBeLessThanOrEqual(width));
    }
    expect(renderWidget(state, 80, ansi, {}, now).join("\n")).toContain("☠");
    for (const env of [{ NO_COLOR: "" }, { TERM: "dumb" }]) expect(renderWidget(state, 80, ansi, env, now)).toHaveLength(1);
    expect(renderWidget(state, 80, plain, {}, now)).toHaveLength(1);
    expect(renderWidget(state, 39, ansi, {}, now)).toHaveLength(1);
    expect(renderWidget(new SwitchboardState(), 80, ansi, {}, now)).toHaveLength(1);
    expect(renderOverlay(state, 120, 30, plain).join("\n")).toContain("界🌈project#b");
  });
});
describe("queue arrival observations", () => {
  it("observes FYIs and new files, without replaying cached or replaced ids", () => {
    const h = harness(); const path = queuePath("p", h.home);
    mkdirSync(dirname(path), { recursive: true });
    const reader = new QueueReader();
    const initial = JSON.stringify(ask("blocked")) + "\n";
    writeFileSync(path, initial); reader.read(queueDir(h.home)); expect(reader.arrivals).toEqual([]);
    const fyi = ask("fyi"); const appended = JSON.stringify(fyi) + "\n";
    appendFileSync(path, appended); reader.read(queueDir(h.home));
    expect(reader.arrivals).toMatchObject([{ project: "p", item: { kind: "fyi" } }]);
    reader.read(queueDir(h.home)); expect(reader.arrivals).toEqual([]);
    writeFileSync(path, initial + appended); reader.read(queueDir(h.home)); expect(reader.arrivals).toEqual([]);
    writeFileSync(queuePath("new", h.home), appended); reader.read(queueDir(h.home));
    expect(reader.arrivals).toMatchObject([{ project: "new" }]);
    const flame = new FlameState(); const cold = fleetGroups([], ["p"]);
    flame.update(cold, now); flame.land("p", now);
    expect(renderFlame(cold, flame, 40, plain, now).join("\n")).toMatch(/[█▓▒░▁▂▃▄▅▆▇]/);
  });
});
describe("animation lifecycle", () => {
  it("cleans the widget animation, input listener, and polling timer on deactivate", async () => {
    const h = harness(); const path = queuePath("p", h.home);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(ask("blocked")) + "\n");
    vi.useFakeTimers();
    const handlers = new Map<string, Function>(); const commands = new Map<string, Function>();
    const render = vi.fn(); const removeInput = vi.fn();
    let widget: { render(width: number): string[] } | undefined;
    const ctx = { sessionManager: { getSessionId: () => "flame-test" }, ui: { setWidget: (_: string, factory?: Function) => { widget = factory?.({ requestRender: render, addInputListener: () => removeInput }, ansi); }, notify() {} } };
    registerSwitchboard({ registerFlag() {}, registerShortcut() {}, registerCommand: (name: string, opts: { handler: Function }) => commands.set(name, opts.handler), registerTool() {}, getFlag: () => true, on: (name: string, fn: Function) => handlers.set(name, fn) } as never, { env: { HOME: h.home }, layer: () => h.layer, run: async () => { throw new Error("no model turn"); } });
    try {
      await handlers.get("session_start")!(null, ctx);
      widget?.render(80);
      expect(vi.getTimerCount()).toBe(2);
      vi.advanceTimersByTime(420); expect(render.mock.calls.length).toBeGreaterThanOrEqual(3);
      await commands.get("switchboard")!("off", ctx);
      expect(removeInput).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
      const before = render.mock.calls.length; vi.advanceTimersByTime(1000); expect(render).toHaveBeenCalledTimes(before);
    } finally { handlers.get("session_shutdown")!(); vi.useRealTimers(); }
  });
  it("owns no timer until visible; freezes on idle or focus loss, resumes on input/change; disposes", () => {
    vi.useFakeTimers();
    try {
      const repaint = vi.fn(); const animation = new FlameAnimation(repaint);
      expect(vi.getTimerCount()).toBe(0);
      animation.show(true); vi.advanceTimersByTime(1000);
      expect(repaint.mock.calls.length).toBe(7);
      animation.input("\x1b[O"); const count = repaint.mock.calls.length;
      vi.advanceTimersByTime(1000); expect(repaint).toHaveBeenCalledTimes(count);
      animation.wake(); expect(animation.mode).toBe("frozen");
      animation.input("\x1b[I"); expect(animation.mode).toBe("animated");
      vi.advanceTimersByTime(IDLE_MS + 200); expect(animation.mode).toBe("frozen");
      expect(vi.getTimerCount()).toBe(0);
      animation.wake(); expect(animation.mode).toBe("animated");
      animation.show(false); expect(vi.getTimerCount()).toBe(0);
      animation.show(true); animation.dispose(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
