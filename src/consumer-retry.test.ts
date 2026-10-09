import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { registerOwnerFeed, RETRY_FAILED_MS } from "./owner-feed-ext.ts";

// A consumer that dies (a predecessor still holding the lease, a transport error) must not stay dead for the session.
it("retries a failed network consumer on a later refresh and names the failure's type", async () => {
  const home = mkdtempSync(join(tmpdir(), "consumer-retry-"));
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage: vi.fn(), sendUserMessage() {} };
  const ctx = { isIdle: () => false, sessionManager: { getSessionId: () => "desk-session", getBranch: () => [] } };
  let calls = 0;
  const consume = vi.fn((_ctx: unknown, signal: AbortSignal) => {
    calls += 1;
    if (calls === 1) return Promise.reject(Object.assign(new Error("lease held by another session"), { error: "LeaseHeld" }));
    return new Promise<void>(resolve => signal.addEventListener("abort", () => resolve()));
  });
  registerOwnerFeed(pi as never, { HOME: home }, { mode: async () => "network", consume }, async () => false);
  vi.useFakeTimers();
  try {
    handlers.get("session_start")!({}, ctx);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledOnce());
    expect(JSON.stringify(pi.sendMessage.mock.calls[0])).toContain("consumer stopped (LeaseHeld)");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(consume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_FAILED_MS);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(2));
  } finally { await handlers.get("session_shutdown")!(); vi.useRealTimers(); }
});
