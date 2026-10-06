import { describe, expect, it } from "vitest";
import { decodeProject } from "./domain.ts";
import { flowLine } from "./tokens.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { laneOpen, projectOpen } from "./ops.ts";
import { load } from "./store.ts";
import { failWith } from "./test-support.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { deskFeed, FEED_CLAIM } from "./desk-feed.ts";
import { registerDeskFeed } from "./desk-feed-ext.ts";
import { projectPath } from "./store.ts";

export async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  const { project } = await runWith(h, projectOpen({ dir, slug: "flow", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  return { h, dir, project };
}
export function lane(slug: string, extra: Record<string, unknown> = {}) {
  return { slug, kind: "work", label: slug, goal: "ship", writeScope: [], generated: [], repo: null, base: null, tabId: null, root: null, state: "proposed", archived: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...extra };
}

describe("pull flow", () => {
  it("renders the pull prompt as its own visible line, not hidden message content", () => {
    type Renderer = Parameters<Parameters<typeof registerDeskFeed>[0]["registerMessageRenderer"]>[1];
    let renderer: Renderer | undefined;
    const claims = globalThis as { [FEED_CLAIM]?: string };
    const prior = claims[FEED_CLAIM];
    delete claims[FEED_CLAIM];
    try {
      // Boundary double: registration uses only on and registerMessageRenderer.
      registerDeskFeed({ on: () => {}, registerMessageRenderer: (_type: string, render: Renderer) => { renderer = render; } } as never, {});
      const pull = "pull: 2 slots open; next up a, b";
      const theme = { fg: (_color: unknown, text: string) => text, bg: (_color: unknown, text: string) => text, bold: (text: string) => text };
      const view = renderer?.({ role: "custom", timestamp: 0, customType: "desk-note", content: "hidden", display: true, details: { project: "flow", items: [], inbox: { open: 0, blocked: 0, approval: 0, decision: 0, oldestMs: 0 }, flow: "WIP 1/3", pull } }, { expanded: false }, theme as never);
      expect(view?.render(200).join("\n")).toContain(pull);
    } finally {
      if (prior === undefined) delete claims[FEED_CLAIM]; else claims[FEED_CLAIM] = prior;
    }
  });
  it("prompts once per slot change and shapes an empty backlog, including after restore", async () => {
    const { h, dir, project } = await setup();
    const save = (lanes: ReturnType<typeof lane>[], policy = { wipLimit: 3 }) => writeFileSync(projectPath(dir), JSON.stringify({ ...project, policy, lanes }));
    const entries: { type: string; customType: string; data: unknown }[] = [];
    const make = () => deskFeed({ project: dir, home: h.home, path: join(dir, "empty.jsonl"), now: () => h.now.getTime(), sendMessage: () => {}, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) });
    const feed = make();
    save([lane("active", { state: "open" }), lane("b", { rank: 2 }), lane("a", { rank: 1 })]);
    feed.restore([]);
    const first = feed.beforeTurn()?.message;
    expect(first?.content).toContain("pull: 2 slots open; next up a, b");
    expect(first?.details.pull).toBe("pull: 2 slots open; next up a, b");
    feed.turnEnded();
    expect(feed.beforeTurn()?.message.content).not.toContain("pull:");
    const restored = make();
    restored.restore(entries);
    expect(restored.beforeTurn()?.message.content).not.toContain("pull:");
    save([]);
    feed.turnEnded();
    expect(feed.beforeTurn()?.message.content).toContain("backlog empty: shape the next lanes with lane_open open: false");
    feed.turnEnded();
    expect(feed.beforeTurn()?.message.content).not.toContain("shape the next");
    save([lane("a", { state: "open" }), lane("b", { state: "open" }), lane("c", { state: "open" })]);
    feed.turnEnded();
    expect(feed.beforeTurn()?.message.content).not.toContain("pull:");
    save([lane("a", { rank: 1 })]);
    feed.turnEnded();
    expect(feed.beforeTurn()?.message.content).toContain("pull: 3 slots open; next up a");
    save([], { wipLimit: 0 }); // Invalid catalog fails closed, not a fictitious pull.
    feed.turnEnded();
    expect(feed.beforeTurn()).toBeUndefined();
  });
  it("re-ranks and amends a proposed lane together without opening a tab", async () => {
    const { h, dir } = await setup();
    const parked = { slug: "parked", label: "original", goal: "original", open: false, rank: 10 };
    const first = await runWith(h, laneOpen(dir, parked));
    const tabs = h.herdr.tabs.size;
    h.now = new Date(h.now.getTime() + 60_000);
    const rerank = { ...parked, rank: -1, label: "amended", goal: "amended", base: "release" };
    const second = await runWith(h, laneOpen(dir, rerank));
    expect(second.lane).toEqual({ ...first.lane, rank: -1, label: "amended", goal: "amended", base: "release", updatedAt: h.now.toISOString() });
    expect(second.note).toBe("changed: rank 10→-1, goal updated, label updated, base updated; stored goal: amended");
    expect(h.herdr.tabs.size).toBe(tabs);
    expect((await runWith(h, load(dir))).lanes.find(l => l.slug === "parked")?.rank).toBe(-1);
    const invalid = { ...parked, rank: 1.5 };
    expect((await failWith(h, laneOpen(dir, invalid))).message).toContain("integer");
    const opened = await runWith(h, laneOpen(dir, { ...parked, open: true }));
    expect(opened.lane.openedAt).toBe(h.now.toISOString());
  });
  it("measures median cycle over the last ten proven lanes and weekly throughput", async () => {
    const { project } = await setup();
    const now = Date.parse("2026-10-05T00:00:00.000Z");
    const lanes = Array.from({ length: 12 }, (_, i) => {
      const proven = now - i * 86_400_000;
      return lane(`done-${i}`, { state: "closed", delivery: "proven", openedAt: new Date(proven - (i + 1) * 3_600_000).toISOString(),
        deliveryHistory: [{ stage: "proven", at: new Date(proven).toISOString(), evidence: "checked" }, { stage: "proven", at: new Date(proven + 1).toISOString(), evidence: "checked again" }] });
    });
    const p = decodeProject({ ...project, lanes });
    expect(flowLine(p, now)).toContain("cycle 5h");
    expect(flowLine(p, now)).toContain("8/wk");
    const empty = flowLine(decodeProject({ ...project, lanes: [] }), now);
    expect(empty).not.toContain("cycle");
    expect(empty).not.toContain("/wk");
    expect(empty).not.toContain("last proven");
    expect(flowLine(decodeProject({ ...project, lanes: [lanes[11]] }), now)).toContain("0/wk");
  });
  it("shows free slots and the ranked backlog, breaking ties by creation time", async () => {
    const { project } = await setup();
    const p = decodeProject({ ...project, lanes: [lane("unranked"), lane("later", { rank: 1, createdAt: "2026-10-02T00:00:00.000Z" }), lane("first", { rank: 1 }), lane("role", { kind: "role", rank: 0 }), lane("active", { state: "open" })] });
    expect(flowLine(p)).toContain("2 open · next: first");
    expect(flowLine(decodeProject({ ...p, lanes: [] }))).toContain("3 open · backlog empty");
    expect(flowLine(decodeProject({ ...p, policy: { wipLimit: null } }))).not.toContain("open · next:");
  });
});
