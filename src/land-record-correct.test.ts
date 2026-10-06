import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodePacketCorrection } from "./domain.ts";
import { findLanding } from "./autoland.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, packetLand, packetReport, packetVerify, projectOpen } from "./ops.ts";
import { stepPacket } from "./machines.ts";
import { dataDir, load, mutate, projectPath } from "./store.ts";
import { liveProc } from "./runtime.ts";
import { failWith, harness, makeRepo, runWith, sh } from "./test-support.ts";

async function fixture(mode: "pr-merge" | "herdr-workflow" | "rift-merge" = "pr-merge") {
  const h = harness();
  const origin = makeRepo(join(h.root, "origin"));
  const dir = join(h.root, "repo"); sh(h.root, "clone", "-q", origin, dir);
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "test", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true, mode }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "test" }));
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "probe", label: "worker", clone: true, prompt: "test" }));
  writeFileSync(join(row.cwd, "work"), "one\n"); sh(row.cwd, "add", "work"); sh(row.cwd, "commit", "-qm", "work");
  const id = sh(row.cwd, "rev-parse", "HEAD").trim();
  await runWith(h, packetReport({ dir, agent: row.name, owner: row.owner, cwd: row.cwd, commit: id, summary: "work", checks: [] }));
  await runWith(h, packetVerify(dir, id));
  // Make the PR head resolvable without merging it into the remote base.
  sh(dir, "fetch", "-q", row.cwd, id);
  return { h, dir, origin, row, id };
}
function merge(s: Awaited<ReturnType<typeof fixture>>) {
  sh(s.origin, "fetch", "-q", s.row.cwd, s.id); sh(s.origin, "merge", "--ff-only", s.id);
}
function audits(s: Awaited<ReturnType<typeof fixture>>) {
  return readFileSync(join(dataDir(s.dir), "corrections.jsonl"), "utf8").trim().split("\n").map(line => decodePacketCorrection(JSON.parse(line)));
}

describe("landing record fence and correction", () => {
  it.each(["pr-merge", "herdr-workflow"] as const)("refuses an off-base PR head in %s, then lands after a fresh fetch", async mode => {
    const s = await fixture(mode);
    const error = await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, evidence: "PR reviewed" }));
    expect(error.message).toContain(`${s.id} is not on base origin/main`);
    expect((await runWith(s.h, load(s.dir))).packets[0]?.state).toBe("verified");
    merge(s);
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, evidence: "merged PR reviewed" }));
    expect(result.packet).toMatchObject({ state: "committed", landedAs: s.id });
  });

  it("refuses missing and placeholder evidence without fetching or changing the packet", async () => {
    const s = await fixture();
    for (const evidence of [undefined, "", "  ", "Placeholder", " TBD ", "todo", "-", "N/A"]) {
      expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, evidence }))).message).toContain("non-placeholder evidence");
    }
    expect((await runWith(s.h, load(s.dir))).packets[0]?.state).toBe("verified");
  });

  it("uses the lane's explicit base instead of the default branch", async () => {
    const s = await fixture();
    sh(s.origin, "fetch", "-q", s.row.cwd, s.id); sh(s.origin, "branch", "release", s.id);
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, lanes: project.lanes.map(lane => ({ ...lane, base: "origin/release" })) }, undefined] as const)));
    expect((await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, evidence: "release branch checked" }))).packet.landedAs).toBe(s.id);
  });

  it("fails closed on stale base refs", async () => {
    const s = await fixture(); merge(s); sh(s.dir, "fetch", "-q", "origin");
    s.h.proc = { run: (cmd, args, opts) => cmd === "git" && args[0] === "fetch"
      ? Effect.succeed({ code: 1, stdout: "", stderr: "offline" }) : liveProc.run(cmd, args, opts) };
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, evidence: "reviewed" }))).message).toContain("cannot prove");
  });

  it.each(["committed", "rejected", "no_changes"] as const)("audits %s before reopening, then re-lands and appends a second audit", async outcome => {
    const s = await fixture(); merge(s);
    await runWith(s.h, packetLand(s.dir, { id: s.id, outcome, landedAs: s.id, attested: outcome === "committed", evidence: "original evidence" }));
    const old = (await runWith(s.h, load(s.dir))).packets[0]!;
    const reopened = await runWith(s.h, packetLand(s.dir, { id: s.id, corrects: "wrong outcome or SHA" }));
    expect(reopened.packet).toMatchObject({ state: "verified", landedAs: null });
    expect(reopened.packet).not.toHaveProperty("attested");
    expect(reopened.packet).not.toHaveProperty("evidence");
    expect(audits(s)).toEqual([expect.objectContaining({ packetId: s.id, by: s.h.sessionId, reason: "wrong outcome or SHA",
      from: { state: outcome, outcome, landedAs: old.landedAs, evidence: old.evidence } })]);
    await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, evidence: "confirmed merged SHA" }));
    await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes", corrects: "second correction" }));
    expect(audits(s)).toHaveLength(2);
    expect(audits(s)[1]?.from.evidence).toBe("confirmed merged SHA");
  });

  it("refuses non-owner corrections; takeover permits them", async () => {
    const s = await fixture();
    await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes" }));
    s.h.sessionId = "another-owner";
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes", corrects: "wrong record" })))._tag).toBe("GuardFailed");
    expect(existsSync(join(dataDir(s.dir), "corrections.jsonl"))).toBe(false);
    expect((await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes", corrects: "wrong record", takeover: true }))).packet.state).toBe("verified");
    expect(audits(s)[0]?.by).toBe("another-owner");
  });

  it("leaves the catalog untouched when audit append fails", async () => {
    const s = await fixture();
    await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes" }));
    mkdirSync(join(dataDir(s.dir), "corrections.jsonl"));
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes", corrects: "wrong record" })))._tag).toBe("StoreError");
    expect((await runWith(s.h, load(s.dir))).packets[0]?.state).toBe("no_changes");
  });

  it("keeps the old values in the audit even if the later catalog write fails", async () => {
    const s = await fixture();
    await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes", evidence: "old evidence" }));
    mkdirSync(`${projectPath(s.dir)}.${process.pid}.tmp`);
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes", corrects: "wrong record" })))._tag).toBe("StoreError");
    expect((await runWith(s.h, load(s.dir))).packets[0]?.state).toBe("no_changes");
    expect(audits(s)[0]?.from).toMatchObject({ state: "no_changes", evidence: "old evidence" });
  });

  it("only corrects terminal states and requires a reason", async () => {
    const s = await fixture();
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes", corrects: "wrong record" }))).message).toContain("CORRECT is not allowed from verified");
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "no_changes", corrects: " " }))).message).toContain("real reason");
    await expect(Effect.runPromise(stepPacket("id", "reported", { type: "CORRECT" }))).rejects.toThrow();
  });

  it("does not fence rift-merge external landings or change schema version", async () => {
    const s = await fixture("rift-merge");
    expect((await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, evidence: "placeholder" }))).packet.state).toBe("committed");
    expect((await runWith(s.h, load(s.dir))).writerSchemaVersion).toBeLessThanOrEqual(4);
  });

  it("auto-ingestion only discovers base-branch SHAs", async () => {
    const s = await fixture();
    let project = await runWith(s.h, load(s.dir));
    expect(await runWith(s.h, findLanding(project, project.packets[0]!))).toBeNull();
    merge(s);
    project = await runWith(s.h, load(s.dir));
    expect(await runWith(s.h, findLanding(project, project.packets[0]!))).toMatchObject({ sha: s.id, base: "main" });
  });
});
