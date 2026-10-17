import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionDirFor } from "./argv.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { load } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

// Ernestine, 2026-10-17: the Switchboard owns its project but has no row, so `fork from: "switchboard"` failed, and a
// raw `pi --fork` restored her Rat King name into the fork, which took her lease and acked her mail for 15 minutes.
beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("RATKING_NAME", "switchboard"); });
afterEach(() => { vi.unstubAllEnvs(); });

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "switchboard", outcome: "o", reviewTrigger: "weekly", nextAction: "n", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "staff", label: "staff", goal: "g" }));
  // The caller's own journal, where Pi keeps it for the process cwd. No catalog row names it.
  const sessions = sessionDirFor(process.cwd(), h.home);
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, `2026-10-17T20-00-00-000Z_${h.sessionId}.jsonl`);
  writeFileSync(file, [
    { type: "session", id: h.sessionId, cwd: dir },
    { type: "model_change", id: "a1", parentId: null, provider: "claude-bridge", modelId: "claude-opus-5-5" },
    { type: "thinking_level_change", id: "a2", parentId: "a1", thinkingLevel: "high" },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { h, dir, file };
}
const fork = (from: string, extra: Record<string, unknown> = {}) =>
  ({ action: "fork" as const, from, name: "side", role: "worker" as const, lane: "staff", label: "🧵 side", prompt: "look into it", ...extra });

describe("fork from a session with no row", () => {
  it("forks the calling session by id or file under its own Rat King name, leaving the parent's name alone", async () => {
    for (const by of ["id", "file"] as const) {
      const { h, dir, file } = await setup();
      const result = await runWith(h, agentLaunch(dir, fork(by === "id" ? h.sessionId : file)));
      expect(result.argv).toContain("--fork");
      expect(result.argv).toContain(file);
      expect(result.argv).toContain("claude-bridge/claude-opus-5-5:high");
      expect(result.row).toMatchObject({ name: "side", lane: "staff", cwd: dir, parentSessionFile: file });
      expect(result.row.restore?.env.RATKING_NAME).toBe("switchboard/side");
      expect(h.herdr.launcherScripts.at(-1)).toContain("RATKING_NAME='switchboard/side'");
      expect(h.herdr.launcherScripts.at(-1)).not.toContain("RATKING_SUCCEEDS"); // a fork is a sibling, never a successor
      expect(process.env.RATKING_NAME).toBe("switchboard");
      expect((await runWith(h, load(dir))).agents.map(row => row.name)).toEqual(["side"]);
    }
  });
  it("refuses another session's journal, side: true, and a call without role, lane or label", async () => {
    const { h, dir, file } = await setup();
    const caller = h.sessionId;
    h.sessionId = "someone-else";
    expect((await failWith(h, agentLaunch(dir, fork(file)))).message).toContain("must come from that session itself");
    h.sessionId = caller;
    expect((await failWith(h, agentLaunch(dir, fork(caller, { side: true })))).message).toContain("side: true forks a desk row");
    expect((await failWith(h, agentLaunch(dir, fork(caller, { lane: undefined })))).message).toContain("needs role, lane and label");
    expect((await failWith(h, agentLaunch(dir, fork("nobody")))).message).toContain("no agent row named nobody");
  });
});
