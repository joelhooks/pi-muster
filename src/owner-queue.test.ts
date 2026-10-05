import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ownerFeed, ownerTimeline, OWNER_CURSOR } from "./owner-feed.ts";
import { appendOwnerItem, ownerPath, deliverOwnerItem, readerFresh, writeReader, mentions, readOwnerQueue, canonicalJson, forwardOwner, resolveOwner } from "./owner-queue.ts";
import { OwnerTimelineView, ownerInboxText, readOwnerTimelineData } from "./owner-view.ts";
import type { OwnerItem } from "./domain.ts";

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "owner-queue-"));
  const entries: Array<{type: string; customType: string; data: unknown}> = [];
  const sent: unknown[] = [];
  const feed = ownerFeed({ home, session: "owner", appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), sendMessage: (m, opts) => sent.push({ m, opts }) });
  feed.restore([]);
  return { home, entries, sent, feed, post: (kind: OwnerItem["kind"], title: string = kind) => appendOwnerItem("owner", { author: "probe", lane: "lane", kind, title }, home) };
};
describe("owner queue", () => {
  it("forwards project-tagged direct appends and unread history once across reload", () => {
    const f = fixture();
    const old = appendOwnerItem("old", { author: "probe", project: "p", kind: "question", title: "history" }, f.home);
    forwardOwner({ from: "old", to: "owner", project: "p", home: f.home });
    // Bypass the forwarding-aware writer, retaining the post's project.
    const late = appendOwnerItem("scratch", { author: "probe", project: "p", kind: "question", title: "late", mention: "old" }, f.home);
    writeFileSync(ownerPath("old", f.home), JSON.stringify(old) + "\n" + JSON.stringify(late) + "\n");
    const inbox = f.feed.inbox();
    expect(inbox.via).toEqual({ [old.uri]: "old", [late.uri]: "old" });
    expect(ownerInboxText(inbox, inbox.cursor)).toContain("via old");
    const data = readOwnerTimelineData(inbox)!;
    const view = new OwnerTimelineView(data, { expanded: true, noColor: true }, { fg: (_color, text) => text, bold: text => text });
    expect(view.render(120).join("\n")).toContain("via old");
    expect(view.render(120).join("\n")).toContain("2 mentions");
    expect(f.feed.flush()).toBe(2);
    f.feed.restore(f.entries);
    expect(f.feed.flush()).toBe(0);
    expect(f.feed.beforeTurn()).toBeUndefined();
    f.feed.restore(f.entries);
    expect(f.feed.inbox().items).toHaveLength(0);
  });
  it("filters pre-forward history by the old reader heartbeat, not future appends", () => {
    const f = fixture();
    appendOwnerItem("old", { author: "probe", project: "p", kind: "fyi", title: "consumed" }, f.home);
    writeReader("old", f.home, Date.now() + 1000);
    forwardOwner({ from: "old", to: "owner", project: "p", home: f.home });
    const late = appendOwnerItem("scratch", { author: "probe", project: "p", kind: "fyi", title: "late" }, f.home);
    const path = ownerPath("old", f.home);
    writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(late) + "\n");
    expect(f.feed.inbox().items.map(i => i.uri)).toEqual([late.uri]);
  });
  it("new senders rewrite mentions and wake the final owner; cycles and depth overflow fail closed", async () => {
    const f = fixture();
    forwardOwner({ from: "old", to: "owner", project: "p", home: f.home });
    const calls: string[] = [];
    const result = await Effect.runPromise(deliverOwnerItem({ owner: "old", home: f.home, session: "probe", project: "p", item: { author: "probe", kind: "question", title: "wake", mention: "old" }, send: to => { calls.push(to); return Effect.succeed({ status: "delivered" as const }); } }));
    expect(calls).toEqual(["owner"]); expect(result.woke).toBe(true);
    expect(mentions(readOwnerQueue("owner", f.home).items[0]!.item, "owner")).toBe(true);
    expect(() => forwardOwner({ from: "owner", to: "old", project: "p", home: f.home })).toThrow(/cycle/);
    for (let n = 3; n >= 0; n--) forwardOwner({ from: "a" + n, to: n === 3 ? "owner" : "a" + (n + 1), project: "p", home: f.home });
    expect(() => forwardOwner({ from: "extra", to: "a0", project: "p", home: f.home })).toThrow(/depth/);
  });
  it("catalog resolution falls back visibly when unavailable", () => {
    const f = fixture();
    expect(resolveOwner({ owner: "old", project: "/missing", agent: "probe", home: f.home })).toMatchObject({ owner: "old", resolution: expect.stringContaining("fallback") });
  });
  it("lexicon posts hash canonical JSON, thread root/parent, and wake on mention not kind", async () => {
    const f = fixture(); const question = f.post("question");
    expect(question.$type).toBe("dev.muster.note.post"); expect(question.uri).toMatch(/^muster:\/\/probe\/dev.muster.note.post\/[a-f0-9]+$/);
    expect(question.cid).toMatch(/^[a-f0-9]{32}$/);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const reply = appendOwnerItem("probe", { author: "owner", kind: "fyi", title: "answer", mention: "probe", replyTo: question.uri }, f.home);
    expect(reply.reply).toEqual({ root: { uri: question.uri, cid: question.cid }, parent: { uri: question.uri, cid: question.cid } });
    expect(mentions(reply, "probe")).toBe(true); expect(mentions(reply, "owner")).toBe(false);
    const followup = appendOwnerItem("owner", { author: "probe", kind: "question", title: "followup", replyTo: reply.uri }, f.home);
    expect(followup.reply?.root.uri).toBe(question.uri); expect(followup.reply?.parent.uri).toBe(reply.uri);
    const workerSent: unknown[] = [];
    const worker = ownerFeed({ home: f.home, session: "probe", appendEntry: () => {}, sendMessage: m => workerSent.push(m) }); worker.restore([]);
    expect(worker.flush()).toBe(1); expect(workerSent).toHaveLength(1);
    const unmentioned = { ...question, facets: [] };
    expect(mentions(unmentioned, "owner")).toBe(false);
    expect(ownerTimeline([unmentioned, reply], "probe")[0]).toEqual(reply);
    expect(readOwnerQueue("probe", f.home).items[0]?.item).toEqual(reply);
  });
  it("silent kinds never wake; next turn gets one grouped digest with latest progress", () => {
    const f = fixture();
    f.post("progress", "old"); f.post("progress", "latest"); f.post("done"); f.post("fyi");
    expect(f.feed.flush()).toBe(0); expect(f.sent).toEqual([]);
    const digest = f.feed.beforeTurn();
    expect(digest?.message.content).toContain("latest"); expect(digest?.message.content).not.toContain("old");
    expect(digest?.message.content).toContain("done"); expect(digest?.message.content).toContain("fyi");
    expect(f.feed.beforeTurn()).toBeUndefined();
  });
  it.each(["question", "blocked", "action"] as const)("%s wakes idle, rides along busy and is not replayed on restore", kind => {
    const f = fixture(); f.post(kind); expect(f.feed.flush()).toBe(1);
    expect(f.sent).toMatchObject([{ opts: { triggerTurn: true } }]);
    f.feed.restore(f.entries); expect(f.feed.flush()).toBe(0);
    f.feed.turnStarted(); f.post(kind); expect(f.feed.flush()).toBe(0);
    expect(f.feed.beforeTurn()?.message.content).toContain(kind);
    f.feed.turnEnded(); expect(f.sent).toHaveLength(1);
    expect(f.entries.some(e => e.customType === OWNER_CURSOR)).toBe(true);
  });
  it("filtered inbox ack consumes only returned items, without dropping other kinds", () => {
    const f = fixture(); const a = f.post("fyi"); f.post("question"); const b = f.post("done");
    expect(f.feed.inbox({ kinds: ["fyi", "done"], limit: 1, ack: true }).items.map(i => i.uri)).toEqual([a.uri]);
    expect(f.feed.inbox({ kinds: ["done"] }).items.map(i => i.uri)).toEqual([b.uri]);
    expect(f.feed.inbox({ since: a.createdAt, kinds: ["fyi"] }).items).toHaveLength(1);
    expect(f.feed.beforeTurn()?.message.content).not.toContain(a.uri);
  });
  it("caps title characters and body UTF-8 bytes; rejects traversal session ids", () => {
    const f = fixture(); const item = appendOwnerItem("owner", { author: "p", lane: "l", kind: "fyi", title: "t".repeat(201), body: "🐀".repeat(2000) }, f.home);
    expect(item.text.split("\n")[0]).toHaveLength(200); expect(Buffer.byteLength(item.text.split("\n")[1]!)).toBeLessThanOrEqual(4096);
    expect(() => ownerPath("../bad", f.home)).toThrow();
  });
  it.each(["action", "question", "blocked"] as const)("%s skips intercom for fresh reader, falls back for missing, stale, dead or failed queue", async kind => {
    for (const mode of ["fresh", "missing", "stale", "dead", "queue-failure", "event-failure"]) {
      const f = fixture(); const calls: string[] = [];
      if (mode !== "missing") writeReader("owner", f.home, mode === "stale" ? Date.now() - 121000 : Date.now(), mode === "dead" ? 2147483647 : process.pid);
      if (mode === "queue-failure") mkdirSync(ownerPath("owner", f.home), { recursive: true });
      if (mode === "event-failure") mkdirSync(join(f.home, ".local/state/muster/relay-events.jsonl"));
      const result = await Effect.runPromise(deliverOwnerItem({ owner: "owner", home: f.home, session: "worker", project: "p", item: { author: "probe", lane: "l", kind, title: "private title", body: "private body" }, send: (_to, message) => { calls.push(message); return Effect.succeed({ status: "delivered" as const }); } }));
      expect(result.path).toBe(mode === "fresh" ? "queue" : "intercom");
      expect(calls).toHaveLength(mode === "fresh" ? 0 : 1);
      if (mode !== "queue-failure") expect(readFileSync(ownerPath("owner", f.home), "utf8")).toContain(kind);
      if (mode !== "event-failure") {
        const log = readFileSync(join(f.home, ".local/state/muster/relay-events.jsonl"), "utf8");
        expect(log).not.toContain("private"); expect(JSON.parse(log).noteKind).toBe(kind);
      }
    }
  });
  it("a failed silent append reports failure without an intercom wake", async () => {
    const f = fixture(); mkdirSync(ownerPath("owner", f.home), { recursive: true }); const send = () => { throw new Error("must not wake"); };
    await expect(Effect.runPromise(deliverOwnerItem({ owner: "owner", home: f.home, session: "probe", project: "p", item: { author: "probe", kind: "progress", title: "silent" }, send }))).rejects.toThrow("silent owner note not queued");
  });
  it("reader presence fails closed on foreign/corrupt data", () => {
    const f = fixture(); const path = ownerPath("owner", f.home).replace(/jsonl$/, "reader");
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "{}");
    expect(readerFresh("owner", f.home)).toBe(false);
  });
});
