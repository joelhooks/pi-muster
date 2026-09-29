import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseThreshold, roleThreshold } from "./compact.ts";
import { silenceLimits } from "./domain.ts";
import type { DeskItem, Project } from "./domain.ts";
import { readHolder, tryAcquire } from "./heavy-lock.ts";
import { costFromLines, readSessionCost, turnCost } from "./session-file.ts";
import { CAPTURE_REFRESH_MARK, captureRefreshNote, silenceDecision } from "./silence.ts";

const NUDGE_AFTER_MS = 30 * 60_000;
const RESTART_AFTER_MS = 60 * 60_000;
import { TOKEN_MAX_CHARS, deriveTokens, openDeskItems } from "./tokens.ts";

describe("silence thresholds", () => {
  it("does nothing under 30 minutes", () => {
    expect(silenceDecision("running", NUDGE_AFTER_MS - 1)).toEqual({ events: [], action: "none" });
  });
  it("nudges at 30 minutes, restarts a nudged row at 60", () => {
    expect(silenceDecision("running", NUDGE_AFTER_MS).action).toBe("nudge");
    expect(silenceDecision("running", RESTART_AFTER_MS + 1).action).toBe("nudge");
    expect(silenceDecision("nudged", RESTART_AFTER_MS - 1)).toEqual({ events: [], action: "none" });
    expect(silenceDecision("nudged", RESTART_AFTER_MS)).toEqual({ events: [{ type: "RESTART" }], action: "restart" });
  });
  it("follows project policy, including never restarting", () => {
    const patient = silenceLimits({ nudgeAfterMin: 90, restartAfterMin: null });
    expect(silenceDecision("running", NUDGE_AFTER_MS, patient).action).toBe("none");
    expect(silenceDecision("running", 90 * 60_000, patient).action).toBe("nudge");
    expect(silenceDecision("nudged", 24 * 60 * 60_000, patient)).toEqual({ events: [], action: "none" });
    expect(silenceLimits({ nudgeAfterMin: 45, restartAfterMin: 20 }).restartMs).toBe(45 * 60_000);
  });
  it("returns fresh silent rows to running and ignores non-working states", () => {
    expect(silenceDecision("nudged", 5_000).events).toEqual([{ type: "ACTIVE" }]);
    expect(silenceDecision("reported", RESTART_AFTER_MS * 3).action).toBe("none");
  });
});

const base: Project = {
  version: 1,
  slug: "p",
  label: "p",
  dir: "/p",
  outcome: "o",
  reviewTrigger: "r",
  criticalPath: [],
  nextAction: "n",
  mode: "rift-merge",
  spaceId: "w1",
  sidebar: "owned",
  ephemeral: false,
  musterExtension: null,
  deskExtension: null,
  cadenceMinutes: null,
  state: "active",
  lanes: [],
  agents: [],
  packets: [],
  reviews: [],
  createdAt: "t",
  updatedAt: "t",
};

const lane = (slug: string, state: "open" | "closed", kind: "work" | "role" = "work") => ({
  slug,
  kind,
  label: slug,
  goal: "g",
  writeScope: [],
  repo: null,
  generated: [],
  tabId: null,
  root: null,
  state,
  archived: false,
  createdAt: "t",
  updatedAt: "t",
});

const item = (id: string, kind: DeskItem["kind"], resolves?: string): DeskItem => ({ id, ts: "t", from: "h", kind, title: id, ...(resolves ? { resolves } : {}) });

