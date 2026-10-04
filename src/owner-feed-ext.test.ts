import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { appendOwnerItem, readerFresh } from "./owner-queue.ts";

describe("owner feed lifecycle", () => {
  it("registration is inert; idle mentions wake, busy mentions ride, shutdown retires presence", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-ext-"));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const sent: unknown[] = [];
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    const idle = vi.fn(() => true);
    const ctx = { isIdle: idle, sessionManager: { getSessionId: () => "reader", getBranch: () => entries } };
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool: () => {}, appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }), sendMessage: (m: unknown, options: unknown) => sent.push({ m, options }) };
    registerOwnerFeed(pi as never, { HOME: home, MUSTER_ROLE: "worker" });
    expect(readerFresh("reader", home)).toBe(false);
    vi.useFakeTimers();
    try {
      handlers.get("session_start")!({}, ctx);
      expect(readerFresh("reader", home)).toBe(true);
      appendOwnerItem("reader", { author: "sender", kind: "progress", title: "silent" }, home);
      await vi.advanceTimersByTimeAsync(30000); expect(sent).toEqual([]);
      appendOwnerItem("reader", { author: "sender", kind: "question", title: "wake" }, home);
      await vi.advanceTimersByTimeAsync(30000); expect(sent).toMatchObject([{ options: { triggerTurn: true } }]);
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
  });
});
