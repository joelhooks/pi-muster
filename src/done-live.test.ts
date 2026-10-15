import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { HerdrApiError } from "@joelhooks/pi-bellwether/herdr-client";
import { describe, expect, it, vi } from "vitest";
import { decodeAgentRow, decodeProject } from "./domain.ts";
import { board, laneClose, laneDeliver, laneOpen, packetLand, projectOpen, projectUpdate, reportMarkdown } from "./ops.ts";
import { flowLine, inFlight } from "./tokens.ts";
import { load, mutate, projectPath } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";
import { OwnerTimelineView, readOwnerTimelineData } from "./owner-view.ts";
import { registryPath } from "./registry.ts";
import { ownerFeed } from "./owner-feed.ts";
import { FEED_CLAIM, deskFeed } from "./desk-feed.ts";

async function setup(limit: number | null = 3) {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "flow", outcome: "ship live", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  await runWith(h, projectUpdate(dir, { policy: { wipLimit: limit } }));
  const lane = (slug: string, extra = {}) => runWith(h, laneOpen(dir, { slug, label: slug, goal: "ship", ...extra }));
  return { h, dir, lane };
}
async function landed(s: Awaited<ReturnType<typeof setup>>, slug: string) {
  const at = s.h.now.toISOString();
  const row = decodeAgentRow({ name: "worker", role: "worker", lane: slug, cwd: s.dir, clone: null,
    profile: { label: "worker", model: "sol", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: null },
    sessionId: "worker", sessionFile: null, parentSessionFile: null, pane: null, owner: s.h.sessionId, brief: null,
    state: "closed", delivery: "none", restarts: 0, restore: null, createdAt: at, updatedAt: at });
  await runWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p, agents: [row], packets: [...p.packets, {
    id: slug, kind: "artifact" as const, lane: slug, agent: "worker", artifact: "/artifact", report: "/report", checks: [],
    state: "verified" as const, verification: { at, checks: [] }, landedAs: null, gate: null, supersedes: null, reportedAt: at, updatedAt: at,
  }] }, null] as const)));
  return runWith(s.h, packetLand(s.dir, { id: slug, outcome: "committed", evidence: "owner checked artifact" }));
}

