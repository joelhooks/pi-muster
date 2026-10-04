import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { queuePath } from "./desk.ts";
import type { DeskItem } from "./domain.ts";
import { registerSwitchboard } from "./switchboard-ext.ts";
import { SwitchboardState, renderRankedSummary as renderWidget } from "./switchboard-view.ts";
import { QueueReader, deadDesk, eventText, fleetGroups, inbox, queueDir, queueEvents } from "./switchboard.ts";
import { harness } from "./test-support.ts";

const plain = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const now = Date.parse("2026-10-04T00:00:00Z");
const item = (id: string, kind: DeskItem["kind"], minutes: number): DeskItem => ({ id, kind, from: "desk", title: `title ${id}`, ts: new Date(now - minutes * 60_000).toISOString() });
const line = (record: DeskItem) => `${JSON.stringify(record)}\n`;

describe("Switchboard ticker", () => {
  it("keeps the newest five across projects, excludes old/future lines, formats resolutions", () => {
    const events = queueEvents({ drovr: [item("old", "done", 60), item("recorded", "approval", 3)], clickhouse: [item("logs", "decision", 12)], cliproxy: [{ ...item("answer", "done", 1), resolves: "ask" }] }, now);
    expect(events.map((event) => event.project)).toEqual(["cliproxy", "drovr", "clickhouse"]);
    expect(events.map((event) => eventText(event, now))).toEqual(["cliproxy ✓ resolved 1m", "drovr ✅ title recorded 3m", "clickhouse ❓ title logs 12m"]);
    expect(queueEvents({ p: Array.from({ length: 8 }, (_, n) => item(String(n), "fyi", n)) }, now)).toHaveLength(5);
    expect(queueEvents({ p: [item("future", "done", -1)] }, now)).toEqual([]);
  });

  it("globally ranks kind then oldest, collapses quiet desks, caps at ten rows at 60 and 120 columns", () => {
    const queues = { a: [item("decision", "decision", 40), item("blocked-new", "blocked", 2)], b: [item("blocked-old", "blocked", 10), item("approval", "approval", 1), item("other", "decision", 1)] };
    const s = new SwitchboardState();
    s.setSystem({ groups: fleetGroups(inbox(queues, now), [...Object.keys(queues), ...Array.from({ length: 16 }, (_, n) => `quiet${n}`)]).map((group) => ({ ...group, deadDesk: group.project === "b" })), posts: {}, latest: null, fleet: null, events: queueEvents(queues, now), now });
    for (const width of [60, 120]) {
      const rows = renderWidget(s, width, plain);
      expect(rows).toHaveLength(10);
      expect(rows[1]).toContain("b#blocked-old");
      expect(rows[1]).toContain("☠ no live desk");
      expect(rows[2]).toContain("a#blocked-new");
      expect(rows[3]).toContain("b#approval");
      expect(rows[4]).toContain("a#decision");
      expect(rows[5]).toBe("+1 more");
      expect(rows.at(-1)).toBe("+16 quiet");
      rows.forEach((row) => expect(visibleWidth(row)).toBeLessThanOrEqual(width));
    }
    s.now += 60 * 60_000;
    expect(renderWidget(s, 120, plain)).toHaveLength(7);
  });

  it("uses catalog session ids for desk/owner liveness, and never guesses when sessions are unknown", () => {
    const project = { agents: [{ role: "desk" as const, state: "running" as const, sessionId: "desk-id", owner: "owner-id" }] };
    expect(deadDesk(project, ["desk-id"])).toBe(false);
    expect(deadDesk(project, ["owner-id"])).toBe(false);
    expect(deadDesk(project, [])).toBe(true);
    expect(deadDesk({ agents: [{ ...project.agents[0]!, state: "closed" }] }, ["desk-id"])).toBe(true);
    expect(deadDesk(project, undefined)).toBeUndefined();
    expect(deadDesk(undefined, [])).toBe(true);
    const s = new SwitchboardState();
    s.setGroups(inbox({ p: [item("ask", "blocked", 1)] }, now));
    expect(renderWidget(s, 60, plain).join("\n")).not.toContain("☠");
  });
});

