import { writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { describe, expect, it, vi } from "vitest";
// Dev Pi predates Theme.colors; this public theme loader resolves the same built-in palettes.
import { getThemeByName, getResolvedThemeColors } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { checkTui } from "./tui-check.ts";
import { OwnerTimelineView, ownerLine, ownerToolResult } from "./owner-view.ts";
import type { OwnerTimelineData } from "./owner-view.ts";
import { SwitchboardOverlay, SwitchboardState, renderOverlay, renderRankedSummary, renderWidget } from "./switchboard-view.ts";
import { inbox } from "./switchboard.ts";
import { registerDeskFeed } from "./desk-feed-ext.ts";
import { digestLine } from "./digest.ts";

const now = Date.parse("2026-01-01T12:00:00Z");
const title = "Review the 中文 preview 🐑 combining e\u0301 and a long synthetic explanation ".repeat(3);
const question: OwnerTimelineData["items"][number] = {
  $type: "dev.muster.note.post", uri: "fixture:post-one", cid: "fixture-cid", author: "fixture-writer",
  createdAt: "2026-01-01T11:58:00Z", kind: "question", text: title + "\nSecond line checks wrapping.",
  refs: ["synthetic-reference-".repeat(8)],
  facets: [{ index: { byteStart: 0, byteEnd: 6 }, features: [{ $type: "dev.muster.note.facet#mention", did: "fixture-reader" }] }],
};
const data: OwnerTimelineData = {
  reader: "fixture-reader", authors: { "fixture-writer": "Example Writer 中文 🐑" }, parents: [question],
  flow: "WIP 1/3 · synthetic preview ".repeat(5),
  items: [question, { ...question, uri: "fixture:quiet", kind: "fyi", facets: [], reply: { root: { uri: question.uri, cid: question.cid }, parent: { uri: question.uri, cid: question.cid } } }],
};
function board() {
  const state = new SwitchboardState();
  state.now = now;
  state.setGroups(inbox({ "demo-project": Array.from({ length: 12 }, (_, i) => ({
    id: `ask-${i}`, kind: "decision", title, body: title.repeat(4), refs: [title], from: "fixture-writer", ts: question.createdAt,
  })) }, now));
  state.move(7);
  state.activity.update({ "demo-project": [{ id: "event", kind: "decision", title: "Synthetic event", from: "fixture", ts: question.createdAt }] });
  return state;
}

// Registration harness: invokes the actual desk renderer without starting delivery/watchers.
function deskRenderer() {
  let renderer: Parameters<ExtensionAPI["registerMessageRenderer"]>[1] | undefined;
  const pi = { on() {}, registerMessageRenderer(_name: string, render: typeof renderer) { renderer = render; } };
  // SAFETY: registration uses only the two methods above; no lifecycle handler is invoked.
  registerDeskFeed(pi as unknown as ExtensionAPI, {});
  if (!renderer) throw new Error("Desk renderer was not registered");
  return renderer;
}
const renderDesk = deskRenderer();

describe("text-only TUI checker", () => {
  it("rejects overflow, open styles and foreign truecolors independently", () => {
    expect(checkTui(["中文🐑"], 4, [])).toEqual(["line 1: width 6 > 4"]);
    for (const style of ["1", "2", "3", "4", "5", "7", "8", "9", "21", "31", "48;5;123", "53"]) {
      expect(checkTui([`\x1b[${style}mtext`], 40, [])).toContainEqual(expect.stringContaining("open style"));
    }
    expect(checkTui(["\x1b[38;2;1;2;3mx\x1b[39m"], 40, ["#010203"])).toEqual([]);
    expect(checkTui(["\x1b[48;2;1;2;3mx\x1b[0m"], 40, [])).toContainEqual(expect.stringContaining("colour #010203"));
    expect(checkTui(["\x1b[1;2mtext\x1b[22m", "\x1b[31;44mx\x1b[39;49m", "\x1b[21;53mx\x1b[24;54m"], 40, [])).toEqual([]);
    expect(checkTui(["\x1b[38:2::1:2:3mx\x1b[0m"], 40, ["#010203"])).toEqual([]);
    expect(checkTui(["\x1b]8;;https://example.com\x07text"], 40, [])).toContainEqual(expect.stringContaining("link"));
    expect(checkTui(["\x1b]8;;https://example.com\x1b\\text\x1b]8;;\x1b\\"], 40, [])).toEqual([]);
  });
});

describe.each(["dark", "light"])("Muster TUI %s theme", themeName => {
  const theme = getThemeByName(themeName)!;
  const palette = Object.values(getResolvedThemeColors(themeName));
  it.each([32, 36, 40, 60, 80, 120])("all surfaces fit and close their styles at %i columns", width => {
    vi.stubEnv("NO_COLOR", undefined);
    try {
      const state = board();
      const desk = renderDesk({ role: "custom", timestamp: now, customType: "fixture", content: "synthetic", display: true, details: {
        project: "demo", flow: data.flow, pull: title,
        items: [{ id: "ask", kind: "decision", title, body: title, refs: [title], from: "fixture", ts: question.createdAt }],
        inbox: { open: 1, blocked: 0, approval: 0, decision: 1, oldestMs: 900000 },
      } }, { expanded: true }, theme);
      if (!desk) throw new Error("Desk component missing");
      const part = { state: "ok", text: title, compact: "synthetic" } as const;
      const parts = { prs: part, kodiak: part, main: part, gates: part, agents: part, packets: part };
      // Digest is plain text; its extension has no custom terminal renderer. Desk report builds HTML, not TUI.
      const surfaces = {
        // Exact synthetic owner story from pi-tui-verify/stories/owned.ts:56-67.
        ownerOriginal: new OwnerTimelineView({ reader: "fixture-reader", authors: { "fixture-writer": "Example Writer" }, parents: [], flow: "WIP 1/3 · synthetic preview", items: [{ ...question, text: "Review the 中文 preview 🐑", refs: undefined }] }, { expanded: true, now, noColor: false }, theme).render(width),
        ownerExpanded: new OwnerTimelineView(data, { expanded: true, now, noColor: false }, theme).render(width),
        ownerCollapsed: new OwnerTimelineView(data, { expanded: false, now, noColor: false }, theme).render(width),
        ownerLine: ownerLine(title, theme).render(width),
        ownerToolExpanded: ownerToolResult(title, true, theme).render(width),
        ownerToolCollapsed: ownerToolResult(title, false, theme).render(width),
        switchboardWidget: renderWidget(state, width, theme, { TERM: "xterm-256color" }),
        switchboardPlain: renderWidget(state, width, theme, { TERM: "dumb" }),
        switchboardSummary: renderRankedSummary(state, width, theme),
        switchboardOverlay: renderOverlay(state, width, 20, theme),
        desk: desk.render(width),
        digest: [digestLine("demo 12:00", parts, width)],
      };
      for (const [name, lines] of Object.entries(surfaces)) expect(checkTui(lines, width, palette), name).toEqual([]);
      if (width === 36 && themeName === "dark" && process.env.MUSTER_TUI_PROOF) writeFileSync(process.env.MUSTER_TUI_PROOF, Object.entries(surfaces).map(([name, lines]) => `### ${name}\n\n\`\`\`text\n${lines.map(stripVTControlCharacters).join("\n")}\n\`\`\``).join("\n\n"));
    } finally { vi.unstubAllEnvs(); }
  });
  it.each([32, 36, 40])("mobile rows retain facts, selection and letter hints at %i columns", width => {
    const state = board();
    const group = state.groups[0]!;
    state.setGroups([{ ...group, counts: { blocked: 0, approval: 0, decision: 40 }, items: Array.from({ length: 40 }, (_, i) => ({ ...group.items[0]!, id: `ask-${i}` })) }]);
    state.move(40);
    const lines = renderOverlay(state, width, 20, theme);
    const plain = lines.map(stripVTControlCharacters).join("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(checkTui(lines, width, palette)).toEqual([]);
    expect(plain).toContain("▶ decision ask-39");
    expect(plain).not.toMatch(/[╭╮╰╯│]/);
    for (const hint of ["j/k move", "f fold", "c all", "o desk", "e discuss", "a answer", "d done", "q quit"]) expect(plain).toContain(hint);
    expect(new OwnerTimelineView(data, { expanded: true, now, noColor: false }, theme).render(width).map(stripVTControlCharacters).join("\n")).toContain("2m ago");
  });
  it.each([6, 8, 12, 20])("selection and hints remain visible in %i rows", height => {
    const lines = renderOverlay(board(), 60, height, theme);
    const plain = lines.map(stripVTControlCharacters).join("\n");
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(plain).toContain("▶");
    expect(plain).toContain("fold");
  });
});

it("overlay honours remapped selection keys and keeps explicit letter controls", () => {
  const state = board();
  const theme = getThemeByName("dark")!;
  const keys = new KeybindingsManager({ "tui.select.down": "ctrl+n", "tui.select.up": "ctrl+p", "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+x" });
  const done = vi.fn(), redraw = vi.fn();
  const view = new SwitchboardOverlay(state, theme, () => 12, done, redraw, keys);
  const before = state.cursor;
  view.handleInput("\x0e"); expect(state.cursor).toBe(before + 1);
  view.handleInput("\x10"); expect(state.cursor).toBe(before);
  view.handleInput("\x1b[B"); expect(state.cursor).toBe(before);
  view.handleInput("j"); expect(state.cursor).toBe(before + 1);
  view.handleInput("\x19"); expect(done).toHaveBeenLastCalledWith(expect.objectContaining({ type: "desk" }));
  view.handleInput("o"); expect(done).toHaveBeenLastCalledWith(expect.objectContaining({ type: "desk" }));
  for (const [key, type] of [["e", "discuss"], ["a", "answer"], ["d", "done"]]) {
    view.handleInput(key!); expect(done).toHaveBeenLastCalledWith(expect.objectContaining({ type }));
  }
  view.handleInput("f"); expect(state.current()?.type).toBe("group");
  view.handleInput("l"); expect(state.expanded.size).toBe(1);
  view.handleInput("h"); expect(state.expanded.size).toBe(0);
  view.handleInput("c"); expect(state.expanded.size).toBe(1);
  view.handleInput("q"); expect(done).toHaveBeenLastCalledWith({ type: "close" });
  view.handleInput("\x18"); expect(done).toHaveBeenLastCalledWith({ type: "close" });
  const rendered = new SwitchboardOverlay(state, theme, () => 6, done, redraw, keys).render(60);
  expect(rendered.length).toBeLessThanOrEqual(6);
  const shown = rendered.map(stripVTControlCharacters).join("\n");
  for (const hint of ["ctrl+p", "ctrl+n", "ctrl+y", "ctrl+x"]) expect(shown).toContain(hint);
});
