import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen, thinkingClampNote } from "./ops.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

// Overthruster, 2026-10-16: 14 Sol workers asked for xhigh ran at high, because models.json had no thinkingLevelMap
// and Pi clamps silently. The launch receipt now says so.
beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); });
afterEach(() => { vi.unstubAllEnvs(); });

async function launch(effective: string | null) {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "clamp", outcome: "clamp", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "clamp", label: "clamp", goal: "test" }));
  if (effective) h.herdr.turnEntries = [{ type: "thinking_level_change", thinkingLevel: effective }];
  return runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "clamp", label: "worker", cwd: dir, model: "sol", thinking: "xhigh", prompt: "start" }));
}

describe("thinking clamp", () => {
  it("compares the requested level with the session's effective one", () => {
    expect(thinkingClampNote("xhigh", "high")).toContain("⚠ thinking clamped: requested xhigh, effective high");
    expect(thinkingClampNote("xhigh", "xhigh")).toBeNull();
    expect(thinkingClampNote(null, "high")).toBeNull();
    expect(thinkingClampNote("xhigh", undefined)).toBeNull();
  });
  it("warns in the launch receipt when Pi ran the row at a lower level than asked", async () => {
    const clamped = await launch("high");
    expect(clamped.proof?.state).toBe("proven");
    expect(clamped.notes.join("\n")).toContain("⚠ thinking clamped: requested xhigh, effective high");
    expect((await launch("xhigh")).notes.join("\n")).not.toContain("thinking clamped");
    expect((await launch(null)).notes.join("\n")).not.toContain("thinking clamped");
  });
});
