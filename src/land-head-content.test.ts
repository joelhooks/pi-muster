import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { agentLaunchForeground as agentLaunch, laneOpen, packetLand, packetReport, packetVerify, projectOpen, projectStatus } from "./ops.ts";
import { load } from "./store.ts";
import { failWith, forkHarness, harness, makeRepo, runWith, sh } from "./test-support.ts";

const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
const changed = original.replace("line 5\n", "WORKER_WORKTREE_SLIM\n");
async function prepare() {
  const h = harness();
  const origin = makeRepo(join(h.root, "origin"));
  writeFileSync(join(origin, "work"), original); sh(origin, "add", "work"); sh(origin, "commit", "-qm", "initial work");
  const dir = join(h.root, "repo"); sh(h.root, "clone", "-q", origin, dir);
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "test", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true, mode: "rift-merge" }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "test" }));
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "probe", label: "worker", clone: true, prompt: "test" }));
  writeFileSync(join(row.cwd, "work"), changed); sh(row.cwd, "add", "work"); sh(row.cwd, "commit", "-qm", "slim");
  const id = sh(row.cwd, "rev-parse", "HEAD").trim();
  await runWith(h, packetReport({ dir, agent: row.name, owner: row.owner, cwd: row.cwd, commit: id, summary: "slim", checks: [] }));
  await runWith(h, packetVerify(dir, id));
  return { h, dir, origin, id };
}
let template: Awaited<ReturnType<typeof prepare>>;
beforeAll(async () => { template = await prepare(); });
async function fixture(edit: "intact" | "dropped" | "later", auto: boolean) {
  const { h, dir, relocate } = forkHarness(template.h, template.dir);
  const project = await runWith(h, load(dir)); const row = project.agents[0]!;
  const source = auto ? relocate(template.origin) : dir;
  sh(source, "fetch", "-q", row.cwd, template.id); sh(source, "merge", "--ff-only", template.id);
  if (edit !== "intact") {
    writeFileSync(join(source, "work"), edit === "dropped" ? original : changed.replace("line 25\n", "legitimate later edit\n"));
    sh(source, "add", "work"); sh(source, "commit", "-qm", edit);
  }
  return { h, dir, source, id: template.id };
}

describe("ancestor landing content", () => {
  it.each(["intact", "later"] as const)("packet_land accepts %s content", async edit => {
    const f = await fixture(edit, false);
    const before = sh(f.dir, "rev-parse", "HEAD");
    const result = await runWith(f.h, packetLand(f.dir, { id: f.id, outcome: "committed" }));
    expect(result.packet.state).toBe("committed");
    expect(sh(f.dir, "rev-parse", "HEAD")).toBe(before);
  });
  it("refuses a reverted ancestor even when the dirty worktree contains the change", async () => {
    const f = await fixture("dropped", false);
    writeFileSync(join(f.dir, "work"), changed); sh(f.dir, "add", "work");
    const index = sh(f.dir, "ls-files", "--stage");
    expect((await failWith(f.h, packetLand(f.dir, { id: f.id, outcome: "committed" }))).message).toContain('ancestor but content missing in "work"');
    expect((await runWith(f.h, load(f.dir))).packets[0]?.state).toBe("verified");
    expect(sh(f.dir, "ls-files", "--stage")).toBe(index);
    expect(readFileSync(join(f.dir, "work"), "utf8")).toBe(changed);
  });
  it.each(["intact", "later", "dropped"] as const)("status auto-ingestion checks current base content: %s", async edit => {
    const f = await fixture(edit, true);
    const result = await runWith(f.h, projectStatus(f.dir));
    expect(result.project.packets[0]?.state).toBe(edit === "dropped" ? "verified" : "no_changes");
    if (edit === "dropped") expect(result.notes.join("\n")).toContain('ancestor but content missing in "work"');
  });
});