describe("live delivery and WIP", () => {
  it("refuses at the limit before opening a tab and records Joel's override", async () => {
    const s = await setup(1);
    await s.lane("one");
    const tabs = s.h.herdr.tabs.size;
    const error = await failWith(s.h, laneOpen(s.dir, { slug: "two", label: "two", goal: "ship" }));
    expect(error.message).toContain("WIP 1/1");
    expect(error.message).toContain("one (none,");
    expect(error.message).toContain("open: false");
    expect(s.h.herdr.tabs.size).toBe(tabs);
    expect((await s.lane("two", { override: "Joel says ship this too" })).lane.override).toBe("Joel says ship this too");
    expect(inFlight(await runWith(s.h, load(s.dir)))).toHaveLength(2);
  });
  it("parked and role lanes do not count; null disables the limit", async () => {
    const s = await setup(1);
    await s.lane("parked", { open: false });
    await s.lane("hawk", { kind: "role" });
    await s.lane("one");
    expect(inFlight(await runWith(s.h, load(s.dir))).map(l => l.slug)).toEqual(["one"]);
    expect((await failWith(s.h, laneOpen(s.dir, { slug: "parked", label: "parked", goal: "ship" }))).message).toContain("WIP 1/1");
    await runWith(s.h, projectUpdate(s.dir, { policy: { wipLimit: null } }));
    await s.lane("parked");
    expect(inFlight(await runWith(s.h, load(s.dir)))).toHaveLength(2);
  });
  it("landed work still counts after its tab closes, until proven or waived", async () => {
    const s = await setup(1);
    await s.lane("one");
    await landed(s, "one");
    await runWith(s.h, laneClose(s.dir, "one"));
    let p = await runWith(s.h, load(s.dir));
    expect(p.lanes.find(l => l.slug === "one")?.delivery).toBe("landed");
    expect(inFlight(p)).toHaveLength(1);
    expect((await failWith(s.h, laneOpen(s.dir, { slug: "two", label: "two", goal: "ship" }))).message).toContain("one (landed,");
    await runWith(s.h, laneDeliver(s.dir, { slug: "one", stage: "deployed", evidence: "loaded commit in the service" }));
    p = await runWith(s.h, load(s.dir));
    expect(inFlight(p)).toHaveLength(1);
    await runWith(s.h, laneDeliver(s.dir, { slug: "one", stage: "proven", evidence: "live request returns the new response" }));
    expect(inFlight(await runWith(s.h, load(s.dir)))).toHaveLength(0);
    await s.lane("two");
    await runWith(s.h, laneClose(s.dir, "two"));
    await runWith(s.h, laneDeliver(s.dir, { slug: "two", stage: "waived", evidence: "docs only, nothing to deploy" }));
  });
  it("stages move forward only, evidence is required, and history is durable", async () => {
    const s = await setup();
    await s.lane("one");
    expect((await failWith(s.h, laneDeliver(s.dir, { slug: "one", stage: "proven", evidence: "not landed" }))).message).toContain("not allowed");
    await landed(s, "one");
    expect((await failWith(s.h, laneDeliver(s.dir, { slug: "one", stage: "deployed", evidence: " " }))).message).toContain("evidence");
    await runWith(s.h, laneDeliver(s.dir, { slug: "one", stage: "proven", evidence: "live check passed" }));
    expect((await failWith(s.h, laneDeliver(s.dir, { slug: "one", stage: "deployed", evidence: "backwards" }))).message).toContain("not allowed");
    expect((await runWith(s.h, load(s.dir))).lanes.find(l => l.slug === "one")?.deliveryHistory?.map(e => e.stage)).toEqual(["landed", "proven"]);
  });
  it("backfills a pre-change project file, but never auto-proves new landed work", async () => {
    const s = await setup();
    await s.lane("old");
    await landed(s, "old");
    const raw = JSON.parse(readFileSync(projectPath(s.dir), "utf8"));
    for (const lane of raw.lanes) for (const key of ["delivery", "deliveryAt", "deliveryEvidence", "deliveryHistory"]) delete lane[key];
    delete raw.policy;
    writeFileSync(projectPath(s.dir), JSON.stringify(raw));
    const p = await runWith(s.h, load(s.dir));
    expect(p.lanes.find(l => l.slug === "old")).toMatchObject({ delivery: "proven", deliveryEvidence: "before done-live" });
    expect(decodeProject(raw).lanes.find(l => l.slug === "old")?.delivery).toBe("proven");
    await s.lane("new");
    await landed(s, "new");
    expect((await runWith(s.h, load(s.dir))).lanes.find(l => l.slug === "new")?.delivery).toBe("landed");
  });
  it("flags stalled delivery and clears the stall on a stage move", async () => {
    const s = await setup();
    await s.lane("one");
    s.h.now = new Date(s.h.now.getTime() + 121 * 60_000);
    expect(flowLine(await runWith(s.h, load(s.dir)), s.h.now.getTime())).toContain("⚠ not flowing");
    await landed(s, "one");
    const p = await runWith(s.h, load(s.dir));
    expect(flowLine(p, s.h.now.getTime())).not.toContain("⚠ not flowing");
    expect(board(p, [], 0, s.h.now.getTime())).toContain("WIP 1/3 · 2 open · backlog empty · landed, not live: one");
  });
  // Owl (drovr), 2026-10-12: five lanes landed on storage-wave-3 read as waiting on a release no one could ship.
  it("splits lanes landed on a long-lived base branch from lanes waiting on a release", async () => {
    const s = await setup();
    await runWith(s.h, projectUpdate(s.dir, { policy: { wipLimit: null } }));
    for (const slug of ["broadcasts", "switch", "archive", "mirror"]) { await s.lane(slug); await landed(s, slug); }
    await runWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p, lanes: p.lanes.map(lane => ({ ...lane,
      base: lane.slug === "switch" || lane.slug === "archive" ? "storage-wave-3" : lane.slug === "mirror" ? "walgit/main" : lane.base })) }, undefined] as const)));
    const line = flowLine(await runWith(s.h, load(s.dir)), s.h.now.getTime());
    expect(line).toContain("landed, not live: broadcasts now, mirror now · waiting on storage-wave-3 to merge: switch now, archive now");
  });
  it("reads naturally with nothing in flight and a fresh proof", async () => {
    const s = await setup();
    await s.lane("one");
    await landed(s, "one");
    await runWith(s.h, laneDeliver(s.dir, { slug: "one", stage: "proven", evidence: "checked live" }));
    await runWith(s.h, laneClose(s.dir, "one"));
    const line = flowLine(await runWith(s.h, load(s.dir)), s.h.now.getTime());
    expect(line).toBe("WIP 0/3 · 3 open · backlog empty · landed, not live: none · last proven just now · cycle now · 1/wk");
  });
  // drovr 22991118, 2026-10-14: a packet parked on Joel's decision by design read as a stall.
  it("a packet an open decision or approval names is waiting on Joel, not stalled", async () => {
    const s = await setup();
    await s.lane("one");
    await landed(s, "one");
    const sha = "22991118a086c0ffee0123456789abcdef012345";
    await runWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p, packets: p.packets.map(packet => ({ ...packet, id: sha, state: "verified" as const })) }, null] as const)));
    s.h.now = new Date(s.h.now.getTime() + 31 * 60_000);
    const p = await runWith(s.h, load(s.dir));
    expect(flowLine(p, s.h.now.getTime())).toContain("⚠ not flowing");
    const id = p.packets[0]!.id;
    const ask = (kind: "decision" | "approval" | "fyi", patch = {}) => ({ id: `d-${kind}`, ts: s.h.now.toISOString(), from: "owner", kind, title: `ship ${id.slice(0, 8)}?`, ...patch });
    expect(flowLine(p, s.h.now.getTime(), [ask("decision")])).not.toContain("⚠ not flowing");
    expect(flowLine(p, s.h.now.getTime(), [ask("approval", { title: "ship it?", refs: [`packet:${id.slice(0, 12)}`] })])).not.toContain("⚠ not flowing");
    expect(flowLine(p, s.h.now.getTime(), [ask("fyi")])).toContain("⚠ not flowing");
    expect(flowLine(p, s.h.now.getTime(), [ask("decision"), { id: "r", ts: s.h.now.toISOString(), from: "desk", kind: "done", title: "ruled", resolves: "d-decision" }])).toContain("⚠ not flowing");
    expect(board(p, [], 1, s.h.now.getTime(), null, new Map(), [ask("decision")])).not.toContain("⚠ not flowing");
  });
  it("flags a reported or verified packet waiting more than landWaitMin", async () => {
    const s = await setup();
    await s.lane("one");
    await landed(s, "one");
    await runWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p, packets: p.packets.map(packet => ({ ...packet, state: "reported" as const })) }, null] as const)));
    s.h.now = new Date(s.h.now.getTime() + 31 * 60_000);
    expect(flowLine(await runWith(s.h, load(s.dir)), s.h.now.getTime())).toContain("⚠ not flowing");
    await runWith(s.h, projectUpdate(s.dir, { policy: { landWaitMin: 60, flowStallMin: 240 } }));
    expect(flowLine(await runWith(s.h, load(s.dir)), s.h.now.getTime())).not.toContain("⚠ not flowing");
  });
  // Joel, 2026-10-14 ("should remove that shit"): in the desk note's text the flow line read as words Joel wrote.
  it("the desk note never carries the flow line in its text; it rides in details only", async () => {
    const s = await setup();
    mkdirSync(join(registryPath(s.h.home), ".."), { recursive: true });
    writeFileSync(registryPath(s.h.home), JSON.stringify({ slug: "flow", dir: s.dir, spaceId: "w1", ts: s.h.now.toISOString() }) + "\n");
    const queue = join(s.dir, "desk.jsonl");
    const desk = deskFeed({ project: "flow", home: s.h.home, path: queue, now: () => s.h.now.getTime(), appendEntry: () => {}, sendMessage: () => {} });
    desk.restore([]);
    await s.lane("one");
    s.h.now = new Date(s.h.now.getTime() + 121 * 60_000);
    // The first turn may carry the pull line; it never carries the flow line.
    expect(desk.beforeTurn()?.message.content ?? "").not.toMatch(/WIP \d|not flowing/);
    desk.turnEnded();
    expect(desk.beforeTurn()).toBeUndefined(); // no notice and no slot change: no note just for the flow line
    desk.turnEnded();
    appendFileSync(queue, JSON.stringify({ id: "n1", ts: s.h.now.toISOString(), from: "owner", kind: "done", title: "finished" }) + "\n");
    const note = desk.beforeTurn()?.message;
    expect(note?.content).toContain("finished");
    expect(note?.content).not.toMatch(/WIP \d|not flowing|landed, not live/);
    expect(note?.details.flow).toContain("⚠ not flowing · WIP 1/3");
  });
  it("the owner feed includes a fresh line every turn, even with no notices", async () => {
    const s = await setup();
    const owner = ownerFeed({ session: "owner", home: s.h.home, project: s.dir, appendEntry: () => {}, sendMessage: () => {} });
    mkdirSync(join(registryPath(s.h.home), ".."), { recursive: true });
    writeFileSync(registryPath(s.h.home), JSON.stringify({ slug: "flow", dir: s.dir, spaceId: "w1", ts: s.h.now.toISOString() }) + "\n");
    expect(owner.beforeTurn()?.message.content).toContain("WIP 0/3");
    await s.lane("one");
    owner.turnEnded();
    expect(owner.beforeTurn()?.message.content).toContain("WIP 1/3");
    owner.dispose();
  });
  it("lets the Muster desk feed own the line without an owner-feed duplicate", async () => {
    const s = await setup();
    const claims = globalThis as { [FEED_CLAIM]?: string };
    const previous = claims[FEED_CLAIM];
    const owner = ownerFeed({ session: "owner", home: s.h.home, project: s.dir, appendEntry: () => {}, sendMessage: () => {} });
    try {
      claims[FEED_CLAIM] = "pi-muster";
      expect(owner.beforeTurn()).toBeUndefined();
    } finally {
      if (previous === undefined) delete claims[FEED_CLAIM]; else claims[FEED_CLAIM] = previous;
      owner.dispose();
    }
  });
  it("renders the flow line from feed details as one visible line", async () => {
    const s = await setup();
    const owner = ownerFeed({ session: "owner", home: s.h.home, project: s.dir, appendEntry: () => {}, sendMessage: () => {} });
    const details = readOwnerTimelineData(owner.beforeTurn()?.message.details);
    expect(details?.flow).toContain("WIP 0/3");
    const view = new OwnerTimelineView(details!, { expanded: false, noColor: true }, { fg: (_color, text) => text, bold: text => text });
    expect(view.render(200)).toHaveLength(1);
    expect(view.render(200)[0]).toContain("WIP 0/3");
    owner.dispose();
  });
  it("keeps rejected and no_changes work out of delivery after closing", async () => {
    for (const outcome of ["rejected", "no_changes"] as const) {
      const s = await setup(1);
      await s.lane("one");
      await landed(s, "one");
      await runWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p,
        packets: p.packets.map(packet => ({ ...packet, state: "reported" as const })),
        lanes: p.lanes.map(lane => ({ ...lane, delivery: "none" as const })),
      }, null] as const)));
      await runWith(s.h, packetLand(s.dir, { id: "one", outcome, evidence: "probe result recorded" }));
      await runWith(s.h, laneClose(s.dir, "one"));
      expect(inFlight(await runWith(s.h, load(s.dir)))).toHaveLength(0);
      await s.lane("two");
    }
  });
  it("admits at most one concurrent new lane at a limit of one", async () => {
    const s = await setup(1);
    const results = await Promise.allSettled([s.lane("one"), s.lane("two")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(s.h.herdr.tabs.size).toBe(1);
    expect(inFlight(await runWith(s.h, load(s.dir)))).toHaveLength(1);
  });
  it("releases reserved WIP through the lane machine if tab creation fails", async () => {
    const s = await setup(1);
    const original = s.h.herdr.handle.bind(s.h.herdr);
    const spy = vi.spyOn(s.h.herdr, "handle").mockImplementation((method, params) => {
      if (method === "tab.create") throw new HerdrApiError({ operation: "tab.create", code: "unavailable", message: "tab unavailable" });
      return original(method, params);
    });
    try {
      expect((await failWith(s.h, laneOpen(s.dir, { slug: "one", label: "one", goal: "ship" }))).message).toContain("tab unavailable");
      expect(inFlight(await runWith(s.h, load(s.dir)))).toHaveLength(0);
      expect((await runWith(s.h, load(s.dir))).lanes.find(lane => lane.slug === "one")?.state).toBe("proposed");
    } finally { spy.mockRestore(); }
    await s.lane("two");
  });
  it("exposes defaults and preserves flow policy across patches", async () => {
    const s = await setup();
    const first = await runWith(s.h, projectUpdate(s.dir, {}));
    expect(first.policy).toMatchObject({ wipLimit: 3, flowStallMin: 120, landWaitMin: 30 });
    await runWith(s.h, projectUpdate(s.dir, { policy: { wipLimit: 1, flowStallMin: 60 } }));
    const next = await runWith(s.h, projectUpdate(s.dir, { policy: { landWaitMin: 10 } }));
    expect(next.policy).toMatchObject({ wipLimit: 1, flowStallMin: 60, landWaitMin: 10 });
    expect((await failWith(s.h, projectUpdate(s.dir, { policy: { wipLimit: 1.5 } }))).message).toContain("integer");
  });
  it("includes deploy, proof and signals in a Brain-safe report", () => {
    const text = reportMarkdown({ name: "worker", lane: "one", cwd: "/repo", clone: null } as Parameters<typeof reportMarkdown>[0],
      { id: "abc", kind: "artifact", artifact: "/artifact", checks: [] }, "change", undefined,
      { deploy: "reload with flag off; rollback to prior commit", proof: "live request", signals: { working: "line appears", failing: "line missing", where: "board" } });
    expect(text).toContain("## Deploy"); expect(text).toContain("## Live proof"); expect(text).toContain("## Signals"); expect(text).toContain("line appears");
  });
});