describe("incremental queue reader", () => {
  it("reads only appended bytes; resets on truncation and atomic replacement, drops deleted files", () => {
    const h = harness(); const path = queuePath("p", h.home);
    mkdirSync(dirname(path), { recursive: true });
    const reader = new QueueReader();
    const first = line(item("one", "decision", 1)); writeFileSync(path, first);
    expect(reader.read(queueDir(h.home)).p?.map((item) => item.id)).toEqual(["one"]);
    const bytes = reader.bytesRead;
    reader.read(queueDir(h.home)); expect(reader.bytesRead).toBe(bytes);
    const second = line(item("two", "done", 0)); appendFileSync(path, second);
    expect(reader.read(queueDir(h.home)).p?.map((item) => item.id)).toEqual(["one", "two"]);
    expect(reader.bytesRead - bytes).toBe(Buffer.byteLength(second));
    writeFileSync(path, first);
    expect(reader.read(queueDir(h.home)).p?.map((item) => item.id)).toEqual(["one"]);
    writeFileSync(`${path}.new`, second); renameSync(`${path}.new`, path);
    expect(reader.read(queueDir(h.home)).p?.map((item) => item.id)).toEqual(["two"]);
    unlinkSync(path); expect(reader.read(queueDir(h.home))).toEqual({});
  });

  it("retains split JSON and UTF-8 bytes, skips malformed complete lines", () => {
    const h = harness(); const path = queuePath("p", h.home);
    mkdirSync(dirname(path), { recursive: true });
    const reader = new QueueReader();
    const bytes = Buffer.from(line({ ...item("unicode", "decision", 1), title: "✅" }));
    const cut = bytes.indexOf(Buffer.from("✅")) + 1;
    writeFileSync(path, bytes.subarray(0, cut));
    expect(reader.read(queueDir(h.home)).p).toEqual([]);
    appendFileSync(path, bytes.subarray(cut)); appendFileSync(path, "bad json\n{}\n");
    expect(reader.read(queueDir(h.home)).p).toMatchObject([{ title: "✅" }]);
  });
});

describe("idle refresh regression", () => {
  it("repaints after the captured context becomes stale, with no model turn or new context", async () => {
    const h = harness(); const path = queuePath("p", h.home);
    const handlers = new Map<string, Function>();
    let widget: { render(width: number): string[] } | undefined;
    const render = vi.fn();
    let stale = false;
    const ctx = { get sessionManager() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return { getSessionId: () => "probe" }; }, ui: { setWidget: (_key: string, factory: Function) => { widget = factory?.({ requestRender: render }, plain); } } };
    const layer = vi.fn((context: typeof ctx) => { context.sessionManager.getSessionId(); return h.layer; });
    registerSwitchboard({ registerFlag() {}, registerShortcut() {}, registerCommand() {}, registerTool() {}, getFlag: () => true, on: (name: string, fn: Function) => handlers.set(name, fn) } as never, { env: { HOME: h.home }, layer: layer as never, run: async () => { throw new Error("model/tool runner must not run"); } });
    try {
      await handlers.get("session_start")!(null, ctx);
      expect(widget?.render(120).join("\n")).toContain("inbox clear");
      stale = true;
      appendFileSync(path, line({ ...item("idle", "decision", 0), ts: new Date().toISOString(), title: "No prompt sent" }));
      await vi.waitFor(() => expect(widget?.render(120).join("\n")).toContain("1 open"), { timeout: 1800 });
      expect(layer).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalled();
      const clock = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(clock + 120_000);
      await handlers.get("before_agent_start")!(null, ctx);
      expect(widget?.render(120).join("\n")).toContain("oldest 2m");
      // Even broken metadata must not prevent local queue rendering, or flood logs.
      vi.spyOn(h.now, "getTime").mockImplementation(() => { throw new Error("metadata clock unavailable"); });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(Date.now).mockReturnValue(clock + 151_000);
      await handlers.get("before_agent_start")!(null, ctx);
      await handlers.get("before_agent_start")!(null, ctx);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toContain("metadata clock unavailable");
      expect(widget?.render(120).join("\n")).toContain("1 open");
    } finally { handlers.get("session_shutdown")!(); vi.restoreAllMocks(); }
  });
});
