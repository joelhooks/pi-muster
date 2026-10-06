import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_CURSOR, ownerFeed } from "./owner-feed.ts";
import { appendOwnerItem } from "./owner-queue.ts";
import type { OwnerItem } from "./domain.ts";

const minute = 60_000;
const postedAt = Date.parse("2026-10-06T00:00:00Z");
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "idle-digest-"));
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const sendMessage = vi.fn<Parameters<typeof ownerFeed>[0]["sendMessage"]>();
  const create = () => ownerFeed({ home, session: "owner", sendMessage,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) });
  const feed = create();
  feed.restore([]);
  const post = (author: string, kind: OwnerItem["kind"] = "progress", title = author) =>
    appendOwnerItem("owner", { author, kind, title }, home);
  return { feed, create, entries, sendMessage, post };
};

describe("idle owner digest", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(postedAt); });
  afterEach(() => { vi.useRealTimers(); });

  it("wakes once for all three progress posts aged 16 minutes", () => {
    const f = fixture();
    const items = [f.post("one"), f.post("two"), f.post("three")];
    vi.setSystemTime(postedAt + 16 * minute);
    expect(f.feed.flush()).toBe(1);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    const [note, options] = f.sendMessage.mock.calls[0]!;
    expect(options).toEqual({ triggerTurn: true });
    for (const item of items) expect(note.content).toContain(item.uri);
    expect(note.details.items).toEqual(items);
    expect(f.entries.filter(e => e.customType === OWNER_CURSOR)).toHaveLength(1);
    expect(f.feed.inbox().items).toEqual([]);
    expect(f.feed.flush()).toBe(0);
    expect(f.feed.beforeTurn()).toBeUndefined();
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not wake at 14 minutes; wakes exactly at 15", () => {
    const f = fixture(); f.post("one");
    vi.setSystemTime(postedAt + 14 * minute);
    expect(f.feed.flush()).toBe(0);
    expect(f.sendMessage).not.toHaveBeenCalled();
    vi.setSystemTime(postedAt + 15 * minute);
    expect(f.feed.flush()).toBe(1);
  });

  it("never wakes while working, even past the threshold", () => {
    const f = fixture(); f.feed.turnStarted(); f.post("one");
    vi.setSystemTime(postedAt + 16 * minute);
    expect(f.feed.flush()).toBe(0);
    expect(f.sendMessage).not.toHaveBeenCalled();
    f.feed.turnEnded();
    expect(f.feed.flush()).toBe(1);
  });

  it("wakes mentions first and leaves quiet records for the next qualifying flush", () => {
    const f = fixture(); const quiet = [f.post("one"), f.post("two")];
    const mention = f.post("urgent", "question");
    expect(f.feed.flush()).toBe(1);
    expect(f.sendMessage.mock.calls[0]![0].content).toContain(mention.uri);
    for (const item of quiet) expect(f.sendMessage.mock.calls[0]![0].content).not.toContain(item.uri);
    expect(f.feed.flush()).toBe(0);
    vi.setSystemTime(postedAt + 16 * minute);
    expect(f.feed.flush()).toBe(1);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    for (const item of quiet) expect(f.sendMessage.mock.calls[1]![0].content).toContain(item.uri);
    expect(f.sendMessage.mock.calls[1]![0].content).not.toContain(mention.uri);
    expect(f.feed.flush()).toBe(0);
  });

  it("does not send a digest in the same flush as mentions, even when quiet posts are overdue", () => {
    const f = fixture(); const quiet = f.post("one");
    vi.setSystemTime(postedAt + 16 * minute);
    f.post("urgent", "blocked");
    expect(f.feed.flush()).toBe(1);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.sendMessage.mock.calls[0]![0].content).not.toContain(quiet.uri);
    expect(f.feed.flush()).toBe(1);
    expect(f.sendMessage.mock.calls[1]![0].content).toContain(quiet.uri);
    expect(f.feed.flush()).toBe(0);
  });

  it("persists delivery across a fresh feed restore and a subsequent turn", () => {
    const f = fixture(); f.post("one"); f.post("two", "done");
    vi.setSystemTime(postedAt + 16 * minute);
    expect(f.feed.flush()).toBe(1);
    f.feed.dispose();
    const restored = f.create(); restored.restore(f.entries);
    expect(restored.flush()).toBe(0);
    expect(restored.inbox().items).toEqual([]);
    expect(restored.beforeTurn()).toBeUndefined();
    restored.turnEnded();
    expect(restored.flush()).toBe(0);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    restored.dispose();
  });

  it("uses the oldest post time, not queue order, and batches newer quiet posts too", () => {
    const f = fixture();
    vi.setSystemTime(postedAt + 10 * minute); const newer = f.post("newer", "fyi");
    vi.setSystemTime(postedAt); const oldest = f.post("oldest", "done");
    vi.setSystemTime(postedAt + 16 * minute);
    expect(f.feed.flush()).toBe(1);
    expect(f.sendMessage.mock.calls[0]![0].details.items).toEqual([newer, oldest]);
  });

  it("uses the beforeTurn digest rendering while delivering every collapsed progress record", () => {
    const f = fixture(); const old = f.post("one", "progress", "old");
    const latest = f.post("one", "progress", "latest");
    vi.setSystemTime(postedAt + 16 * minute);
    expect(f.feed.flush()).toBe(1);
    const note = f.sendMessage.mock.calls[0]![0];
    expect(note.content).toContain(latest.uri);
    expect(note.content).not.toContain(old.uri);
    expect(note.details.items).toEqual([old, latest]);
    expect(f.feed.inbox().items).toEqual([]);
    expect(f.feed.beforeTurn()).toBeUndefined();
  });

  it("acknowledged old posts do not cause younger pending posts to wake early", () => {
    const f = fixture(); f.post("old", "done");
    f.feed.inbox({ ack: true });
    vi.setSystemTime(postedAt + 10 * minute); f.post("new");
    vi.setSystemTime(postedAt + 16 * minute);
    expect(f.feed.flush()).toBe(0);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});
