import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownerFeed } from "./owner-feed.ts";
import { appendOwnerItem } from "./owner-queue.ts";
import type { OwnerTimelineData } from "./owner-view.ts";

vi.mock("node:fs", { spy: true });
afterEach(() => vi.clearAllMocks());
describe("owner poll delivery", () => {
  it("reads reply history asynchronously and preserves the parent without any sync file read", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-poll-"));
    const parent = appendOwnerItem("writer", { author: "reader", kind: "fyi", title: "Parent in author's queue" }, home);
    appendOwnerItem("reader", { author: "writer", kind: "question", title: "Reply", replyTo: parent.uri }, home);
    const sent: OwnerTimelineData[] = [];
    const feed = ownerFeed({ home, session: "reader", appendEntry() {}, sendMessage: note => sent.push(note.details) });
    vi.mocked(readFileSync).mockClear();
    try {
      expect(await feed.poll(() => true)).toBe(1);
      expect(readFileSync).not.toHaveBeenCalled();
      expect(sent[0]!.parents).toEqual([parent]);
      expect(await feed.poll(() => true)).toBe(0);
      expect(readFileSync).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
    } finally { feed.dispose(); }
  });
  it("does not deliver when the session is retired or becomes busy during an async read", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-poll-cancel-"));
    appendOwnerItem("reader", { author: "writer", kind: "question", title: "Pending" }, home);
    const sent = vi.fn();
    const feed = ownerFeed({ home, session: "reader", appendEntry() {}, sendMessage: sent });
    try {
      let active = true;
      const retired = feed.poll(() => true, () => active);
      active = false;
      expect(await retired).toBe(0);
      let idle = true;
      const busy = feed.poll(() => idle);
      idle = false;
      expect(await busy).toBe(0);
      expect(sent).not.toHaveBeenCalled();
      expect(await feed.poll(() => true)).toBe(1);
    } finally { feed.dispose(); }
  });
});
