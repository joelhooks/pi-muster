import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { queuePath, readDesk } from "./desk.ts";
import type { DeskItem, Project } from "./domain.ts";
import { agentLaunch, projectOpen } from "./ops.ts";
import { deskAnswer, inboxText, loadInbox, loadSystem, registryPath } from "./switchboard-ops.ts";
import { SwitchboardState, handleKey, heatStrip, renderOverlay, renderRankedSummary as renderWidget } from "./switchboard-view.ts";
import { activity, answerPost, fleetStats, formatAge, inbox, latestPost, recentPosts, switchboardNeeds, switchboardTokens } from "./switchboard.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const item = (id: string, kind: DeskItem["kind"], hoursAgo: number, extra: Partial<DeskItem> = {}): DeskItem => ({ id, ts: at(hoursAgo), from: "💬 desk", kind, title: `title ${id}`, ...extra });
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const queues = {
  drovr: [item("d1", "decision", 30), item("d2", "blocked", 2), item("d3", "fyi", 1), item("d4", "approval", 5), item("d5", "done", 0, { resolves: "d4" })],
  support: [item("s1", "decision", 50), item("s2", "decision", 1)],
  quiet: [item("q1", "done", 1)],
};

describe("inbox", () => {
  it("keeps only open asks, ranks blocked over approvals over decisions, oldest first", () => {
    const groups = inbox(queues, NOW);
    expect(groups.map((group) => group.project)).toEqual(["drovr", "support"]);
    expect(groups[0]?.items.map((entry) => entry.id)).toEqual(["d2", "d1"]);
    expect(groups[0]?.counts).toEqual({ blocked: 1, approval: 0, decision: 1 });
    expect(groups[1]?.items.map((entry) => entry.id)).toEqual(["s1", "s2"]);
    expect(switchboardNeeds(groups)).toBe("🙋 4 · 2 projects");
    expect(switchboardNeeds([])).toBeNull();
    expect(formatAge(30 * 3_600_000)).toBe("1d");
    expect(inboxText(groups)).toContain("[drovr#d2]");
  });

  it("answers with a short title and keeps a long answer in the body", () => {
    expect(answerPost("ship it", { id: "d2" })).toMatchObject({ kind: "done", title: "ship it", resolves: "d2" });
    const long = answerPost("x ".repeat(60), { id: "d2" }, "fyi");
    expect([...long.title].length).toBeLessThanOrEqual(80);
    expect(long.body).toBeTruthy();
    expect(() => answerPost("   ", { id: "d2" })).toThrow();
  });
});

