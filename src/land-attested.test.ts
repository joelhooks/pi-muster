import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { agentLaunchForeground as agentLaunch, laneOpen, packetLand, packetReport, packetVerify, projectOpen } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { liveProc } from "./runtime.ts";
import { failWith, harness, makeRepo, runWith, sh } from "./test-support.ts";

async function fixture() {
  const h = harness();
  const origin = makeRepo(join(h.root, "origin"));
  const dir = join(h.root, "repo"); sh(h.root, "clone", "-q", origin, dir);
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "test", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "test" }));
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "probe", label: "worker", clone: true, prompt: "test" }));
  writeFileSync(join(row.cwd, "work"), "one\n"); sh(row.cwd, "add", "work"); sh(row.cwd, "commit", "-qm", "work");
  const id = sh(row.cwd, "rev-parse", "HEAD").trim();
  await runWith(h, packetReport({ dir, agent: row.name, owner: row.owner, cwd: row.cwd, commit: id, summary: "work", checks: [] }));
  return { h, dir, origin, row, id };
}
function squash(s: Awaited<ReturnType<typeof fixture>>) {
  sh(s.origin, "fetch", "-q", s.row.cwd, s.id); sh(s.origin, "merge", "--squash", s.id);
  writeFileSync(join(s.origin, "work"), "one\nother work\n");
  sh(s.origin, "add", "work"); sh(s.origin, "commit", "-qm", "larger squash");
  return sh(s.origin, "rev-parse", "HEAD").trim();
}
const evidence = "reconciler confirmed packet in merged PR";

describe("owner-attested landing", () => {
  it("records a larger squash, preserving the strict path guard and never reading the clone", async () => {
    const s = await fixture(); await runWith(s.h, packetVerify(s.dir, s.id));
    const landedAs = squash(s);
    sh(s.dir, "fetch", "-q", "origin");
    const strict = await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs }));
    expect(strict.message).toBe(`${landedAs} does not match packet ${s.id.slice(0, 12)}; differing paths: "work"`);
    const cloneHead = sh(s.row.cwd, "rev-parse", "HEAD");
    const sourceHead = sh(s.dir, "rev-parse", "HEAD");
    const calls: string[] = [];
    s.h.proc = { run: (cmd, args, opts) => {
      calls.push(`${opts.cwd}: ${cmd} ${args.join(" ")}`);
      if (opts.cwd === s.row.cwd || args.includes(s.row.cwd)) throw new Error("attested landing touched clone");
      return liveProc.run(cmd, args, opts);
    } };
    const landed = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs, attested: true, evidence: `owner-attested: landed inside ${landedAs}; ${evidence}` });
    expect(calls.some(call => /patch-id|diff |cat-file/.test(call))).toBe(false);
    expect(sh(s.row.cwd, "rev-parse", "HEAD")).toBe(cloneHead);
    expect(sh(s.dir, "rev-parse", "HEAD")).toBe(sourceHead);
    expect((await runWith(s.h, load(s.dir))).agents.find(row => row.name === s.row.name)?.state).toBe("landed");
  });

  it("lands a reported packet after dirty-clone verification fails, without changing dirty bytes", async () => {
    const s = await fixture(); const landedAs = squash(s);
    writeFileSync(join(s.row.cwd, "work"), "dirty\n");
    expect((await failWith(s.h, packetVerify(s.dir, s.id)))._tag).toBe("PacketCheckFailed");
    const strict = await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs }));
    expect(strict.message).toBe(`run packet_verify on ${s.id.slice(0, 12)} before landing it`);
    const before = sh(s.row.cwd, "diff");
    expect((await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }))).packet.attested).toBe(true);
    expect(sh(s.row.cwd, "diff")).toBe(before);
  });

  it("lands a ported packet even when it is absent from the clone branch", async () => {
    const s = await fixture(); const base = sh(s.origin, "rev-parse", "HEAD").trim();
    writeFileSync(join(s.origin, "other"), "other\n"); sh(s.origin, "add", "other"); sh(s.origin, "commit", "-qm", "other");
    sh(s.origin, "fetch", "-q", s.row.cwd, s.id); sh(s.origin, "cherry-pick", s.id);
    const landedAs = sh(s.origin, "rev-parse", "HEAD").trim();
    sh(s.row.cwd, "checkout", "-q", "--detach", base);
    expect((await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }))).packet.state).toBe("committed");
  });

  it("refuses a resolved commit off the base branch", async () => {
    const s = await fixture(); const landedAs = squash(s);
    sh(s.origin, "branch", "unlanded", landedAs); sh(s.origin, "checkout", "-q", "main~1");
    sh(s.origin, "branch", "-f", "main", "HEAD");
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }))).message).toContain("not on base origin/main");
    expect((await runWith(s.h, load(s.dir))).packets[0]?.state).toBe("reported");
  });

  it.each([undefined, "", "  "])("requires nonempty evidence (%s)", async evidence => {
    const s = await fixture();
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, attested: true, evidence }))).message).toContain("attested landing requires landedAs and non-empty evidence");
  });

  it("requires landedAs and restricts attestation to committed outcomes", async () => {
    const s = await fixture();
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", attested: true, evidence }))).message).toContain("attested landing requires landedAs and non-empty evidence");
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "rejected", landedAs: s.id, attested: true, evidence }))).message).toContain("attested is only supported for committed packets");
  });

  it("uses an explicit lane base, marks superseded packets, and decodes old packets without a marker", async () => {
    const s = await fixture(); const landedAs = squash(s);
    sh(s.origin, "branch", "release", landedAs); sh(s.origin, "checkout", "-q", "main~1"); sh(s.origin, "branch", "-f", "main", "HEAD");
    const old = (await runWith(s.h, load(s.dir))).packets[0]!;
    expect(old).not.toHaveProperty("attested");
    const earlier = { ...old, id: "earlier-packet" };
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, lanes: project.lanes.map(lane => lane.slug === "probe" ? { ...lane, base: "release" } : lane), packets: [earlier, { ...old, supersedes: earlier.id }] }, undefined] as const)));
    await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }));
    const packets = (await runWith(s.h, load(s.dir))).packets;
    expect(packets.every(packet => packet.state === "committed" && packet.attested && packet.landedAs === landedAs)).toBe(true);
    expect(packets[0]?.evidence).toContain("owner-attested: landed inside");
  });

  it("fails closed when origin cannot refresh the base", async () => {
    const s = await fixture(); const landedAs = squash(s); sh(s.dir, "fetch", "-q", "origin");
    s.h.proc = { run: (cmd, args, opts) => cmd === "git" && args[0] === "fetch"
      ? Effect.succeed({ code: 1, stdout: "", stderr: "offline" }) : liveProc.run(cmd, args, opts) };
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }))).message).toBe("fetch origin/main failed; cannot attest against stale base refs");
  });

  it("refuses unknown landedAs commits", async () => {
    const s = await fixture();
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: "f".repeat(40), attested: true, evidence }))).message).toContain("unknown landedAs commit");
  });

  it.each(["running", "landed", "closed"] as const)("records without stepping an agent in %s", async state => {
    const s = await fixture(); const landedAs = squash(s);
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => row.name === s.row.name ? { ...row, state } : row) }, undefined] as const)));
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }));
    expect(result.packet.state).toBe("committed");
    expect(result.note).toContain(`agent ${s.row.name} left in ${state} (no LAND transition)`);
    expect((await runWith(s.h, load(s.dir))).agents.find(row => row.name === s.row.name)?.state).toBe(state);
  });
});
