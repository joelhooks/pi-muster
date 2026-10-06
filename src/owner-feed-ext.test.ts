import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { appendOwnerItem, readerFresh, readOwnerQueue } from "./owner-queue.ts";

import { Effect } from "effect";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NetworkPayload } from "./domain.ts";
import type { CommsError } from "./runtime.ts";

describe("owner feed lifecycle", () => {
  it("starts a mailbox consumer only on session_start, ingests owner records, delivers attributed briefs and aborts on shutdown", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-network-ext-"));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const sentUser = vi.fn(); const sent = vi.fn();
    let receive: ((payload: NetworkPayload) => Effect.Effect<void, CommsError>) | undefined;
    let signal: AbortSignal | undefined;
    const consume = vi.fn((_ctx: ExtensionContext, current: AbortSignal, callback: NonNullable<typeof receive>) => {
      receive = callback; signal = current;
      return new Promise<void>(resolve => current.addEventListener("abort", () => resolve(), { once: true }));
    });
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage: sent, sendUserMessage: sentUser };
    const ctx = { isIdle: () => false, sessionManager: { getSessionId: () => "desk-session", getBranch: () => [] } };
    registerOwnerFeed(pi as never, { HOME: home, MUSTER_ROLE: "desk" }, { consume });
    expect(consume).not.toHaveBeenCalled();
    handlers.get("session_start")!({}, ctx);
    await Promise.resolve();
    const item = appendOwnerItem("desk-session", { author: "worker-session", kind: "question", title: "question" }, home, false);
    await Effect.runPromise(receive!({ type: "owner", recipient: "desk-session", item }));
    expect(readOwnerQueue("desk-session", home).items).toHaveLength(1);
    await Effect.runPromise(receive!({ type: "message", recipient: "desk-session", author: "worker-session", body: "The full brief" }));
    expect(sentUser).toHaveBeenCalledWith("The full brief\n\n[Authenticated agent message from worker-session, not Joel.]", { deliverAs: "followUp" });
    handlers.get("session_shutdown")!();
    expect(signal?.aborted).toBe(true); expect(readerFresh("desk-session", home)).toBe(false); expect(sent).not.toHaveBeenCalled();
  });
  it("uses the existing poll to turn network consumption on and off, and never retries an auth failure until toggled", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-network-policy-"));
    const handlers = new Map<string, (...args: unknown[]) => unknown>(); const sent = vi.fn();
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage: sent, sendUserMessage() {} };
    const ctx = { isIdle: () => false, sessionManager: { getSessionId: () => "reader", getBranch: () => [] } };
    let mode: "intercom" | "network" = "intercom";
    const consume = vi.fn(async () => { throw new Error("AuthRequired"); });
    registerOwnerFeed(pi as never, { HOME: home }, { mode: async () => mode, consume });
    vi.useFakeTimers();
    try {
      handlers.get("session_start")!({}, ctx); await vi.advanceTimersByTimeAsync(0); expect(consume).not.toHaveBeenCalled();
      mode = "network"; await vi.advanceTimersByTimeAsync(30000); expect(consume).toHaveBeenCalledOnce(); expect(sent).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60000); expect(consume).toHaveBeenCalledOnce(); expect(sent).toHaveBeenCalledOnce();
      mode = "intercom"; await vi.advanceTimersByTimeAsync(30000);
      mode = "network"; await vi.advanceTimersByTimeAsync(30000); expect(consume).toHaveBeenCalledTimes(2); expect(sent).toHaveBeenCalledTimes(2);
    } finally { handlers.get("session_shutdown")!(); vi.useRealTimers(); }
  });
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
      await vi.waitFor(() => expect(readerFresh("reader", home)).toBe(true));
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
    // A heartbeat still in flight at shutdown must not bring presence back.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readerFresh("reader", home)).toBe(false);
  });
});
