import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Packet } from "./domain.ts";
import { blindReviewNote, changedLines, evidenceNote, reviewBrief, staleEvidence } from "./packet-evidence.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, packetLand, packetReport, packetVerify, projectOpen } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { failWith, harness, makeRepo, runWith, sh } from "./test-support.ts";

async function fixture(lines = 1) {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  writeFileSync(join(dir, "shared"), Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(""));
  sh(dir, "add", "shared"); sh(dir, "commit", "-qm", "shared base");
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "test", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true, mode: "rift-merge" }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "test", base: "refs/heads/main" }));
  const brief = join(h.root, "brief.md"); writeFileSync(brief, "Change shared and work.\n");
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "probe", label: "worker", clone: true, brief }));
  writeFileSync(join(row.cwd, "shared"), readFileSync(join(row.cwd, "shared"), "utf8").replace("line 0", "worker line 0"));
  writeFileSync(join(row.cwd, "work"), "new\n".repeat(lines)); sh(row.cwd, "add", "shared", "work"); sh(row.cwd, "commit", "-qm", "work");
  const id = sh(row.cwd, "rev-parse", "HEAD").trim();
  await runWith(h, packetReport({ dir, agent: row.name, owner: row.owner, cwd: row.cwd, commit: id, summary: "shared work", checks: [{ name: "fixture check", outcome: "pass" }] }));
  const base = sh(dir, "rev-parse", "main").trim();
  const verified = await runWith(h, packetVerify(dir, id));
  return { h, dir, row, id, brief, base, verified };
}
function advance(s: Awaited<ReturnType<typeof fixture>>, overlap: boolean) {
  const path = overlap ? "shared" : "other";
  writeFileSync(join(s.dir, path), overlap ? readFileSync(join(s.dir, path), "utf8").replace("line 29", "base line 29") : "unrelated\n");
  sh(s.dir, "add", path); sh(s.dir, "commit", "-qm", "base advanced");
}

describe("packet evidence decisions", () => {
  it("intersects exact paths, deduplicates and sorts", () => {
    expect(staleEvidence(["z", "a", "a", "dir"], ["a", "z", "dir/file"])).toEqual(["a", "z"]);
    expect(staleEvidence(["x"], [])).toEqual([]);
    expect(evidenceNote("main", ["a", "b"], false)).toContain('(2 paths) since verify');
    expect(evidenceNote("main", ["a"], true)).toBeNull();
    expect(evidenceNote("main", [], false)).toBeNull();
  });
  it("counts insertions and deletions and alarms only above 200", () => {
    expect(changedLines("100\t101\ta\n-\t-\tb\n")).toBe(201);
    expect(blindReviewNote(200, undefined)).toBeNull();
    expect(blindReviewNote(201, undefined)).toBe("no blind review recorded");
    expect(blindReviewNote(201, "/findings.md")).toBeNull();
  });
  it("caps UTF-8 review inputs with a visible cut", () => {
    const brief = reviewBrief({ packet: "hash", report: "report", diff: "é".repeat(100_000) });
    expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(60 * 1024 + 2);
    expect(brief).toContain("[cut:");
    expect(brief).toContain("What was not tested?");
  });
});

