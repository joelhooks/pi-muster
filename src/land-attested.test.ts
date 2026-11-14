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
    expect(calls.some(call => /patch-id|cat-file/.test(call))).toBe(false);
    // Advisory reads are allowed, but never a packet-content proof or a worker-clone read.
    expect(calls.filter(call => /diff /.test(call)).every(call => /--name-only|--numstat/.test(call))).toBe(true);
    expect(landed.note).not.toContain("evidence stale:");
    expect(landed.note).not.toContain("packet evidence alarm unavailable:");
    expect(sh(s.row.cwd, "rev-parse", "HEAD")).toBe(cloneHead);
    expect(sh(s.dir, "rev-parse", "HEAD")).toBe(sourceHead);
    expect((await runWith(s.h, load(s.dir))).agents.find(row => row.name === s.row.name)?.state).toBe("landed");
  });

  // KITT, 2026-10-12: walgit-only code never reaches origin, so packet_land fetched origin and refused.
  it("proves a landing on the remote the lane base names (walgit/<branch>), not origin", async () => {
    const s = await fixture(); await runWith(s.h, packetVerify(s.dir, s.id));
    const walgit = join(s.h.root, "walgit"); sh(s.h.root, "clone", "-q", "--bare", s.origin, walgit);
    sh(s.dir, "remote", "add", "walgit", walgit);
    const pushed = join(s.h.root, "pusher"); sh(s.h.root, "clone", "-q", walgit, pushed);
    sh(pushed, "fetch", "-q", s.row.cwd, s.id); sh(pushed, "checkout", "-qb", "central/landing", s.id); sh(pushed, "push", "-q", "origin", "central/landing");
    const err = await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, attested: true, evidence }));
    expect(err.message).toContain("fetch from origin did not resolve it");
    await runWith(s.h, laneOpen(s.dir, { slug: "probe", base: "walgit/central/landing" }));
    const landed = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, attested: true, evidence }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs: s.id, attested: true });
    expect(sh(s.dir, "rev-parse", "refs/remotes/walgit/central/landing").trim()).toBe(s.id);
  });

  // rats-nest, 2026-11-13: lane celld-063 starts from upstream's tag v0.6.3, so every landing fetched refs/heads/v0.6.3
  // and refused "against stale base refs". A tag base names the fix; the branch the lane lands on then proves it.
  it("refuses a tag lane base with the fix, and lands once the lane names its branch", async () => {
    const s = await fixture(); await runWith(s.h, packetVerify(s.dir, s.id));
    sh(s.origin, "tag", "v0.6.3"); sh(s.dir, "fetch", "-q", "--tags", "origin");
    sh(s.dir, "fetch", "-q", s.row.cwd, s.id); sh(s.dir, "branch", "ratking-063", s.id);
    for (const base of ["v0.6.3", "refs/tags/v0.6.3"]) {
      await runWith(s.h, laneOpen(s.dir, { slug: "probe", base }));
      // rift-merge's own land merges the clone branch and never fetches the base; pr-merge proves on it.
      for (const [mode, attested] of [["rift-merge", true], ["pr-merge", false]] as const) {
        await runWith(s.h, projectOpen({ dir: s.dir, mode }));
        const err = await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, attested, evidence }));
        expect(err.message).toContain("lane probe starts from the tag v0.6.3: a clone base, not a branch a packet lands on");
        expect(err.message).toContain(`base: "<remote>/<branch>"`);
        expect(err.message).not.toContain("stale base refs");
      }
    }
    await runWith(s.h, projectOpen({ dir: s.dir, mode: "rift-merge" }));
    await runWith(s.h, laneOpen(s.dir, { slug: "probe", base: "refs/heads/ratking-063" }));
    const landed = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, attested: true, evidence }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs: s.id, attested: true });
  });

  // imp, 2026-10-26: a local-only repo keeps an origin it never pushes, so a landing on its own main was refused.
  it("proves a landing on the source checkout's own base branch when origin never got it, and says so", async () => {
    const s = await fixture(); await runWith(s.h, packetVerify(s.dir, s.id));
    sh(s.dir, "fetch", "-q", s.row.cwd, s.id);
    const err = await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, attested: true, evidence }));
    expect(err.message).toContain(`${s.id} is not on base origin/main, nor on local main in ${s.dir}; merge it into main in the source checkout`);
    sh(s.dir, "merge", "-q", "--ff-only", s.id);
    const landed = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, attested: true, evidence }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs: s.id, attested: true });
    expect(landed.note).toContain(`${s.id.slice(0, 12)} is on local main, not on origin/main`);
  });

  // memory-steward, 2026-10-26: a walgit-only repo has no origin, so a landing on walgit/main was checked against local main.
  it("proves a landing on the only remote when the repo has no origin", async () => {
    const s = await fixture(); await runWith(s.h, packetVerify(s.dir, s.id));
    sh(s.dir, "remote", "rename", "origin", "walgit");
    sh(s.origin, "fetch", "-q", s.row.cwd, s.id); sh(s.origin, "merge", "-q", "--ff-only", s.id);
    const landed = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: s.id, attested: true, evidence }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs: s.id, attested: true });
    expect(landed.note).not.toContain("on local main");
    expect(sh(s.dir, "rev-parse", "refs/remotes/walgit/main").trim()).toBe(s.id);
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

  // front-desk, 2026-11-10: an attested landing stamped a separate sibling packet with a landedAs that never held it.
  it("uses an explicit lane base, leaves an unproven superseded packet open, and decodes old packets without a marker", async () => {
    const s = await fixture(); const landedAs = squash(s);
    sh(s.origin, "branch", "release", landedAs); sh(s.origin, "checkout", "-q", "main~1"); sh(s.origin, "branch", "-f", "main", "HEAD");
    const old = (await runWith(s.h, load(s.dir))).packets[0]!;
    expect(old).not.toHaveProperty("attested");
    const earlier = { ...old, id: "earlier-packet" };
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, lanes: project.lanes.map(lane => lane.slug === "probe" ? { ...lane, base: "release" } : lane), packets: [earlier, { ...old, supersedes: earlier.id }] }, undefined] as const)));
    const landed = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }));
    const [first, second] = (await runWith(s.h, load(s.dir))).packets;
    expect(second).toMatchObject({ state: "committed", attested: true, landedAs });
    expect(second?.evidence).toContain("owner-attested: landed inside");
    expect(first).toMatchObject({ state: old.state, landedAs: null });
    expect(landed.note).toContain(`left earlier-pack ${old.state}: its commit is not proven inside ${s.id.slice(0, 12)}`);
  });

  it("marks a superseded packet whose commit the landed packet builds on", async () => {
    const s = await fixture();
    writeFileSync(join(s.row.cwd, "work"), "one\ntwo\n"); sh(s.row.cwd, "commit", "-qam", "follow-up");
    const next = sh(s.row.cwd, "rev-parse", "HEAD").trim();
    await runWith(s.h, packetReport({ dir: s.dir, agent: s.row.name, owner: s.row.owner, cwd: s.row.cwd, commit: next, summary: "follow-up", checks: [] }));
    sh(s.origin, "fetch", "-q", s.row.cwd, next); sh(s.origin, "merge", "--squash", next); sh(s.origin, "commit", "-qm", "squash both");
    const landedAs = sh(s.origin, "rev-parse", "HEAD").trim();
    sh(s.dir, "fetch", "-q", s.row.cwd, next);
    const landed = await runWith(s.h, packetLand(s.dir, { id: next, outcome: "committed", landedAs, attested: true, evidence }));
    const packets = (await runWith(s.h, load(s.dir))).packets;
    expect(packets.find(packet => packet.id === next)).toMatchObject({ supersedes: s.id, state: "committed", landedAs });
    expect(packets.find(packet => packet.id === s.id)).toMatchObject({ state: "committed", attested: true, landedAs });
    expect(landed.note).not.toContain("left ");
  });

  it("proves a landing on the default branch when the lane base is a sha", async () => {
    const s = await fixture(); const landedAs = squash(s);
    await runWith(s.h, laneOpen(s.dir, { slug: "probe", base: sh(s.origin, "rev-parse", "HEAD~1").trim() }));
    const landed = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs, attested: true });
  });

  // rubicon-fitness and memory-steward, 2026-10-26: a short sha base read as a branch, "fetch origin/33f86832 failed".
  it("proves a landing on the default branch when the lane base is a short sha", async () => {
    const s = await fixture(); const landedAs = squash(s);
    await runWith(s.h, laneOpen(s.dir, { slug: "probe", base: sh(s.origin, "rev-parse", "--short=8", "HEAD~1").trim() }));
    const landed = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }));
    expect(landed.packet).toMatchObject({ state: "committed", landedAs, attested: true });
  });

  it("refuses a sha-base landing that is not on the default branch", async () => {
    const s = await fixture(); const landedAs = squash(s);
    sh(s.origin, "branch", "unlanded", landedAs); sh(s.origin, "checkout", "-q", "main~1"); sh(s.origin, "branch", "-f", "main", "HEAD");
    await runWith(s.h, laneOpen(s.dir, { slug: "probe", base: sh(s.origin, "rev-parse", "HEAD").trim() }));
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence }))).message).toContain("not on base origin/main");
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
