import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeAgentRow, decodeProject } from "./domain.ts";
import { laneClose, laneOpen, projectOpen, projectReview } from "./ops.ts";
import { closedDir, mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "evidence", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  for (const slug of ["one", "other", "empty"]) {
    await runWith(h, laneOpen(dir, { slug, label: slug, goal: "ship" }));
    await runWith(h, laneClose(dir, slug));
  }
  const at = h.now.toISOString();
  const agent = (name: string, lane: string) => decodeAgentRow({ name, role: "worker", lane, cwd: dir, clone: null,
    profile: { label: "worker", model: "sol", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: null },
    sessionId: name, sessionFile: `/sessions/${name}.jsonl`, parentSessionFile: null, pane: null, owner: h.sessionId, brief: null,
    state: "closed", delivery: "none", restarts: 0, restore: null, createdAt: at, updatedAt: at });
  await runWith(h, mutate(dir, p => Effect.succeed([decodeProject({ ...p,
    agents: [agent("one", "one"), agent("one-b", "other"), agent("empty", "empty")],
    packets: [{ id: "packet", kind: "artifact", lane: "one", agent: "one", artifact: "/artifact.svx", report: "/reports/one.svx",
      checks: [], state: "rejected", verification: null, landedAs: null, reportedAt: at, updatedAt: at }],
  }), null] as const)));
  return { h, dir };
}

describe("retro evidence paths", () => {
  it("lists the session, close tail, restart tail and report without taking another lane's prefix-sharing tails", async () => {
    const { h, dir } = await setup();
    mkdirSync(closedDir(dir), { recursive: true });
    for (const name of ["one-100.txt", "one-restart-200.txt", "one-b-100.txt", "one-b-restart-200.txt", "one-not-a-tail.txt"]) {
      writeFileSync(join(closedDir(dir), name), "tail");
    }
    const review = await runWith(h, projectReview(dir, { note: "evidence" }));
    expect(review.retroLanes.find(lane => lane.slug === "one")).toEqual({
      slug: "one", sessionFiles: ["/sessions/one.jsonl"],
      closedTails: [join(closedDir(dir), "one-100.txt"), join(closedDir(dir), "one-restart-200.txt")],
      reports: ["/reports/one.svx"],
    });
  });
  it("lists no tails when the lane's agent has none, even with other lanes' tails present", async () => {
    const { h, dir } = await setup();
    mkdirSync(closedDir(dir), { recursive: true });
    writeFileSync(join(closedDir(dir), "one-100.txt"), "tail");
    const review = await runWith(h, projectReview(dir, { note: "missing tail" }));
    expect(review.retroLanes.find(lane => lane.slug === "empty")).toEqual({
      slug: "empty", sessionFiles: ["/sessions/empty.jsonl"], closedTails: [], reports: [],
    });
  });
});
