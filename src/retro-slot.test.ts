import { join } from "node:path";
import { Effect } from "effect";
import { stepLane } from "./machines.ts";
import { decodeProject } from "./domain.ts";
import { backlog, flowLine, inFlight, openSlots } from "./tokens.ts";
import { describe, expect, it } from "vitest";
import { laneClose, laneOpen, projectOpen } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "retro-slot", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  return { h, dir };
}

describe("standing retro slot", () => {
  it("suggests a fresh dated retro slug despite legacy work and date collisions, then opens it at WIP 3/3", async () => {
    const { h, dir } = await setup();
    const date = h.now.toISOString().slice(0, 10);
    for (const slug of [`retro-${date}`, `retro-${date}-b`]) await runWith(h, laneOpen(dir, { slug, label: slug, goal: "old work", open: false }));
    let note: string | undefined;
    for (const slug of ["retro", "one", "two"]) {
      await runWith(h, laneOpen(dir, { slug, label: slug, goal: "old work" }));
      note = (await runWith(h, laneClose(dir, slug))).retro;
    }
    const slug = note?.match(/lane_open slug: "([^"]+)"/)?.[1];
    expect(slug).toBe(`retro-${date}-c`);
    if (!slug) throw new Error("retro note did not suggest a slug");
    for (const slug of ["active-a", "active-b", "active-c"]) await runWith(h, laneOpen(dir, { slug, label: slug, goal: "ship" }));
    const opened = await runWith(h, laneOpen(dir, { slug, label: "retro", goal: "review", kind: "retro" }));
    expect(opened.lane).toMatchObject({ slug, kind: "retro", state: "open" });
    const p = await runWith(h, load(dir));
    expect(p.lanes.find(lane => lane.slug === "retro")).toMatchObject({ kind: "work", state: "closed" });
    expect(inFlight(p)).toHaveLength(3);
  });
  it("refuses an explicit retro kind against existing work or role lanes by name", async () => {
    const { h, dir } = await setup();
    for (const kind of ["work", "role"] as const) {
      const slug = `legacy-${kind}`;
      await runWith(h, laneOpen(dir, { slug, label: slug, goal: "old lane", kind }));
      for (const state of ["open", "closed"] as const) {
        if (state === "closed") await runWith(h, laneClose(dir, slug));
        const tabs = h.herdr.tabs.size;
        const failure = await failWith(h, laneOpen(dir, { slug, label: slug, goal: "review", kind: "retro", override: "open a retro" }));
        expect(failure.message).toContain(slug);
        expect(failure.message).toContain(kind);
        expect(failure.message).toContain("retro");
        expect(h.herdr.tabs.size).toBe(tabs);
      }
    }
  });
  it("excludes retros from work counts and metrics and shows running before due", async () => {
    const { h, dir } = await setup();
    const { lane } = await runWith(h, laneOpen(dir, { slug: "retro", label: "retro", goal: "review", kind: "retro" }));
    const p = await runWith(h, load(dir));
    const at = h.now.toISOString();
    const closed = ["one", "two", "three"].map(slug => ({ ...lane, slug, kind: "work", state: "closed", delivery: "none", closedAt: at }));
    const project = decodeProject({ ...p, lanes: [...closed, lane, { ...lane, slug: "parked", state: "proposed" }, { ...lane, slug: "past-retro", state: "closed", delivery: "proven", deliveryAt: at }] });
    expect(inFlight(project)).toEqual([]);
    expect(openSlots(project)).toBe(3);
    expect(backlog(project)).toEqual([]);
    const line = flowLine(project, h.now.getTime());
    expect(line).toContain("WIP 0/3");
    expect(line).toContain("retro: running retro");
    expect(line).not.toContain("retro: due");
    expect(line).not.toContain("cycle");
    expect(line).not.toContain("/wk");
    expect(line).not.toContain("last proven");
    expect(flowLine(decodeProject({ ...project, lanes: closed }), h.now.getTime())).toContain("retro: due (3 closed)");
    expect(flowLine(decodeProject({ ...project, lanes: closed, lastRetroAt: at }), h.now.getTime())).not.toContain("retro:");
    expect(flowLine(decodeProject({ ...project, lanes: closed.slice(0, 2) }), h.now.getTime())).not.toContain("retro:");
    expect(flowLine(decodeProject({ ...project, lanes: closed.map(l => ({ ...l, discarded: true })) }), h.now.getTime())).not.toContain("retro:");
    expect(flowLine(decodeProject({ ...project, lanes: [{ ...lane, state: "draining" }] }), h.now.getTime())).toContain("retro: running retro");
  });
  it("gives an executable retro lane_open call in the due note", async () => {
    const { h, dir } = await setup();
    for (const slug of ["one", "two", "three"]) {
      await runWith(h, laneOpen(dir, { slug, label: slug, goal: "ship" }));
      const result = await runWith(h, laneClose(dir, slug));
      if (slug === "three") expect(result.retro).toContain('lane_open slug: "retro-2026-09-29" label: "🔁 retro" goal: "Review finished lanes" kind: "retro"');
    }
  });
  it("refuses a second open or draining retro by name, even with override", async () => {
    const { h, dir } = await setup();
    const first = { slug: "retro-first", label: "retro", goal: "review", kind: "retro" as const };
    await runWith(h, laneOpen(dir, first));
    expect((await runWith(h, laneOpen(dir, first))).created).toBe(false);
    await runWith(h, laneOpen(dir, { slug: "parked-retro", label: "retro", goal: "review", kind: "retro", open: false }));
    for (const state of ["open", "draining"] as const) {
      if (state === "draining") await runWith(h, mutate(dir, p => Effect.gen(function* () {
        const draining = yield* stepLane(first.slug, "open", { type: "DRAIN" });
        return [{ ...p, lanes: p.lanes.map(lane => lane.slug === first.slug ? { ...lane, state: draining } : lane) }, null] as const;
      })));
      const tabs = h.herdr.tabs.size;
      const failure = await failWith(h, laneOpen(dir, { slug: "parked-retro", label: "retro", goal: "review", kind: "retro", override: "Joel wants another" }));
      expect(failure.message).toContain("retro-first");
      expect(failure.message).toContain("retro");
      expect(h.herdr.tabs.size).toBe(tabs);
    }
  });
  it("reserves the single retro slot across concurrent opens", async () => {
    const { h, dir } = await setup();
    const results = await Promise.allSettled(["retro-a", "retro-b"].map(slug => runWith(h, laneOpen(dir, { slug, label: slug, goal: "review", kind: "retro" }))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await runWith(h, load(dir))).lanes.filter(lane => lane.kind === "retro" && lane.state === "open")).toHaveLength(1);
  });
  it("opens a retro at WIP 3/3 while still refusing work", async () => {
    const { h, dir } = await setup();
    for (const slug of ["one", "two", "three"]) await runWith(h, laneOpen(dir, { slug, label: slug, goal: "ship" }));
    const retro = await runWith(h, laneOpen(dir, { slug: "retro", label: "retro", goal: "review", kind: "retro" }));
    expect(retro.lane).toMatchObject({ kind: "retro", state: "open" });
    expect((await runWith(h, load(dir))).writerSchemaVersion).toBe(4);
    const failure = await failWith(h, laneOpen(dir, { slug: "four", label: "four", goal: "ship" }));
    expect(failure.message).toContain("WIP 3/3");
    expect(failure.message).not.toContain("retro (");
    await runWith(h, laneClose(dir, "retro"));
    expect((await runWith(h, laneOpen(dir, { slug: "next-retro", label: "retro", goal: "review", kind: "retro" }))).lane.state).toBe("open");
  });
});
