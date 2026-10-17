import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentLaunchForeground, laneOpen, projectOpen } from "./ops.ts";
import { load } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

afterEach(() => vi.unstubAllEnvs());

// Rule hunt, 2026-10-17 (drovr, 2026-10-12): a local launch allocated its clone, then found the tab full, and every retry
// failed on "already exists". The tab is asked first, and the refusal names the next call.
it("refuses a full local lane tab before allocating a clone, and names the next call", async () => {
  vi.stubEnv("MUSTER_PROJECT", "");
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "full", outcome: "fill a tab", nextAction: "test", reviewTrigger: "weekly", space: "w1", ephemeral: true, cadenceMinutes: null, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "full", label: "🧱 full", goal: "fill a tab" }));
  const brief = join(h.root, "brief.md");
  writeFileSync(brief, "fill\n");
  const launch = (name: string) => agentLaunchForeground(dir, { action: "launch", name, lane: "full", role: "worker", label: `🧱 ${name}`, clone: true, brief });
  const rows = [];
  for (const name of ["w1", "w2", "w3", "w4"]) rows.push((await runWith(h, launch(name))).row);
  const clones = dirname(rows[0]!.cwd);
  const before = readdirSync(clones).sort();
  const error = await failWith(h, launch("w5"));
  expect(error.message).toContain("lane full already has 4 worker panes (w1, w2, w3, w4)");
  expect(error.message).toContain("nothing was allocated");
  expect(error.message).toContain('lane_open a new lane (e.g. slug "full-2")');
  expect(readdirSync(clones).sort()).toEqual(before);
  expect((await runWith(h, load(dir))).agents.find(agent => agent.name === "w5")?.clone ?? null).toBeNull();
});