describe("token derivation", () => {
  it("derives progress, agents, and needs from state", () => {
    const project = {
      ...base,
      lanes: [lane("a", "closed"), lane("b", "open"), lane("desk", "open", "role")],
      agents: (["running", "running", "nudged", "reported", "closed"] as const).map((state, index) => ({ state, name: `a${index}` })) as unknown as Project["agents"],
      packets: [{ state: "committed" }, { state: "reported" }] as unknown as Project["packets"],
    };
    const tokens = deriveTokens(project, [item("merge #1152", "decision"), item("d2", "blocked"), item("d3", "fyi")], { stuck: 1 });
    expect(tokens.now).toBe("n");
    expect(tokens.progress).toBe("🐑 1/2 lanes · 1 to land");
    expect(tokens.agents).toBe("⚠️ 1 stuck · 2 run · 1 silent");
    expect(tokens.needs).toBe("🙋 merge #1152 +1");
    for (const value of Object.values(tokens)) expect([...(value ?? "")].length).toBeLessThanOrEqual(TOKEN_MAX_CHARS);
  });
  it("says what the space is doing, and clips a long need by name", () => {
    const quiet = deriveTokens({ ...base, headline: "cutover live · payments round trip next" }, [item("approve the release notes for the next version", "approval")]);
    expect(quiet.now).toBe("cutover live · payments round t…");
    expect(quiet.progress).toBe("🐑 no lanes");
    expect(quiet.needs?.startsWith("🙋 approve the release")).toBe(true);
    for (const value of Object.values(quiet)) expect([...(value ?? "")].length).toBeLessThanOrEqual(TOKEN_MAX_CHARS);
    expect(deriveTokens({ ...base, state: "archived" }, []).now).toBeNull();
  });
  it("clears needs once items are resolved", () => {
    const desk = [item("d1", "decision"), item("d2", "done", "d1")];
    expect(openDeskItems(desk)).toEqual([]);
    expect(deriveTokens(base, desk).needs).toBeNull();
    expect(deriveTokens(base, desk).agents).toBeNull();
  });
});

describe("session cost", () => {
  const line = (usage: object) => JSON.stringify({ type: "message", message: { role: "assistant", model: "m", usage } });
  it("prices reads at 0.1 and writes at 1.25 of input", () => {
    expect(turnCost({ input: 10, output: 999, cacheRead: 1000, cacheWrite: 100, totalTokens: 0 })).toBe(10 + 100 + 125);
  });
  it("sums turns and keeps the last context from usage", async () => {
    const lines = [
      line({ input: 2, output: 5, cacheRead: 100_000, cacheWrite: 2000, totalTokens: 102_007 }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      "not json with \"usage\"",
      line({ input: 1, output: 3, cacheRead: 102_000, cacheWrite: 500 }),
    ];
    const cost = costFromLines(lines);
    expect(cost.turns).toBe(2);
    expect(cost.cost).toBeCloseTo(2 + 10_000 + 2500 + 1 + 10_200 + 625);
    expect(cost.contextTokens).toBe(102_504);
    const file = join(mkdtempSync(join(tmpdir(), "cost-")), "s.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(await readSessionCost(file)).toEqual(cost);
  });
});

describe("bridge capture", () => {
  const failed = JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "error", errorMessage: "prompt-capture: this wake carries an older prompt" } });
  const ok = JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, stopReason: "stop" } });
  const user = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  it("flags a lane whose newest turn failed capture with no user message since", () => {
    expect(costFromLines([ok, failed], CAPTURE_REFRESH_MARK).captureStuck).toMatchObject({ afterRefresh: false });
    expect(costFromLines([failed, user("carry on")], CAPTURE_REFRESH_MARK).captureStuck).toBeNull();
    expect(costFromLines([failed, user("carry on"), ok], CAPTURE_REFRESH_MARK).captureStuck).toBeNull();
  });
  it("tells a failure right after Muster's refresh from a fresh one", () => {
    expect(costFromLines([failed, user(captureRefreshNote()), failed], CAPTURE_REFRESH_MARK).captureStuck).toMatchObject({ afterRefresh: true });
    expect(costFromLines([failed, user("hi"), failed], CAPTURE_REFRESH_MARK).captureStuck).toMatchObject({ afterRefresh: false });
  });
});

describe("compaction thresholds", () => {
  it("parses thresholds and role defaults", () => {
    expect(parseThreshold("300_000")).toBe(300000);
    expect(parseThreshold("off")).toBeNull();
    expect(parseThreshold("nope")).toBeUndefined();
    expect(roleThreshold("worker")).toBe(300000);
    expect(roleThreshold("king")).toBeUndefined();
  });
});

describe("heavy-job lock", () => {
  it("admits one holder and takes over a dead one", () => {
    const lock = join(mkdtempSync(join(tmpdir(), "lock-")), "heavy.lock");
    const first = tryAcquire(lock, "gate one");
    expect(first.ok).toBe(true);
    const second = tryAcquire(lock, "gate two");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder?.command).toBe("gate one");
    if (first.ok) first.release();
    const dead = tryAcquire(lock, "dead gate", 999_999_99);
    expect(dead.ok).toBe(true);
    expect(readHolder(lock)?.command).toBe("dead gate");
    const taken = tryAcquire(lock, "live gate");
    expect(taken.ok).toBe(true);
    if (taken.ok) taken.release();
  });
});