describe("switchboard view", () => {
  const state = () => {
    const s = new SwitchboardState();
    s.setSystem({ groups: inbox(queues, NOW), posts: recentPosts(queues, NOW), fleet: null, latest: latestPost(queues), now: NOW });
    return s;
  };

  it("opens new projects, folds and unfolds, and keeps the cursor on its item across refreshes", () => {
    const s = state();
    expect(s.rows().map((row) => (row.type === "group" ? row.group.project : row.type === "item" ? row.item.id : row.space.spaceId))).toEqual(["drovr", "d2", "d1", "support", "s1", "s2"]);
    s.move(2);
    expect(s.current()).toMatchObject({ type: "item", item: { id: "d1" } });
    s.setGroups(inbox({ ...queues, drovr: [...queues.drovr, item("d6", "blocked", 9)] }, NOW));
    expect(s.current()).toMatchObject({ type: "item", item: { id: "d1" } });
    s.toggle(false);
    expect(s.current()).toMatchObject({ type: "group", group: { project: "drovr" } });
    expect(s.rows()).toHaveLength(4);
    s.toggleAll();
    expect(s.rows()).toHaveLength(7);
    s.toggleAll();
    expect(s.rows()).toHaveLength(2);
  });

  it("maps keys to moves and intents", () => {
    const s = state();
    expect(handleKey(s, "\x1b[B")).toBeNull();
    expect(s.cursor).toBe(1);
    expect(handleKey(s, "\r")).toMatchObject({ type: "desk", project: "drovr", item: { id: "d2" } });
    expect(handleKey(s, "e")).toMatchObject({ type: "discuss", item: { id: "d2" } });
    expect(handleKey(s, "a")).toMatchObject({ type: "answer", item: { id: "d2" } });
    expect(handleKey(s, "d")).toMatchObject({ type: "done", item: { id: "d2" } });
    expect(handleKey(s, " ")).toBeNull();
    expect(s.current()).toMatchObject({ type: "group" });
    expect(handleKey(s, "\x1b")).toEqual({ type: "close" });
  });

  it("shows the cursor as ▶ on project rows too, and follows a real key sequence", () => {
    const s = state();
    expect(renderOverlay(s, 80, 20, plain).find((line) => line.includes("▶ ▾ drovr"))).toBeDefined();
    handleKey(s, " ");
    expect(s.expanded.has("drovr")).toBe(false);
    expect(s.expanded.has("support")).toBe(true);
    handleKey(s, "j");
    expect(s.current()).toMatchObject({ type: "group", group: { project: "support" } });
    handleKey(s, "k");
    expect(s.current()).toMatchObject({ type: "group", group: { project: "drovr" } });
    expect(s.expanded.has("drovr")).toBe(false);
    expect(s.expanded.has("support")).toBe(true);
  });

  it("never draws past the width and shows ranked action references", () => {
    const s = state();
    for (const width of [40, 80, 140]) {
      for (const line of renderWidget(s, width, plain)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      for (const line of renderOverlay(s, width, 20, plain)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const widget = renderWidget(s, 80, plain);
    expect(widget).toHaveLength(5);
    expect(widget[0]).toContain("4 open ⛔1 ❓3 · oldest 2d");
    expect(widget[1]).toContain("drovr#");
    expect(widget[1]).toMatch(/^⛔/);
    expect(widget.slice(2).join("\n")).toContain("support#");
    expect(renderWidget(new SwitchboardState(), 80, plain)).toEqual([expect.stringContaining("inbox clear")]);

    s.fleet = { projects: 2, lanes: 14, lanesClosed: 12, running: 9, toLand: 0 };
    expect(renderWidget(s, 100, plain)[0]).toContain("· oldest 2d │ 🐑 2 projects · 12/14 lanes · 9 running");
    const narrow = renderWidget(s, 70, plain)[0] ?? "";
    expect(narrow).toContain("│ 🐑 2 projects");
    expect(narrow).not.toContain("oldest");
    expect(renderWidget(s, 30, plain)[0]).toBe("4 open · /switchboard");
    expect(renderWidget(s, 30, plain)[1]).toBe("2 open drovr 1d");
  });

  it("buckets posts into a heat strip, newest hour on the right", () => {
    const times = [at(0.5), at(0.2), at(3), at(23.5), at(30)].map((ts) => Date.parse(ts));
    const counts = activity(times, NOW, 24);
    expect(counts).toHaveLength(24);
    expect(counts[23]).toBe(2);
    expect(counts[20]).toBe(1);
    expect(counts[0]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
    expect(heatStrip([0, 1, 2, 4], 4, plain)).toBe("·░▒█");
    expect(recentPosts(queues, NOW).support).toHaveLength(1);
  });

  it("puts the newest desk line and the fleet in the sidebar, and they move with time", () => {
    const view = { groups: inbox(queues, NOW), fleet: { projects: 3, lanes: 15, lanesClosed: 14, running: 5, toLand: 1 }, latest: latestPost(queues), now: NOW };
    expect(view.latest).toMatchObject({ project: "drovr", kind: "done" });
    const tokens = switchboardTokens(view);
    expect(tokens).toEqual({ progress: "☎️ switchboard", now: "🏁 now drovr: title d5", agents: "🐑 3p · 5 run · 1 to land", needs: "🙋 4 · 2 projects" });
    expect(switchboardTokens({ ...view, now: NOW + 3 * 3_600_000 }).now).toBe("🏁 3h drovr: title d5");
    expect([...(switchboardTokens({ ...view, latest: { ...view.latest!, title: "x".repeat(80) } }).now ?? "")].length).toBe(32);
    expect(switchboardTokens({ groups: [], fleet: null, latest: null, now: NOW })).toEqual({ progress: "☎️ switchboard", now: null, agents: null, needs: null });
  });

  it("sums the fleet from live projects only", () => {
    const lane = (state: string, extra = {}) => ({ kind: "work", state, archived: false, ...extra });
    const project = (state: string, lanes: object[], agents: string[], packets: string[]) =>
      ({ state, lanes, agents: agents.map((s) => ({ state: s })), packets: packets.map((s) => ({ state: s })) }) as unknown as Project;
    const stats = fleetStats([
      project("active", [lane("open"), lane("closed"), lane("open", { archived: true })], ["running", "closed", "silent"], ["reported", "committed"]),
      project("archived", [lane("open")], ["running"], ["reported"]),
    ]);
    expect(stats).toEqual({ projects: 1, lanes: 2, lanesClosed: 1, running: 1, toLand: 1 });
  });
});

describe("desk_answer", () => {
  it("resolves the item in its own queue and nudges the project's Muster desk", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await runWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n", space: "w1", sidebar: true, ephemeral: true, desk: true, musterExtension: "/m", deskExtension: null }));
    await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "💬 desk", cwd: dir }));
    mkdirSync(join(h.home, ".local", "state", "muster"), { recursive: true });
    writeFileSync(registryPath(h.home), `${JSON.stringify({ slug: "probe", dir, spaceId: "w1", ts: at(1) })}\n`);
    mkdirSync(join(h.home, ".local", "state", "herdr-desk"), { recursive: true });
    writeFileSync(queuePath("probe", h.home), `${JSON.stringify(item("p1", "decision", 3))}\n`);

    const view = await runWith(h, loadSystem);
    expect(view.groups.map((group) => group.project)).toEqual(["probe"]);
    expect(view.fleet).toMatchObject({ projects: 1, running: 1 });

    expect((await runWith(h, loadInbox)).map((group) => group.project)).toEqual(["probe"]);
    const answered = await runWith(h, deskAnswer({ project: "probe", id: "p1", answer: "go with option B" }));
    expect(answered.remaining).toBe(0);
    expect(answered.nudged).toHaveLength(1);
    expect(h.sent.at(-1)?.message).toContain("go with option B");
    expect(readDesk(queuePath("probe", h.home)).at(-1)).toMatchObject({ kind: "done", resolves: "p1", from: "☎️ switchboard" });
    expect(await runWith(h, loadInbox)).toMatchObject([{ project: "probe", items: [] }]);
    expect((await failWith(h, deskAnswer({ project: "probe", id: "p1", answer: "again" })))._tag).toBe("NotFound");
  });
});
