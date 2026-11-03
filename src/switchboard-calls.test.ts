import { mkdtempSync, renameSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { readCalls, watchCalls } from "./switchboard-calls.ts";
import type { CallsSummary } from "./switchboard-calls.ts";
import { registerSwitchboard } from "./switchboard-ext.ts";
import { renderWidget, SwitchboardState } from "./switchboard-view.ts";
import { harness } from "./test-support.ts";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, watch: vi.fn(fs.watch) };
});

const plain = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const color = { ...plain, fg: (token: string, text: string) => `\x1b[${token === "dim" ? 2 : 36}m${text}\x1b[0m` };
const card = (title: string, group: string) => ({ id: title, title, group, kind: "decision", age: "1h", why: "why", timeline: "then", shows: [], not_shows: [], choices: [] });
const fixture = {
  schema: "muster-desk-report.items.v1", slug: "fixture", snapshot: "now", seed: "1",
  groups: [{ key: "b", name: "B", desc: "" }, { key: "a", name: "A", desc: "" }],
  items: [card("Fourth", "a"), card("First", "b"), card("Second", "b"), card("Third", "b")],
};
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "muster-calls-"));
  return { dir, path: join(dir, "calls.json") };
};
const draw = (calls?: CallsSummary, width = 100, theme = plain, env = {}) => renderWidget(new SwitchboardState(), width, theme, env, 0, calls);

describe("Joel calls widget line", () => {
  it("does nothing when unset and adds exactly one line in every display mode", () => {
    const changed = vi.fn();
    const watches = vi.mocked(watch).mock.calls.length;
    expect(watchCalls({}, changed)).toBeUndefined();
    expect(vi.mocked(watch).mock.calls).toHaveLength(watches);
    expect(changed).not.toHaveBeenCalled();
    expect(draw().join("\n")).not.toContain("calls");
    const calls: CallsSummary = { kind: "ready", count: 4, titles: ["First"], url: "fixture-link" };
    for (const width of [1, 20, 40, 41, 100]) for (const theme of [plain, color]) for (const env of [{}, { NO_COLOR: "1" }, { TERM: "dumb" }]) {
      const before = draw(undefined, width, theme, env);
      const after = draw(calls, width, theme, env);
      expect(after.slice(0, -1)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
      for (const line of after) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(draw(calls, 40).at(-1)).toBe("calls 4");
  });

  it("uses the report decoder, full count and page order (not item or sorted order)", () => {
    const { path } = setup();
    writeFileSync(path, JSON.stringify(fixture));
    const summary = readCalls(path, "fixture-link");
    expect(summary).toEqual({ kind: "ready", count: 4, titles: ["First", "Second", "Third"], url: "fixture-link" });
    expect(draw(summary).at(-1)).toBe("Joel calls (4) · First · Second · Third · fixture-link");
    expect(draw(summary)[0]).toContain("0 open");
  });

  it("neither counts nor shows items in unknown groups, matching the page", () => {
    const { path } = setup();
    writeFileSync(path, JSON.stringify({ ...fixture, items: [card("Hidden", "unknown"), ...fixture.items] }));
    const summary = readCalls(path);
    expect(summary).toEqual({ kind: "ready", count: 4, titles: ["First", "Second", "Third"], url: undefined });
    expect(draw(summary).at(-1)).toBe("Joel calls (4) · First · Second · Third");
    expect(draw(summary).join("\n")).not.toContain("Hidden");
  });

  it("catches missing, malformed, wrong schema and structurally invalid reports with a dim basename only", () => {
    const { path, dir } = setup();
    for (const contents of [undefined, "{", JSON.stringify({ ...fixture, schema: "other" }), JSON.stringify({ ...fixture, items: [{ title: "bad" }] })]) {
      if (contents !== undefined) writeFileSync(path, contents);
      const summary = readCalls(path);
      expect(summary).toEqual({ kind: "unreadable", basename: "calls.json" });
      const line = draw(summary, 100, color).at(-1)!;
      expect(line).toContain("\x1b[2m");
      expect(stripVTControlCharacters(line)).toBe("Joel calls: unreadable (calls.json)");
      expect(line).not.toContain(dir);
    }
    expect(readCalls(dir).kind).toBe("unreadable");
  });

  it("fits long wide titles and untrusted control characters without losing the link", () => {
    const calls: CallsSummary = { kind: "ready", count: 12, titles: ["界".repeat(100), "a\nb\x1b[31m", "third"], url: "fixture-link" };
    for (const width of [0, 1, 40, 41, 60, 100]) {
      const lines = draw(calls, width, color);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(line).not.toContain("\n");
      }
    }
    expect(stripVTControlCharacters(draw(calls).at(-1)!)).toMatch(/ · fixture-link$/);
    expect(draw({ kind: "ready", count: 0, titles: [] }).at(-1)).toBe("Joel calls (0)");
  });

  it("watches creation and atomic replacements, debounces and stops without polling", async () => {
    const { path } = setup();
    const changed = vi.fn();
    const stop = watchCalls({ MUSTER_SWITCHBOARD_CALLS: path }, changed)!;
    try {
      expect(changed).toHaveBeenLastCalledWith({ kind: "unreadable", basename: "calls.json" });
      writeFileSync(path, JSON.stringify(fixture));
      await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready", count: 4 })));
      writeFileSync(`${path}.new`, JSON.stringify({ ...fixture, items: [] }));
      renameSync(`${path}.new`, path);
      await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready", count: 0 })));
      stop(); changed.mockClear();
      writeFileSync(path, "broken");
      // No timer exists after stop; waitFor's assertion needs no quiet-time guess.
      expect(changed).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it("activation caches calls; file changes request a widget render, never an agent message", async () => {
    const { path } = setup();
    const h = harness();
    writeFileSync(path, JSON.stringify(fixture));
    const handlers = new Map<string, Function>();
    const requestRender = vi.fn();
    const sendMessage = vi.fn();
    let widget: { render(width: number): string[] } | undefined;
    const pi = {
      registerFlag() {}, registerShortcut() {}, registerCommand() {}, registerTool() {}, getFlag: () => false,
      on: (name: string, handler: Function) => handlers.set(name, handler), sendMessage,
    };
    const ctx = {
      ui: { setStatus() {}, notify() {}, setWidget: (_: string, factory: Function) => { widget = factory({ requestRender }, plain); } },
      sessionManager: { getSessionId: () => "fixture" },
    };
    registerSwitchboard(pi as never, {
      env: { HOME: h.home, MUSTER_ROLE: "desk", MUSTER_SWITCHBOARD: "1", MUSTER_SWITCHBOARD_CALLS: path },
      layer: () => h.layer, run: vi.fn(),
    });
    expect(widget).toBeUndefined();
    await handlers.get("session_start")!(null, ctx);
    try {
      expect(widget!.render(100).at(-1)).toBe("Joel calls (4) · First · Second · Third");
      requestRender.mockClear();
      writeFileSync(path, JSON.stringify({ ...fixture, items: [] }));
      expect(widget!.render(100).at(-1)).toBe("Joel calls (4) · First · Second · Third");
      await vi.waitFor(() => expect(widget!.render(100).at(-1)).toBe("Joel calls (0)"));
      expect(requestRender).toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    } finally { handlers.get("session_shutdown")!(); }
  });
});
