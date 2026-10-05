import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import muster from "./extension-main.ts";
import * as ops from "./ops.ts";
import * as versionSkew from "./version-skew.ts";
import { decodeAgentRow, decodeProject } from "./domain.ts";
import { laneClose, laneOpen, projectOpen, projectReview } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "retro", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  const close = async (slug: string, kind: "work" | "role" = "work") => {
    h.now = new Date(h.now.getTime() + 1000);
    await runWith(h, laneOpen(dir, { slug, label: slug, goal: "ship", kind }));
    return runWith(h, laneClose(dir, slug));
  };
  return { h, dir, close };
}

describe("finished lane retros", () => {
  it("prompts from three pending work lanes onward, not role lanes", async () => {
    const s = await setup();
    expect(await s.close("judge", "role")).not.toHaveProperty("retro");
    expect(await s.close("one")).not.toHaveProperty("retro");
    expect(await s.close("two")).not.toHaveProperty("retro");
    expect(await s.close("three")).toHaveProperty("retro", "retro: 3 lanes closed since the last retro; run project_review note: \"retro evidence\" for pending lanes' session, tail and report paths; run lane_open slug: \"retro-2026-09-29\" label: \"🔁 retro\" goal: \"Review finished lanes\" kind: \"retro\"; run references/retro.md");
    expect(await s.close("four")).toHaveProperty("retro", "retro: 4 lanes closed since the last retro; run project_review note: \"retro evidence\" for pending lanes' session, tail and report paths; run lane_open slug: \"retro-2026-09-29\" label: \"🔁 retro\" goal: \"Review finished lanes\" kind: \"retro\"; run references/retro.md");
    await runWith(s.h, projectReview(s.dir, { note: "done", retro: true }));
    expect(await s.close("five")).not.toHaveProperty("retro");
  });
  it("lists sessions, resets only on explicit completion, and never recounts archived lanes", async () => {
    const s = await setup();
    await s.close("one");
    const at = s.h.now.toISOString();
    await runWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p, agents: [decodeAgentRow({ name: "worker", role: "worker", lane: "one", cwd: s.dir, clone: null,
      profile: { label: "worker", model: "sol", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: null },
      sessionId: "worker", sessionFile: "/sessions/worker.jsonl", parentSessionFile: null, pane: null, owner: s.h.sessionId, brief: null,
      state: "closed", delivery: "none", restarts: 0, restore: null, createdAt: at, updatedAt: at })] }, null] as const)));
    s.h.now = new Date(s.h.now.getTime() + 1000);
    const review = await runWith(s.h, projectReview(s.dir, { note: "review" }));
    expect(review).toHaveProperty("retroLanes", [{ slug: "one", sessionFiles: ["/sessions/worker.jsonl"], closedTails: [], reports: [] }]);
    expect(review.project.lastRetroAt).toBeUndefined();
    const completed = await runWith(s.h, projectReview(s.dir, { note: "artifact recorded", retro: true }));
    expect(completed.project.lastRetroAt).toBe(s.h.now.toISOString());
    s.h.now = new Date(s.h.now.getTime() + 1000);
    expect(await runWith(s.h, projectReview(s.dir, { note: "again" }))).toHaveProperty("retroLanes", []);
    expect(await s.close("two")).not.toHaveProperty("retro");
    expect(await runWith(s.h, projectReview(s.dir, { note: "next" }))).toHaveProperty("retroLanes", [{ slug: "two", sessionFiles: [], closedTails: [], reports: [] }]);
  });
  it("renders the cadence reminder and review session paths in tool output", async () => {
    const s = await setup();
    await s.close("one");
    await s.close("two");
    const closed = await s.close("three");
    const reviewed = await runWith(s.h, projectReview(s.dir, { note: "review" }));
    const tools = new Map<string, ToolDefinition>();
    // SAFETY: registration-only fake implements the APIs used at extension startup.
    const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerFlag() {}, registerCommand() {}, registerShortcut() {}, on() {}, getFlag() {},
      registerMessageRenderer() {}, events: { on: () => () => {}, emit() {} } } as unknown as ExtensionAPI;
    const savedRole = process.env.MUSTER_ROLE;
    const savedProject = process.env.MUSTER_PROJECT;
    process.env.MUSTER_ROLE = "boss";
    process.env.MUSTER_PROJECT = s.dir;
    try {
      vi.spyOn(versionSkew, "createVersionSkew").mockReturnValue({ check: async () => undefined });
      vi.spyOn(ops, "laneClose").mockReturnValue(Effect.succeed(closed));
      vi.spyOn(ops, "projectReview").mockReturnValue(Effect.succeed({ ...reviewed, retroLanes: [
        { slug: "one", sessionFiles: ["/sessions/worker.jsonl"], closedTails: ["/closed/worker-100.txt", "/closed/worker-restart-200.txt"], reports: ["/reports/worker.svx"] },
        { slug: "two", sessionFiles: [], closedTails: [], reports: [] },
      ] }));
      muster(pi);
      // SAFETY: these mocked operations need only the session identity, not live UI.
      const ctx = { cwd: s.dir, sessionManager: { getSessionId: () => "test", getBranch: () => [] } } as unknown as Parameters<ToolDefinition["execute"]>[4];
      const closeResult = await tools.get("lane_close")!.execute("id", { slug: "three" }, undefined, undefined, ctx);
      expect(closeResult.content).toContainEqual({ type: "text", text: expect.stringContaining('run project_review note: "retro evidence"') });
      const reviewResult = await tools.get("project_review")!.execute("id", { note: "complete", retro: true }, undefined, undefined, ctx);
      expect(reviewResult.content).toContainEqual({ type: "text", text: expect.stringContaining("retro lane: one; worker sessions: /sessions/worker.jsonl; closed tails: /closed/worker-100.txt, /closed/worker-restart-200.txt; reports: /reports/worker.svx\nretro lane: two; worker sessions: none recorded; closed tails: none recorded; reports: none recorded") });
      expect(ops.projectReview).toHaveBeenLastCalledWith(s.dir, { note: "complete", retro: true });
    } finally {
      vi.restoreAllMocks();
      if (savedRole === undefined) delete process.env.MUSTER_ROLE; else process.env.MUSTER_ROLE = savedRole;
      if (savedProject === undefined) delete process.env.MUSTER_PROJECT; else process.env.MUSTER_PROJECT = savedProject;
    }
  });
  it("preserves an old lane's fallback close time through repeated reviews", async () => {
    const s = await setup();
    await s.close("old");
    await runWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p, lanes: p.lanes.map(lane => {
      const { closedAt: _closedAt, ...oldLane } = lane;
      return oldLane;
    }) }, null] as const)));
    const closedAt = s.h.now.toISOString();
    s.h.now = new Date(s.h.now.getTime() + 1000);
    const first = await runWith(s.h, projectReview(s.dir, { note: "completed", retro: true }));
    expect(first.project.lanes[0]?.closedAt).toBe(closedAt);
    s.h.now = new Date(s.h.now.getTime() + 1000);
    expect(await runWith(s.h, projectReview(s.dir, { note: "again" }))).toHaveProperty("retroLanes", []);
  });
  it("round-trips the optional marker and accepts old catalogs", async () => {
    const s = await setup();
    const p = await runWith(s.h, load(s.dir));
    expect(decodeProject(JSON.parse(JSON.stringify(p))).lastRetroAt).toBeUndefined();
    const at = s.h.now.toISOString();
    expect(decodeProject(JSON.parse(JSON.stringify({ ...p, lastRetroAt: at }))).lastRetroAt).toBe(at);
  });
});
