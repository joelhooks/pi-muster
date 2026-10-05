import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { stepLane } from "./machines.ts";
import { laneClose, laneOpen, projectOpen, projectReview } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "discard", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  return { h, dir };
}

describe("closing proposed lanes", () => {
  it("enforces explicit discard in the lifecycle machine", async () => {
    const { h } = await setup();
    expect((await failWith(h, stepLane("parked", "proposed", { type: "CLOSE", liveAgents: 0, openPackets: 0 })))._tag).toBe("IllegalTransition");
    expect(await runWith(h, stepLane("parked", "proposed", { type: "CLOSE", liveAgents: 0, openPackets: 0, discard: true }))).toBe("closed");
    expect((await failWith(h, stepLane("parked", "proposed", { type: "CLOSE", liveAgents: 1, openPackets: 0, discard: true })))._tag).toBe("IllegalTransition");
  });

  it.each(["open", "draining"] as const)("ignores discard for a %s lane and closes its owned root as before", async state => {
    const { h, dir } = await setup();
    const opened = await runWith(h, laneOpen(dir, { slug: "started", label: "started", goal: "ship" }));
    if (state === "draining") await runWith(h, mutate(dir, project => Effect.gen(function* () {
      const next = yield* stepLane("started", "open", { type: "DRAIN" });
      return [{ ...project, lanes: project.lanes.map(lane => ({ ...lane, state: next })) }, null] as const;
    })));
    const closed = await runWith(h, laneClose(dir, "started", { discard: true }));
    expect(closed).toMatchObject({ closed: true, lane: { state: "closed", root: null, discarded: false } });
    expect(h.herdr.panes.has(opened.lane.root!.paneId)).toBe(false);
    expect((await runWith(h, projectReview(dir, { note: "real work" }))).retroLanes).toEqual([{ slug: "started", sessionFiles: [] }]);
  });
  it("discards only with explicit permission and excludes discarded lanes from retros", async () => {
    const { h, dir } = await setup();
    const open = async (slug: string, parked = false) => runWith(h, laneOpen(dir, { slug, label: slug, goal: "ship", open: !parked }));
    await open("one");
    await runWith(h, laneClose(dir, "one"));
    await open("two");
    await runWith(h, laneClose(dir, "two"));
    await open("parked", true);
    const discarded = await runWith(h, laneClose(dir, "parked", { discard: true }));
    expect(discarded.lane).toMatchObject({ state: "closed", discarded: true, closedAt: h.now.toISOString() });
    expect(discarded.lane.openedAt).toBeUndefined();
    expect(discarded).not.toHaveProperty("retro");
    expect((await runWith(h, load(dir))).lanes.find(lane => lane.slug === "parked")?.discarded).toBe(true);
    expect((await runWith(h, projectReview(dir, { note: "inspect retro" }))).retroLanes.map(lane => lane.slug)).toEqual(["one", "two"]);
    await open("three");
    const closed = await runWith(h, laneClose(dir, "three", { discard: true }));
    expect(closed.lane.state).toBe("closed");
    expect(closed.lane.discarded).not.toBe(true);
    expect(closed.retro).toBe("retro: 3 lanes closed since the last retro; run references/retro.md");
    await open("another-parked", true);
    expect(await runWith(h, laneClose(dir, "another-parked", { discard: true }))).not.toHaveProperty("retro");
    // Reopening a discarded lane makes it real work; its next close counts normally.
    await open("parked");
    expect((await runWith(h, laneClose(dir, "parked"))).lane.discarded).not.toBe(true);
    expect((await runWith(h, projectReview(dir, { note: "reopened work" }))).retroLanes.map(lane => lane.slug)).toEqual(["one", "two", "parked", "three"]);
  });
  it("refuses an accidental close and leaves the backlog unchanged", async () => {
    const { h, dir } = await setup();
    await runWith(h, laneOpen(dir, { slug: "parked", label: "parked", goal: "ship", open: false }));
    const before = await runWith(h, load(dir));
    const error = await failWith(h, laneClose(dir, "parked"));
    expect(error.message).toBe("lane parked was never opened; lane_open starts it (open: false keeps it parked). Pass discard: true to drop it from the backlog.");
    expect(await runWith(h, load(dir))).toEqual(before);
  });
});
