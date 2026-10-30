import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { canonicalJson, deliverOwnerItem, mentions, ownerItem, resolveOwner } from "./owner-queue.ts";

const home = () => mkdtempSync(join(tmpdir(), "owner-queue-"));

// Slice 5 retired the JSONL owner queue: a post is built, sent once over Rat King, and never written locally.
describe("owner posts", () => {
  it("catalog resolution falls back visibly when unavailable", () => {
    expect(resolveOwner({ owner: "old", project: "/missing", agent: "probe", home: home() })).toMatchObject({ owner: "old", resolution: expect.stringContaining("fallback") });
  });

  it("hashes canonical JSON, threads a reply by its parent's uri, and wakes on mention not kind", () => {
    const question = ownerItem("owner", { author: "probe", lane: "lane", kind: "question", title: "question" });
    expect(question.$type).toBe("dev.muster.note.post");
    expect(question.uri).toMatch(/^muster:\/\/probe\/dev.muster.note.post\/[a-f0-9]+$/);
    expect(question.cid).toMatch(/^[a-f0-9]{32}$/);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(mentions(question, "owner")).toBe(true);
    const reply = ownerItem("probe", { author: "owner", kind: "fyi", title: "answer", mention: "probe", replyTo: question.uri });
    expect(reply.reply).toEqual({ root: { uri: question.uri, cid: "" }, parent: { uri: question.uri, cid: "" } });
    expect(mentions(reply, "probe")).toBe(true);
    expect(mentions(reply, "owner")).toBe(false);
    expect(mentions(ownerItem("owner", { author: "probe", kind: "progress", title: "quiet" }), "owner")).toBe(false);
  });

  it("caps title characters and body UTF-8 bytes; rejects traversal session ids", () => {
    const item = ownerItem("owner", { author: "p", lane: "l", kind: "fyi", title: "t".repeat(201), body: "🐀".repeat(2000) });
    expect(item.text.split("\n")[0]).toHaveLength(200);
    expect(Buffer.byteLength(item.text.split("\n")[1]!)).toBeLessThanOrEqual(4096);
    expect(() => ownerItem("../bad", { author: "p", kind: "fyi", title: "t" })).toThrow();
  });

  it.each(["action", "question", "blocked", "progress"] as const)("%s goes over Rat King once", async kind => {
    const calls: string[] = [];
    const result = await Effect.runPromise(deliverOwnerItem({ owner: "owner", home: home(), session: "worker", project: "p", item: { author: "probe", lane: "l", kind, title: "title" },
      comms: { postOwner: (_to: string, item: { text: string }) => { calls.push(item.text); return Effect.succeed({ status: "delivered" as const, detail: "ratking → owner" }); } } as never,
      send: () => Effect.succeed({ status: "failed" as const, detail: "unused" }) }));
    expect(result).toMatchObject({ path: "ratking", queued: true, lost: false });
    expect(calls).toHaveLength(1);
  });

  it("a send that fails is lost and says so, with no local fallback", async () => {
    const root = home();
    const send = () => { throw new Error("must not wake"); };
    expect(await Effect.runPromise(deliverOwnerItem({ owner: "owner", home: root, session: "probe", project: "p", item: { author: "probe", kind: "progress", title: "silent" }, send })))
      .toMatchObject({ queued: false, lost: true, delivery: { detail: "pi-ratking not loaded" } });
    expect(() => mkdtempSync(join(root, ".local/state/muster/owner-queue/x"))).toThrow();
  });
});
