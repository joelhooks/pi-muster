import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { registerOwnerFeed, duplicateSessionPane } from "./owner-feed-ext.ts";
import type { AgentRow } from "./domain.ts";
import type { PaneInfo } from "./herdr.ts";
import { appendOwnerItem, readerFresh } from "./owner-queue.ts";


describe("owner feed lifecycle", () => {
  it("identifies only the unbound live session copy", () => {
    const row = { state: "running", sessionId: "same", sessionFile: "/sessions/date_same.jsonl", pane: { paneId: "bound", terminalId: "bound-terminal" } } as AgentRow;
    const panes = ["bound", "copy"].map(paneId => ({ pane_id: paneId, terminal_id: `${paneId}-terminal`, agent: "pi", agent_session: { kind: "path", value: row.sessionFile } })) as PaneInfo[];
    expect(duplicateSessionPane(row, "same", "bound", panes)).toBe(false);
    expect(duplicateSessionPane(row, "same", "copy", panes)).toBe(true);
    expect(duplicateSessionPane(row, "same", "copy", panes.slice(1))).toBe(false);
    expect(duplicateSessionPane(row, "different", "copy", panes)).toBe(false);
  });

  it("the duplicate sends one fork notice through its own feed and never starts a second reader", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-duplicate-"));
    const handlers = new Map<string, (...args: unknown[]) => unknown>(); const sent = vi.fn(); const consume = vi.fn(async () => {});
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage: sent };
    const ctx = { isIdle: () => false, sessionManager: { getSessionId: () => "same", getBranch: () => [] } };
    registerOwnerFeed(pi as never, { HOME: home }, undefined, async () => true);
    vi.useFakeTimers();
    try {
      handlers.get("session_start")!({}, ctx);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(consume).not.toHaveBeenCalled();
      expect(sent).toHaveBeenCalledOnce();
      expect(sent.mock.calls[0]![0]).toMatchObject({ customType: "muster-session-fork" });
      expect(sent.mock.calls[0]![0].content).toContain("Run /fork");
      expect(sent.mock.calls[0]![0].content).toContain("pi-ratking owns the name's single reader");
    } finally { await handlers.get("session_shutdown")!(); vi.useRealTimers(); }
  });
  it("holds a pending mention at a gated start, leaves the argv prompt first, and resumes after activation", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-gated-")); const gate = join(home, "restart.ready");
    const handlers = new Map<string, (...args: unknown[]) => unknown>(); const sent = vi.fn();
    const journal: string[] = [];
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {},
      sendMessage: (message: { content: string }, options: unknown) => { sent(message, options); journal.push(message.content); } };
    const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => "replacement", getBranch: () => [] } };
    appendOwnerItem("replacement", { author: "owner", kind: "question", title: "pending at startup" }, home);
    registerOwnerFeed(pi as never, { HOME: home, MUSTER_RESTART_GATE: gate });
    vi.useFakeTimers();
    try {
      handlers.get("session_start")!({}, ctx);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(handlers.get("before_agent_start")!({}, ctx)).toBeUndefined();
      handlers.get("agent_end")!({}, ctx);
      expect(sent).not.toHaveBeenCalled();
      writeFileSync(gate, JSON.stringify("another-session"), { mode: 0o600 });
      await vi.advanceTimersByTimeAsync(30_000); expect(sent).not.toHaveBeenCalled();
      journal.push("The argv continuation prompt");
      writeFileSync(gate, JSON.stringify("replacement"), { mode: 0o600 });
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
      expect(journal[0]).toBe("The argv continuation prompt"); expect(journal[1]).toContain("pending at startup");
    } finally { await handlers.get("session_shutdown")!(); vi.useRealTimers(); }
  });

  ;
  ;
  ;
  it("registration is inert; idle mentions wake, busy mentions ride, shutdown retires presence", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-ext-"));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const sent: unknown[] = [];
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    const idle = vi.fn(() => true);
    const ctx = { isIdle: idle, sessionManager: { getSessionId: () => "reader", getBranch: () => entries } };
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool: () => {}, registerMessageRenderer: () => {}, appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendMessage: (m: unknown, options: unknown) => sent.push({ m, options }) };
    registerOwnerFeed(pi as never, { HOME: home, MUSTER_ROLE: "worker" });
    expect(readerFresh("reader", home)).toBe(false);
    vi.useFakeTimers();
    try {
      handlers.get("session_start")!({}, ctx);
      // The heartbeat is async so a stalled rename never freezes the TUI.
      await vi.waitFor(() => expect(readerFresh("reader", home)).toBe(true), { timeout: 5000 });
      appendOwnerItem("reader", { author: "sender", kind: "progress", title: "silent" }, home);
      await vi.advanceTimersByTimeAsync(30000); expect(sent).toEqual([]);
      appendOwnerItem("reader", { author: "sender", kind: "question", title: "wake" }, home);
      await vi.advanceTimersByTimeAsync(30000);
      // Advancing fake time schedules a tick; real asynchronous file reads settle separately.
      await vi.waitFor(() => expect(sent).toMatchObject([{ options: { triggerTurn: true } }]), { timeout: 5000 });
      handlers.get("agent_start")!({}, ctx); idle.mockReturnValue(false);
      appendOwnerItem("reader", { author: "sender", kind: "blocked", title: "held" }, home);
      await vi.advanceTimersByTimeAsync(30000); expect(sent).toHaveLength(1);
      const next = handlers.get("before_agent_start")!({}, ctx);
      expect(next).toMatchObject({ message: { content: expect.stringContaining("held") } });
      expect(next).toMatchObject({ message: { content: expect.stringContaining("silent") } });
    } finally {
      handlers.get("session_shutdown")!(); vi.useRealTimers();
    }
    expect(readerFresh("reader", home)).toBe(false);
    // A heartbeat still in flight at shutdown must not bring presence back.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readerFresh("reader", home)).toBe(false);
  });
});
