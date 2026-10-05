import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { laneDeliver, laneOpen, projectOpen, projectStatus, projectUpdate } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { flowLine, inFlight } from "./tokens.ts";
import { appendDesk, deskRecord, queuePath } from "./desk.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

async function setup(level?: number, policy?: 0 | 1 | 2 | 3) {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  if (level !== undefined) writeFileSync(join(dir, "VISION.md"), `## Deploy posture\nLevel: ${level}\nResearch.\n`);
  await runWith(h, projectOpen({ dir, slug: "posture", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  await runWith(h, projectUpdate(dir, { policy: { wipLimit: 1, ...(policy !== undefined ? { deployLevel: policy } : {}) } }));
  await runWith(h, laneOpen(dir, { slug: "one", label: "one", goal: "ship" }));
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, lanes: p.lanes.map(l => ({ ...l, delivery: "landed" as const })) }, null] as const)));
  return { h, dir };
}
it("VISION 2 frees an open deployed lane's slot and keeps it watching", async () => {
  const { h, dir } = await setup(2);
  await runWith(h, laneDeliver(dir, { slug: "one", stage: "deployed", evidence: "Rollback: git revert HEAD\nWatch: error rate" }));
  const p = await runWith(h, load(dir));
  expect(inFlight(p)).toHaveLength(0);
  expect(flowLine(p)).toContain("watching: one");
  await runWith(h, laneOpen(dir, { slug: "two", label: "two", goal: "ship" }));
});
it("no posture keeps deployed work in WIP", async () => {
  const { h, dir } = await setup();
  await runWith(h, laneDeliver(dir, { slug: "one", stage: "deployed", evidence: "shipped" }));
  expect(inFlight(await runWith(h, load(dir)))).toHaveLength(1);
});
it("status names VISION precedence, mismatch and lane level", async () => {
  const { h, dir } = await setup(3, 1);
  const status = await runWith(h, projectStatus(dir, { act: false }));
  expect(status.board).toContain("Level: 3 (jfdi), source: VISION.md");
  expect(status.board).toContain("policy 1 differs");
  expect(status.board).toContain("one=open [deploy 3]");
});
it("overrides lower only, recording their rubric rule", async () => {
  const { h, dir } = await setup(3);
  const lower = await runWith(h, laneOpen(dir, { slug: "low", label: "low", goal: "ship", open: false, deployLevel: 0, deployRule: "irreversible" }));
  expect(lower.lane).toMatchObject({ deployLevel: 0, deployRule: "irreversible" });
  writeFileSync(join(dir, "VISION.md"), "## Deploy posture\nLevel: 1\n");
  expect((await failWith(h, laneOpen(dir, { slug: "high", label: "high", goal: "ship", open: false, deployLevel: 3, deployRule: "shared-infra" }))).message).toContain("cannot raise");
});
it("rubric caps cannot be bypassed by a lane override", async () => {
  const { h, dir } = await setup(3);
  expect((await failWith(h, laneOpen(dir, { slug: "unsafe", label: "unsafe", goal: "ship", open: false, deployLevel: 2, deployRule: "customer-facing" }))).message).toContain("caps deployLevel at 1");
});
it("level 3 needs rollback but no watch and permits later proof", async () => {
  const { h, dir } = await setup(3);
  expect((await failWith(h, laneDeliver(dir, { slug: "one", stage: "deployed", evidence: "shipped" }))).message).toContain("rollback");
  await runWith(h, laneDeliver(dir, { slug: "one", stage: "deployed", evidence: "Rollback: git revert HEAD" }));
  expect(inFlight(await runWith(h, load(dir)))).toHaveLength(0);
  expect((await runWith(h, laneDeliver(dir, { slug: "one", stage: "proven", evidence: "later check" }))).delivery).toBe("proven");
});
it("level 2 names missing rollback and watch evidence", async () => {
  const { h, dir } = await setup(2);
  for (const [evidence, missing] of [["shipped", "rollback"], ["Rollback: git revert HEAD", "watch"]]) {
    expect((await failWith(h, laneDeliver(dir, { slug: "one", stage: "deployed", evidence: evidence! }))).message).toContain(missing);
  }
});
it("locked deploy requires an exact cited resolved approval", async () => {
  const { h, dir } = await setup(0);
  const deliver = (evidence: string) => laneDeliver(dir, { slug: "one", stage: "deployed", evidence });
  expect((await failWith(h, deliver("shipped"))).message).toContain("resolved approval");
  const path = queuePath("posture", h.home);
  appendDesk(path, deskRecord({ from: "Joel", kind: "approval", title: "ship one" }, "approve-one", h.now));
  expect((await failWith(h, deliver("approval: approve-one"))).message).toContain("resolved approval");
  appendDesk(path, deskRecord({ from: "Joel", kind: "done", title: "approved", resolves: "approve-one" }, "resolved", h.now));
  expect((await failWith(h, deliver("approval: approve-one-extra"))).message).toContain("resolved approval");
  await runWith(h, deliver("approval: approve-one"));
});
it("proven follows waived", async () => {
  const { h, dir } = await setup();
  await runWith(h, laneDeliver(dir, { slug: "one", stage: "waived", evidence: "docs" }));
  expect((await runWith(h, laneDeliver(dir, { slug: "one", stage: "proven", evidence: "checked live" }))).delivery).toBe("proven");
});
it("missing and malformed sections keep default 1 and print the add-section template", async () => {
  const { h, dir } = await setup();
  let status = await runWith(h, projectStatus(dir, { act: false }));
  expect(status.board).toContain("source: default");
  expect(status.board).toContain("Add to VISION.md:\n## Deploy posture\nLevel: 1 (prove)");
  writeFileSync(join(dir, "VISION.md"), "## Deploy posture");
  status = await runWith(h, projectStatus(dir, { act: false }));
  expect(status.board).toContain("malformed");
  expect(status.board).toContain("source: default");
});
it("a later VISION change lowers effective lane permission at call time", async () => {
  const { h, dir } = await setup(3);
  await runWith(h, laneOpen(dir, { slug: "low", label: "low", goal: "ship", open: false, deployLevel: 2, deployRule: "shared-infra" }));
  writeFileSync(join(dir, "VISION.md"), "## Deploy posture\nLevel: 1 (prove)\n");
  const status = await runWith(h, projectStatus(dir, { act: false }));
  expect(status.board).toContain("low=proposed [deploy 1]");
});
it("malformed VISION is reported and falls back to policy", async () => {
  const { h, dir } = await setup(9, 2);
  const status = await runWith(h, projectStatus(dir, { act: false }));
  expect(status.board).toContain("malformed");
  expect(status.board).toContain("Level: 2 (ship-and-watch), source: policy");
});