describe("packet evidence integration", () => {
  it("records base and changed paths, and writes a context-blind review brief", async () => {
    const s = await fixture();
    expect(s.verified.packet.verification).toMatchObject({ baseSha: s.base, paths: ["shared", "work"] });
    const file = join(s.verified.packet.report, "..", `${s.id}-review.md`);
    expect(s.verified.reviewFile).toBe(file);
    const text = readFileSync(file, "utf8");
    expect(text).toContain(s.brief);
    expect(text).toContain("Change shared and work.");
    expect(text).toContain("fixture check");
    expect(text).toContain("diff --git a/shared b/shared");
    expect(text).toContain("not checked");
    expect(text).toContain("run nothing");
    expect(text).not.toContain(s.row.sessionFile!);
    expect(s.verified.note).toContain('agent_launch role:"judge"');
    expect(s.verified.note).toContain("prompt naming only that file");
  });
  it.each([true, false])("alarms on overlapping moved inputs only (overlap=%s), without refusing", async overlap => {
    const s = await fixture(); advance(s, overlap);
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed" }));
    expect(result.packet.state).toBe("committed");
    if (overlap) {
      expect(result.note).toContain('evidence stale: refs/heads/main moved under "shared" (1 paths) since verify; pass gate or re-run packet_verify');
    } else expect(result.note).not.toContain("evidence stale:");
  });
  it("does not alarm when a gate actually runs", async () => {
    const s = await fixture(); advance(s, true);
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", gate: "true" }));
    expect(result.packet.gate).not.toBeNull();
    expect(result.note).not.toContain("evidence stale:");
  });
  it("suppresses stale evidence after a local gate with no fleet receipt", async () => {
    const s = await fixture(); advance(s, true);
    const saved = process.env.MUSTER_FLEET_COMPUTE;
    process.env.MUSTER_FLEET_COMPUTE = "off";
    try {
      const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", gate: "true" }));
      expect(result.packet.gate).toBeNull();
      expect(result.note).not.toContain("evidence stale:");
    } finally {
      if (saved === undefined) delete process.env.MUSTER_FLEET_COMPUTE;
      else process.env.MUSTER_FLEET_COMPUTE = saved;
    }
  });
  it("decodes old verification and does not issue the stale alarm", async () => {
    const s = await fixture(); advance(s, true);
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, packets: project.packets.map(packet => Schema.decodeUnknownSync(Packet)({ ...packet, verification: { at: "old", checks: [] } })) }, undefined] as const)));
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed" }));
    expect(result.note).not.toContain("evidence stale:");
  });
  it.each([false, true])("large packets alarm without review, or record the review (review=%s)", async reviewed => {
    const s = await fixture(201);
    const review = join(s.h.root, "findings.md"); writeFileSync(review, "1. Not checked: runtime behavior.\n");
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", ...(reviewed ? { review } : {}) }));
    expect(result.packet.state).toBe("committed");
    if (reviewed) {
      expect(result.packet.review).toBe(review);
      expect((await runWith(s.h, load(s.dir))).packets[0]?.review).toBe(review);
      expect(result.note).not.toContain("no blind review recorded");
    } else expect(result.note).toContain("no blind review recorded");
  });
  it("keeps verification live when the snapshot git read fails", async () => {
    const s = await fixture();
    const original = s.h.proc;
    s.h.proc = { run: (command, args, options) => command === "git" && args.includes("diff") && args.includes("--name-only")
      ? Effect.succeed({ code: 1, stdout: "", stderr: "snapshot unavailable" }) : original.run(command, args, options) };
    const result = await runWith(s.h, packetVerify(s.dir, s.id));
    expect(result.packet.state).toBe("verified");
    expect(result.packet.verification).not.toHaveProperty("baseSha");
    expect(result.reviewFile).toBeNull();
    expect(result.note).toContain("evidence snapshot unavailable:");
    expect(result.note).toContain("stale-evidence check off for this packet");
  });
  it.each(["stale", "review"])("keeps the landing committed if the %s alarm's git read fails", async alarm => {
    const s = await fixture(201); advance(s, true);
    const original = s.h.proc;
    const patches: string[][] = [];
    s.h.proc = { run: (command, args, options) => {
      if (command === "git" && args.includes("diff") && args.includes("--no-textconv") && !args.includes("--numstat")) patches.push([...args]);
      return command === "git" && args.includes("diff") && args.includes(alarm === "stale" ? "--name-only" : "--numstat") && args.at(-1) === "--"
        ? Effect.succeed({ code: 1, stdout: "", stderr: "alarm unavailable" }) : original.run(command, args, options);
    } };
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed" }));
    expect(result.packet.state).toBe("committed");
    expect((await runWith(s.h, load(s.dir))).packets[0]?.state).toBe("committed");
    expect(result.note).toContain(alarm === "stale" ? "packet evidence alarm unavailable:" : "blind review alarm unavailable:");
    // A failed line-count read must not swallow the independent stale alarm.
    if (alarm === "review") expect(result.note).toContain("evidence stale:");
    expect(patches).toEqual([]);
  });
  it("does not warn on a small packet and rejects a relative review path before merging", async () => {
    const s = await fixture();
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", review: "findings.md" }))).message).toContain("absolute path");
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed" }));
    expect(result.note).not.toContain("no blind review recorded");
    expect(result.note).not.toContain("evidence stale:");
  });
});
