import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendOwnerItem, deliverOwnerItem, forwardOwner, ingestOwnerItem, ownerPath, readOwnerQueue, readOwnerSources, writeReader } from "./owner-queue.ts";
import { ownerFeed } from "./owner-feed.ts";
import { projectOpen } from "./ops.ts";
import { harness, runWith } from "./test-support.ts";

afterEach(() => vi.unstubAllEnvs());

const fixture = () => mkdtempSync(join(tmpdir(), "owner-route-misfire-"));
const post = (home: string, owner: string, project: string) => Effect.runPromise(deliverOwnerItem({
  owner, project, home, session: "worker", item: { author: "worker", kind: "question", title: project },
  send: () => Effect.succeed({ status: "delivered" as const }),
}));
const legacy = (home: string, owner: string, to: string, project: string) => {
  const path = ownerPath(owner, home).replace(/jsonl$/, "forward");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ to, project, at: new Date().toISOString(), cursor: 0 }));
};

describe("project-scoped owner routing", () => {
  it("normalizes a local owner_note project directory to the forwarding slug", async () => {
    const h = harness(); const dir = join(h.root, "project"); mkdirSync(dir);
    await runWith(h, projectOpen({ dir, slug: "probe", outcome: "routing", reviewTrigger: "weekly", nextAction: "prove", criticalPath: [], space: "w1", ephemeral: true, cadenceMinutes: 15, musterExtension: "/muster", deskExtension: null }));
    forwardOwner({ from: "x", to: "y", project: "probe", home: h.home });
    await post(h.home, "x", dir);
    expect(readOwnerQueue("x", h.home).items).toHaveLength(0);
    expect(readOwnerQueue("y", h.home).items[0]?.item.project).toBe("probe");
  });
  it("uses the matching remote launch's slug when its project directory is unavailable", async () => {
    const home = fixture(); const dir = join(home, "unavailable-remote-project");
    vi.stubEnv("MUSTER_PROJECT", dir); vi.stubEnv("MUSTER_PROJECT_SLUG", "probe");
    forwardOwner({ from: "x", to: "y", project: "probe", home });
    await post(home, "x", dir);
    expect(readOwnerQueue("y", home).items[0]?.item.project).toBe("probe");
    await post(home, "x", "other");
    expect(readOwnerQueue("x", home).items[0]?.item.project).toBe("other");
  });
  it("a takeover in A leaves the live owner's B mail with that owner", async () => {
    const home = fixture(); writeReader("x", home);
    forwardOwner({ from: "x", to: "y", project: "a", home });
    await post(home, "x", "b"); await post(home, "x", "a");
    expect(readOwnerQueue("x", home).items.map(r => r.item.text)).toEqual(["@x b"]);
    expect(readOwnerQueue("y", home).items.map(r => r.item.text)).toEqual(["@y a"]);
    expect(readOwnerSources("y", home).flatMap(s => s.items).map(r => r.item.text)).toEqual(["@y a"]);
  });
  it("opposite forwards in different projects do not form a cycle", async () => {
    const home = fixture();
    forwardOwner({ from: "x", to: "y", project: "p1", home });
    expect(() => forwardOwner({ from: "y", to: "x", project: "p2", home })).not.toThrow();
    await post(home, "x", "p1"); await post(home, "y", "p2");
    expect(readOwnerQueue("y", home).items).toHaveLength(1);
    expect(readOwnerQueue("x", home).items).toHaveLength(1);
  });
  it("keeps multiple project forwards from the same session independent", async () => {
    const home = fixture();
    forwardOwner({ from: "x", to: "y", project: "a", home });
    forwardOwner({ from: "x", to: "z", project: "b", home });
    await post(home, "x", "a"); await post(home, "x", "b"); await post(home, "x", "c");
    expect(readOwnerQueue("y", home).items.map(r => r.item.project)).toEqual(["a"]);
    expect(readOwnerQueue("z", home).items.map(r => r.item.project)).toEqual(["b"]);
    expect(readOwnerQueue("x", home).items.map(r => r.item.project)).toEqual(["c"]);
  });
  it("uses a dead reader's legacy forward only for its recorded project", async () => {
    const home = fixture(); writeReader("x", home, Date.now() - 121000); legacy(home, "x", "y", "a");
    await post(home, "x", "b"); await post(home, "x", "a");
    expect(readOwnerQueue("x", home).items.map(r => r.item.project)).toEqual(["b"]);
    expect(readOwnerQueue("y", home).items.map(r => r.item.project)).toEqual(["a"]);
  });
  it("ignores an old unscoped forward while its source reader is live", async () => {
    const home = fixture(); writeReader("x", home); legacy(home, "x", "y", "a");
    await post(home, "x", "a");
    expect(readOwnerQueue("x", home).items).toHaveLength(1);
    expect(readOwnerQueue("y", home).items).toHaveLength(0);
  });
  it("never forwards a legacy item without a project", () => {
    const home = fixture();
    const old = appendOwnerItem("x", { author: "worker", kind: "question", title: "unknown project" }, home);
    forwardOwner({ from: "x", to: "y", project: "a", home });
    expect(readOwnerSources("y", home).flatMap(s => s.items)).toEqual([]);
    expect(readOwnerSources("x", home).flatMap(s => s.items).map(r => r.item.uri)).toEqual([old.uri]);
    appendOwnerItem("x", { author: "worker", kind: "question", title: "late old code" }, home);
    expect(readOwnerQueue("x", home).items).toHaveLength(2);
  });
  it("deduplicates an ingested post even when the old reader consumed its history", async () => {
    const home = fixture(); await post(home, "x", "a");
    const item = readOwnerQueue("x", home).items[0]!.item;
    writeReader("x", home, Date.now() + 1000);
    forwardOwner({ from: "x", to: "y", project: "a", home });
    expect(readOwnerSources("y", home).flatMap(s => s.items)).toEqual([]);
    expect(ingestOwnerItem("x", item, home, "a")).toBe(false);
    expect(readOwnerQueue("x", home).items).toHaveLength(1);
  });
  it("a stale owner's project history reaches its successor with via labels once", async () => {
    const home = fixture(); writeReader("x", home, Date.now() - 121000);
    await post(home, "x", "a"); await post(home, "x", "b");
    const old = readOwnerQueue("x", home).items[0]!.item;
    forwardOwner({ from: "x", to: "y", project: "a", home });
    const entries: Array<{ type: string; customType: string; data: unknown }> = [];
    const feed = ownerFeed({ session: "y", home, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), sendMessage: () => {} });
    expect(feed.inbox().via).toEqual({ [old.uri]: "x" });
    expect(feed.flush()).toBe(1); feed.restore(entries); expect(feed.flush()).toBe(0);
    feed.beforeTurn(); feed.restore(entries); expect(feed.inbox().items).toHaveLength(0); feed.dispose();
    expect(readOwnerSources("x", home).flatMap(s => s.items).map(r => r.item.text)).toEqual(["@x b"]);
  });
});
