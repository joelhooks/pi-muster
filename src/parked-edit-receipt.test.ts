import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { laneOpen, projectOpen } from "./ops.ts";
import { load } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "receipt", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  return { h, dir };
}

const parked = { slug: "parked", label: "original", goal: "original", base: "main", open: false, rank: 9 };

describe("parked edit receipt", () => {
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
    const result = await runWith(h, laneOpen(dir, { ...parked, rank: 2 }));
    expect(result.lane).toEqual({ ...first.lane, rank: 2 });
    expect((await runWith(h, load(dir))).lanes[0]).toEqual(result.lane);
    expect(result.note).toBe("changed: rank 9→2; stored goal: original");
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
