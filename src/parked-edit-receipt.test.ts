import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import muster from "./extension-main.ts";
import { join } from "node:path";
import { laneOpen, projectOpen } from "./ops.ts";
import { load } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "receipt", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  return { h, dir };
}

const parked = { slug: "parked", label: "original", goal: "original", base: "main", open: false, rank: 9 };

describe("parked edit receipt", () => {
  it("accepts rank-only inputs at the lane_open tool boundary", () => {
    const tools = new Map<string, ToolDefinition>();
    // SAFETY: inert startup fake implements only the registration APIs used by Muster.
    const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerFlag() {}, registerCommand() {}, registerShortcut() {}, on() {}, getFlag() {},
      registerMessageRenderer() {}, events: { on: () => () => {}, emit() {} } } as unknown as ExtensionAPI;
    vi.stubEnv("MUSTER_ROLE", "boss");
    try {
      muster(pi);
      const schema = tools.get("lane_open")!.parameters;
      expect(schema).not.toMatchObject({ required: expect.arrayContaining(["goal"]) });
      expect(schema).not.toMatchObject({ required: expect.arrayContaining(["label"]) });
      expect(schema).toMatchObject({ required: expect.arrayContaining(["slug"]), properties: { goal: { type: "string" }, label: { type: "string" } } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("persists rank, goal, label and base together without opening work", async () => {
    const { h, dir } = await setup();
    const first = await runWith(h, laneOpen(dir, parked));
    const before = await runWith(h, load(dir));
    const tabs = h.herdr.tabs.size;
    h.now = new Date(h.now.getTime() + 60_000);
    const goal = "amended ".repeat(40);
    const result = await runWith(h, laneOpen(dir, { ...parked, rank: 2, goal, label: "amended", base: "release" }));
    const after = await runWith(h, load(dir));
    expect(after.lanes.find(l => l.slug === parked.slug)).toEqual(result.lane);
    expect(result.lane).toMatchObject({ rank: 2, goal, label: "amended", base: "release", state: "proposed", root: null, tabId: null, delivery: "none", createdAt: first.lane.createdAt, updatedAt: h.now.toISOString() });
    expect(after.policy).toEqual(before.policy);
    expect(h.herdr.tabs.size).toBe(tabs);
    expect(result.note).toBe(`changed: rank 9→2, goal updated, label updated, base updated; stored goal: ${goal.slice(0, 200)}`);
  });

  it("keeps the goal and timestamp untouched on a rank-only call", async () => {
    const { h, dir } = await setup();
    const first = await runWith(h, laneOpen(dir, parked));
    h.now = new Date(h.now.getTime() + 60_000);
    const result = await runWith(h, laneOpen(dir, { slug: parked.slug, open: false, rank: 2 }));
    expect(result.lane).toEqual({ ...first.lane, rank: 2 });
    expect((await runWith(h, load(dir))).lanes[0]).toEqual(result.lane);
    expect(result.note).toBe("changed: rank 9→2; stored goal: original");
  });

  it("refuses new lanes missing goal or label without creating a lane or tab", async () => {
    const { h, dir } = await setup();
    const tabs = h.herdr.tabs.size;
    for (const open of [false, true]) {
      expect((await failWith(h, laneOpen(dir, { slug: "missing-goal", label: "new", open }))).message).toContain("new lane missing-goal requires goal and label");
      expect((await failWith(h, laneOpen(dir, { slug: "missing-label", goal: "new", open }))).message).toContain("new lane missing-label requires goal and label");
    }
    expect((await runWith(h, load(dir))).lanes).toEqual([]);
    expect(h.herdr.tabs.size).toBe(tabs);
  });

  it("requires an explicit goal to first open parked work, but keeps an omitted label", async () => {
    const { h, dir } = await setup();
    const first = await runWith(h, laneOpen(dir, parked));
    const tabs = h.herdr.tabs.size;
    expect((await failWith(h, laneOpen(dir, { slug: parked.slug, open: true }))).message).toContain("first opening lane parked requires goal");
    expect((await runWith(h, load(dir))).lanes[0]).toEqual(first.lane);
    expect(h.herdr.tabs.size).toBe(tabs);
    const opened = await runWith(h, laneOpen(dir, { slug: parked.slug, goal: "ready", open: true }));
    expect(opened.lane).toMatchObject({ label: "original", goal: "ready", state: "open" });
    const reopened = await runWith(h, laneOpen(dir, { slug: parked.slug, open: true }));
    expect(reopened.lane).toEqual(opened.lane);
  });

  it("amends only supplied parked fields", async () => {
    const { h, dir } = await setup();
    await runWith(h, laneOpen(dir, parked));
    const goal = await runWith(h, laneOpen(dir, { slug: parked.slug, goal: "new goal", open: false }));
    expect(goal.lane).toMatchObject({ goal: "new goal", label: "original" });
    expect(goal.note).toBe("changed: goal updated; stored goal: new goal");
    const label = await runWith(h, laneOpen(dir, { slug: parked.slug, label: "new label", open: false }));
    expect(label.lane).toMatchObject({ goal: "new goal", label: "new label" });
    expect(label.note).toBe("changed: label updated; stored goal: new goal");
  });

  it("receipts parked edits without rank and explicitly names no changes", async () => {
    const { h, dir } = await setup();
    await runWith(h, laneOpen(dir, parked));
    const { rank: _rank, ...withoutRank } = parked;
    const result = await runWith(h, laneOpen(dir, { ...withoutRank, goal: "new", label: "new" }));
    expect(result.lane).toMatchObject({ goal: "new", label: "new", rank: 9 });
    expect(result.note).toBe("changed: goal updated, label updated; stored goal: new");
    const same = await runWith(h, laneOpen(dir, { ...parked, goal: "new", label: "new" }));
    expect(same.note).toBe("changed: none; stored goal: new");
  });
});
