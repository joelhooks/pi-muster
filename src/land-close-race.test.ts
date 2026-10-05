import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agentClose, agentLaunch, laneOpen, packetLand, packetReport, packetVerify, projectOpen } from "./ops.ts";
import { Herdr } from "./runtime.ts";
import { closedDir, load } from "./store.ts";
import { harness, makeRepo, runWith, sh } from "./test-support.ts";

afterEach(() => { vi.unstubAllEnvs(); });

async function verifiedWorker() {
  vi.stubEnv("MUSTER_PROJECT", "");
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const h = harness(); // Injected clock and no-op sleeps; no wall-clock waits.
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "race", outcome: "land and close once", nextAction: "launch worker", reviewTrigger: "weekly", space: "w1", ephemeral: true, cadenceMinutes: null, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "race", label: "🏁 race", goal: "land and close once" }));
  const brief = join(h.root, "brief.md");
  writeFileSync(brief, "one packet\n");
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "race-worker", role: "worker", lane: "race", label: "🏁 race worker", clone: true, brief }));
  writeFileSync(join(row.cwd, "work.txt"), "committed packet\n");
  sh(row.cwd, "add", "work.txt");
  sh(row.cwd, "commit", "-q", "-m", "packet");
  const commit = sh(row.cwd, "rev-parse", "HEAD").trim();
  await runWith(h, packetReport({ dir, agent: row.name, owner: h.sessionId, cwd: row.cwd, commit, summary: "race packet", checks: [] }));
  await runWith(h, packetVerify(dir, commit));
  // Prove landing without a heavy gate or a merge process in the pane callback.
  sh(dir, "fetch", "-q", row.cwd, commit);
  sh(dir, "merge", "--ff-only", "FETCH_HEAD");
  expect((await runWith(h, load(dir))).agents[0]?.state).toBe("verified");
  return { h, dir, row, commit };
}

describe("committed packet land/close race", () => {
  it.each(["before close", "during pane.read", "during pane.close"] as const)("closes first time with landing %s, saving tail and removing clone", async timing => {
    const { h, dir, row, commit } = await verifiedWorker();
    const client = h.herdr.client();
    const land = packetLand(dir, { id: commit, outcome: "committed", landedAs: commit });
    let landed = false;
    if (timing === "before close") {
      await runWith(h, land);
      landed = true;
    }
    const result = await runWith(h, agentClose(dir, { name: row.name }).pipe(Effect.provideService(Herdr, {
      ...client,
      request: request => Effect.gen(function* () {
        if (!landed && `during ${request.method}` === timing) {
          expect((yield* load(dir)).agents[0]?.state).toBe("verified");
          yield* land;
          expect((yield* load(dir)).agents[0]?.state).toBe("landed");
          landed = true;
        }
        return yield* client.request(request);
      }),
    })));
    expect(landed).toBe(true);
    expect(result.row.state).toBe("closed");
    expect(result.row.pane).toBeNull();
    expect(result.cloneError).toBeNull();
    expect(existsSync(row.cwd)).toBe(false);
    expect(readFileSync(join(closedDir(dir), `${row.name}-${h.now.getTime()}.txt`), "utf8")).toBe("last lines");
    expect(h.herdr.calls.filter(call => call.method === "pane.close")).toHaveLength(1);
    expect(h.herdr.panes.has(row.pane!.paneId)).toBe(false);
    const saved = await runWith(h, load(dir));
    expect(saved.agents[0]?.state).toBe("closed");
    expect(saved.packets[0]?.state).toBe("committed");
    expect(saved.packets[0]?.landedAs).toBe(commit);
    expect(result.restore.argv).toContain("--session");
  });
});
