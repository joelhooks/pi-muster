import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { deskFeed, CURSOR_ENTRY } from "./desk-feed.ts";
import { deskWriteId, relayEvent, selfPosts, SELF_ENTRY, watchFallback, withDeskWrites } from "./relay-events.ts";

const home = () => mkdtempSync(join(tmpdir(), "relay-events-"));
const logs = (dir: string) => readFileSync(join(dir, ".local/state/muster/relay-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const item = (id: string) => ({ id, ts: new Date().toISOString(), from: "same sender label", kind: "fyi", title: "notice", body: "private body" });

describe("relay diet", () => {
  it("projects metadata only and survives a failed write", () => {
    const dir = home();
    const event = { ts: "now", session: "s", kind: "packet_report" as const, project: "p", packetId: "hash", body: "private body", title: "private title", refs: ["private ref"] };
    relayEvent(event, dir);
    expect(logs(dir)).toEqual([{ ts: "now", session: "s", kind: "packet_report", project: "p", packetId: "hash" }]);
    writeFileSync(join(dir, "not-a-directory"), "x");
    expect(() => relayEvent(event, join(dir, "not-a-directory"))).not.toThrow();
  });

  it.each(["flush", "beforeTurn"] as const)("skips this session's posts in %s but delivers foreign posts with the same label", (mode) => {
    const dir = home();
    const path = join(dir, "queue");
    const session = randomUUID();
    const sent: unknown[] = [];
    const feed = deskFeed({ project: "p", session, home: dir, path, appendEntry: () => {}, sendMessage: (message) => sent.push(message) });
    feed.restore([]);
    selfPosts(session).record("own", () => {});
    appendFileSync(path, [item("own"), item("foreign")].map((record) => JSON.stringify(record)).join("\n") + "\n");
    if (mode === "flush") {
      expect(feed.flush()).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ details: { items: [{ id: "foreign" }] } });
    } else {
      expect(feed.beforeTurn()?.message.details.items.map((record) => record.id)).toEqual(["foreign"]);
      expect(feed.turnEnded()).toBe(0);
    }
    expect(logs(dir).map((record) => [record.kind, record.itemId])).toEqual([["desk_note_skipped_self", "own"], ["desk_note", "foreign"]]);
    expect(JSON.stringify(logs(dir))).not.toContain("private body");
    expect(feed.flush()).toBe(0);
  });

  it("restores self ids from custom entries after module reload and isolates a new session", async () => {
    const dir = home();
    const path = join(dir, "queue");
    const session = randomUUID();
    const entries: Array<{ type: string; customType: string; data: unknown }> = [{ type: "custom", customType: CURSOR_ENTRY, data: { cursor: 0 } }];
    selfPosts(session).record("own-reload", (customType, data) => entries.push({ type: "custom", customType, data }));
    expect(entries[1]).toMatchObject({ customType: SELF_ENTRY, data: { session, id: "own-reload" } });
    appendFileSync(path, JSON.stringify(item("own-reload")) + "\n");
    vi.resetModules();
    const { deskFeed: reloaded } = await import("./desk-feed.ts");
    const feed = reloaded({ project: "p", session, home: dir, path, appendEntry: () => {}, sendMessage: () => expect.fail("self echo") });
    feed.restore(entries);
    expect(feed.flush()).toBe(0);
    const fresh = reloaded({ project: "p", session: randomUUID(), home: dir, path, appendEntry: () => {}, sendMessage: () => {} });
    fresh.restore(entries);
    expect(fresh.flush()).toBe(1);
  });

  it.each(["desk_post", "desk_answer", "desk_rulings"])("%s reserves and persists the actual queue id before awaited writes, even on a later failure", async (name) => {
    const session = randomUUID();
    const entries: Array<{ type: string; data: unknown }> = [];
    const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
    // Minimal host stub: the facade uses only these two methods in this test.
    const pi = withDeskWrites({ registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => { tools.set(tool.name, tool); }, appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); } } as never);
    pi.registerTool({ name, parameters: {} as never, label: "test", description: "test", async execute() {
      await Promise.resolve();
      const id = deskWriteId("12345678-long-id").slice(0, 8);
      expect(selfPosts(session).has(id)).toBe(true);
      throw new Error("nudge failed after write");
    } });
    await expect(tools.get(name)?.execute("call", {}, undefined, undefined, { sessionManager: { getSessionId: () => session, getBranch: () => [] } } as never)).rejects.toThrow("nudge failed");
    expect(entries).toEqual([{ type: SELF_ENTRY, data: { session, id: "12345678" } }]);
    // An unrelated operation outside the async desk scope must not reserve a self id.
    deskWriteId("foreign-id");
    expect(selfPosts(session).has("foreign-" )).toBe(false);
  });

  it("names running pane-targeted watch ids from receipts but never claims retirement", () => {
    const entry = (id: string, status: string, target: string, customType = "bellwether-herdr-watch-started") => ({ type: "custom", customType, data: { id, status, target } });
    const fallback = watchFallback(["pane-1"], [entry("own", "running", "pane-1"), entry("finished", "running", "pane-1"), entry("finished", "cancelled", "pane-1", "bellwether-herdr-watch-finished"), entry("foreign", "running", "pane-2")]);
    expect(fallback).toContain("watch ids to cancel from session receipts: own");
    expect(fallback).not.toContain("finished");
    expect(fallback).not.toContain("foreign");
    expect(watchFallback(["pane-1"], [])).toContain("no pane-targeted watch ids discoverable");
  });

  it("a telemetry write failure does not prevent a foreign card", () => {
    const dir = home();
    const path = join(dir, "queue");
    mkdirSync(join(dir, ".local/state/muster/relay-events.jsonl"), { recursive: true });
    const sent: unknown[] = [];
    const feed = deskFeed({ project: "p", session: randomUUID(), home: dir, path, appendEntry: () => {}, sendMessage: (message) => sent.push(message) });
    feed.restore([]);
    appendFileSync(path, JSON.stringify(item("foreign")) + "\n");
    expect(feed.flush()).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
