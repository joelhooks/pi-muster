import { describe, expect, it } from "vitest";
import { piCompactsFirst, registerCompaction } from "./compact.ts";
import type { PiCompaction } from "./compact.ts";

// MacLeod, 2026-10-17: on drovr-desk-2 compact-at and Pi's own auto-compaction both fired at 400K. compact-at's
// ctx.compact() aborted the run and left the session idle, a wake started a turn, and Pi began a second compaction.
function harness(settings: PiCompaction | undefined, contextWindow = 1_000_000) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    registerFlag: () => {}, registerCommand: () => {}, appendEntry: () => {}, getFlag: () => undefined,
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
  };
  let tokens = 0;
  let failure: string | undefined;
  const compacted: number[] = [];
  const notes: string[] = [];
  const seen: unknown[] = [];
  const ctx = {
    cwd: "/repo", model: { provider: "claude-bridge", id: "claude-opus-5-5" }, hasUI: true,
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ tokens, contextWindow, percent: null }),
    compact: (options?: { onError?: (error: Error) => void }) => { compacted.push(tokens); if (failure) options?.onError?.(new Error(failure)); },
    ui: { notify: (text: string) => { notes.push(text); } },
  };
  registerCompaction(pi as never, { PI_COMPACT_AT: "400000" }, (_cwd, model) => { seen.push(model); return settings; });
  handlers.get("session_start")?.({}, ctx);
  const turn = (at: number) => { tokens = at; handlers.get("agent_end")?.({}, ctx); };
  return { turn, compacted, notes, seen, fail: (message: string) => { failure = message; } };
}

describe("compact-at and Pi's own auto-compaction", () => {
  it("knows when Pi compacts first, from the window and the reserve", () => {
    expect(piCompactsFirst(400_000, 1_000_000, { enabled: true, reserveTokens: 600_000 })).toBe(400_000);
    expect(piCompactsFirst(400_000, 1_000_000, { enabled: true, reserveTokens: 700_000 })).toBe(300_000);
    expect(piCompactsFirst(400_000, 1_000_000, { enabled: true, reserveTokens: 16_384 })).toBeNull();
    expect(piCompactsFirst(400_000, 1_000_000, { enabled: false, reserveTokens: 600_000 })).toBeNull();
    expect(piCompactsFirst(400_000, 1_000_000, undefined)).toBeNull();
    expect(piCompactsFirst(400_000, 0, { enabled: true, reserveTokens: 600_000 })).toBeNull();
  });
  it("stands down when Pi compacts at or below compactAt, once per crossing", () => {
    const h = harness({ enabled: true, reserveTokens: 600_000 });
    h.turn(450_000);
    h.turn(460_000);
    expect(h.compacted).toEqual([]);
    expect(h.notes).toEqual(["compact-at: Pi compacts this model at 400000 tokens, inside the run; standing down at 400000"]);
    expect(h.seen[0]).toEqual({ provider: "claude-bridge", id: "claude-opus-5-5" });
  });
  it("still compacts when Pi would wait longer, or its compaction is off or unreadable", () => {
    for (const settings of [{ enabled: true, reserveTokens: 16_384 }, { enabled: false, reserveTokens: 600_000 }, undefined]) {
      const h = harness(settings);
      h.turn(450_000);
      expect(h.compacted).toEqual([450_000]);
    }
  });
  // MacLeod, 2026-10-17: Pi 1.3.0-p4 refuses a manual compaction while its own is running.
  it("treats Pi's own compaction in progress as handled: no retry, no error; other failures retry", () => {
    const busy = harness({ enabled: true, reserveTokens: 16_384 });
    busy.fail("Compaction already in progress");
    busy.turn(450_000);
    busy.turn(460_000);
    expect(busy.compacted).toEqual([450_000]);
    expect(busy.notes).toEqual(["compact-at: 450000 > 400000 tokens, compacting", "compact-at: Pi is already compacting; standing down"]);
    const broken = harness({ enabled: true, reserveTokens: 16_384 });
    broken.fail("provider exploded");
    broken.turn(450_000);
    broken.turn(460_000);
    expect(broken.compacted).toEqual([450_000, 460_000]);
    expect(broken.notes).toContain("compact-at: compaction failed: provider exploded");
  });
});
