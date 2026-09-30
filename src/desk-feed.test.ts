import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { queuePath } from "./desk.ts";
import { deskProjectFor, registerDeskFeed } from "./desk-feed-ext.ts";
import { CURSOR_ENTRY, FEED_CLAIM, NOTE, deskFeed, inboxSummary, summaryText } from "./desk-feed.ts";
import type { NoteMessage } from "./desk-feed.ts";
import { registryPath } from "./registry.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
let n = 0;
const post = (path: string, item: Record<string, unknown>) =>
  appendFileSync(path, `${JSON.stringify({ id: `i${(n += 1)}`, ts: new Date(NOW - 3_600_000).toISOString(), from: "🦅 hawk", ...item })}\n`);

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-feed-"));
  mkdirSync(join(dir, ".local", "state", "herdr-desk"), { recursive: true });
  return dir;
};

afterEach(() => {
  delete (globalThis as { [FEED_CLAIM]?: string })[FEED_CLAIM];
});

describe("desk feed", () => {
  it("cards each new line when idle, holds them mid-turn, and never replays history", () => {
    const path = queuePath("space", home());
    const sent: NoteMessage[] = [];
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    const feed = deskFeed({ project: "space", path, now: () => NOW, sendMessage: (m) => sent.push(m), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) });
    post(path, { kind: "fyi", title: "old news" });
    feed.restore([]);
    expect(feed.flush()).toBe(0);

    post(path, { kind: "approval", title: "mint a key?" });
    expect(feed.flush()).toBe(1);
    expect(sent[0]).toMatchObject({ customType: NOTE, display: true, details: { project: "space", inbox: { open: 1, approval: 1 } } });
    expect(sent[0]?.content).toContain("not said by Joel");
    expect(sent[0]?.content).toContain("not the desk's own words");
    expect(sent[0]?.content).toContain("No reply is needed.");
    expect(sent[0]?.content).toContain("Desk-queue notice from 🦅 hawk: [approval] mint a key?");
    expect(sent[0]?.content).toContain("Desk inbox now: 1 open · ✅1 · oldest 1h.");

    feed.turnStarted();
    post(path, { kind: "done", title: "minted", resolves: "i2" });
    expect(feed.flush()).toBe(0);
    expect(feed.turnEnded()).toBe(1);
    expect(sent.at(-1)?.details.inbox.open).toBe(0);

    post(path, { kind: "decision", title: "raced the watcher" });
    expect(feed.beforeTurn()?.message.content).toContain("raced the watcher");
    expect(entries.at(-1)).toMatchObject({ customType: CURSOR_ENTRY, data: { cursor: 4 } });

    const resumed = deskFeed({ project: "space", path, sendMessage: () => expect.fail("no replay"), appendEntry: () => {} });
    resumed.restore(entries);
    expect(resumed.flush()).toBe(0);
  });

  it("flushes at agent_end without triggering a turn while Pi still counts as streaming", () => {
    const dir = home();
    const path = queuePath("space", dir);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const sent: Array<{ message: NoteMessage; options: unknown; streaming: boolean }> = [];
    let streaming = false;
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
      registerMessageRenderer: () => {},
      sendMessage: (message: NoteMessage, options: unknown) => sent.push({ message, options, streaming }),
      appendEntry: () => {},
    };
    registerDeskFeed(pi as never, { HOME: dir, HERDR_DESK_PROJECT: "space" });
    const ctx = { sessionManager: { getSessionId: () => "s", getBranch: () => [] } };
    handlers.get("session_start")?.({}, ctx);
    try {
      streaming = true;
      handlers.get("agent_start")?.({}, ctx);
      post(path, { from: "owner", kind: "done", title: "finished the packet" });
      expect(sent).toEqual([]);
      handlers.get("agent_end")?.({}, ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ streaming: true, options: { triggerTurn: false } });
      expect(sent[0]?.message.content).toContain("Desk-queue notice from owner: [done] finished the packet");
      expect(sent[0]?.message.content).toContain("No reply is needed.");
      streaming = false;
      expect(handlers.get("before_agent_start")?.({}, ctx)).toBeUndefined();
    } finally {
      handlers.get("session_shutdown")?.({}, ctx);
    }
  });

  it("summarises the inbox by kind", () => {
    expect(summaryText(inboxSummary([], NOW))).toBe("inbox clear");
  });

  it("finds a hand-resumed desk by its session id in the registered projects", () => {
    const dir = home();
    const project = join(dir, "repo");
    mkdirSync(join(project, ".brain", "data", "muster"), { recursive: true });
    writeFileSync(
      join(project, ".brain", "data", "muster", "project.json"),
      JSON.stringify({ slug: "drovr", agents: [{ role: "desk", sessionId: "desk-1", state: "running" }, { role: "hawk", sessionId: "hawk-1", state: "running" }] }),
    );
    mkdirSync(join(dir, ".local", "state", "muster"), { recursive: true });
    writeFileSync(registryPath(dir), `${JSON.stringify({ slug: "drovr", dir: project, spaceId: "w1", ts: "x" })}\n`);
    expect(deskProjectFor("desk-1", {}, dir)).toBe("drovr");
    expect(deskProjectFor("hawk-1", {}, dir)).toBeNull();
    expect(deskProjectFor("anything", { HERDR_DESK_PROJECT: "named" }, dir)).toBe("named");
  });

  it("delivers a backlog on start, and stands down when another feed in the process claimed first", async () => {
    const dir = home();
    const path = queuePath("space", dir);
    post(path, { kind: "fyi", title: "before the cursor" });
    post(path, { kind: "blocked", title: "posted while the desk was down" });
    const run = (claimedBy?: string) => {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const sent: NoteMessage[] = [];
      const pi = {
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
        registerMessageRenderer: () => {},
        sendMessage: (message: NoteMessage) => sent.push(message),
        appendEntry: () => {},
      };
      if (claimedBy) (globalThis as { [FEED_CLAIM]?: string })[FEED_CLAIM] = claimedBy;
      registerDeskFeed(pi as never, { HOME: dir, HERDR_DESK_PROJECT: "space" });
      const ctx = { sessionManager: { getSessionId: () => "s", getBranch: () => [{ type: "custom", customType: CURSOR_ENTRY, data: { cursor: 1 } }] } };
      handlers.get("session_start")?.({}, ctx);
      return { sent, handlers };
    };
    const live = run();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(live.sent.map((m) => m.details.items[0]?.title)).toEqual(["posted while the desk was down"]);
    live.handlers.get("session_shutdown")?.({}, {});

    const second = run("dark-wizard");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(second.sent).toEqual([]);
    second.handlers.get("session_shutdown")?.({}, {});
  });
});
