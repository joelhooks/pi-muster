import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectDigest } from "./digest.ts";
import { packetIntake, packetLand, packetVerify, laneClose, laneOpen, projectOpen, projectReview, projectStatus } from "./ops.ts";
import { withPeonLandLock } from "./peon-packet.ts";
import { guardCatalogWriter, load, projectPath } from "./store.ts";
import { failWith, harness, makeRepo, runWith, sh } from "./test-support.ts";

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fixtures: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(laneBase = "refs/heads/main") {
  vi.stubEnv("MUSTER_PROJECT", undefined);
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const h = harness(); fixtures.push(h.root);
  const origin = makeRepo(join(h.root, "offline-origin"));
  const repo = join(h.root, "source");
  const box = join(h.root, "box");
  sh(h.root, "clone", "-q", origin, repo);
  sh(h.root, "clone", "-q", origin, box);
  const base = sh(repo, "rev-parse", "HEAD").trim();
  const bundle = join(h.root, "output.bundle");
  const add = (path: string, text: string) => {
    writeFileSync(join(box, path), text);
    sh(box, "add", path); sh(box, "commit", "-qm", path);
    return sh(box, "rev-parse", "HEAD").trim();
  };
  const head = add("work.txt", "offline work\n");
  const exportBundle = (...refs: string[]) => { sh(box, "bundle", "create", bundle, ...refs); return { path: bundle, sha256: digest(bundle) }; };
  // Deny any remote Git transport during Muster operations, including a file:// origin.
  const proc = h.proc;
  h.proc = { run: (command, args, options) => {
    if (command === "git" && args.some(arg => arg === "fetch" || arg === "push" || arg === "ls-remote")) throw new Error(`unexpected transport: ${args.join(" ")}`);
    return proc.run(command, args, options);
  } };
  const dir = repo;
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "test", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true, mode: "rift-merge" }));
  const lane = "probe";
  await runWith(h, laneOpen(dir, { slug: lane, label: lane, goal: "test", base: laneBase }));
  const receipt = { id: "peon1/20261122T000000Z-box1", sha256: "a".repeat(64), location: join(h.root, "permanent", "RECEIPT.json"), mirror: join(h.root, "mirror", "RECEIPT.json") };
  const result = { repo, base, head, bundle: exportBundle("main", `^${base}`), box: "box1", peon: "peon1", summary: "Adds offline work", checks: [{ name: "unit", outcome: "pass" as const, detail: "one pass" }], exportReceipt: receipt };
  const intake = (change: Partial<typeof result> = {}) => runWith(h, packetIntake(dir, { lane, result: { ...result, ...change } }));
  const land = (id: string, gate?: string) => packetLand(dir, { id, outcome: "committed", gate });
  return { h, dir, box, lane, base, head, result, intake, land, add, exportBundle, receipt };
}

describe("peon packet intake", () => {
  it("verifies and lands a thin bundle without a worker row; repeats are byte-for-byte no-ops", async () => {
    const f = await fixture();
    const { h, dir, base, head } = f;
    const { packet } = await f.intake();
    expect(packet).toMatchObject({ state: "reported", checks: f.result.checks, peon: { box: "box1", peon: "peon1", base, head, exportReceipts: [{ ...f.receipt, attachedAt: h.now.toISOString() }] } });
    expect(dirname(packet.report)).toBe(join(dir, ".brain", "data", "muster", "reports", f.lane));
    const report = readFileSync(packet.report, "utf8");
    expect(report).toContain("Adds offline work");
    expect(report).toContain(f.receipt.id);
    expect(existsSync(join(h.root, "clones"))).toBe(false);
    const before = readFileSync(projectPath(dir), "utf8");
    expect((await runWith(h, load(dir))).writerSchemaVersion).toBe(8);
    expect((await runWith(h, load(dir))).agents).toEqual([]);
    h.now = new Date(h.now.getTime() + 60_000);
    expect(await f.intake({ summary: "Do not overwrite", bundle: { ...f.result.bundle, path: join(h.root, "gone.bundle") } })).toEqual({ packet, repeated: true, note: null });
    expect(readFileSync(projectPath(dir), "utf8")).toBe(before);
    expect(readFileSync(packet.report, "utf8")).toBe(report);
    expect(await failWith(h, f.land(packet.id))).toMatchObject({ _tag: "GuardFailed", guard: "verified" });

    const verified = await runWith(h, packetVerify(dir, packet.id));
    expect(verified.checks.map(check => [check.name, check.outcome])).toEqual([
      ["bundle sha256", "pass"], ["bundle head", "pass"], ["head ancestry", "pass"], ["base reachability", "pass"], ["report file", "pass"],
    ]);
    expect(verified.packet.verification).toMatchObject({ baseSha: base, paths: ["work.txt"] });
    expect(readFileSync(verified.reviewFile!, "utf8")).toContain("+offline work");
    expect(sh(dir, "rev-parse", "HEAD").trim()).toBe(base);
    expect(sh(dir, "cat-file", "--batch-check", "--batch-all-objects").includes(head)).toBe(false);

    const landed = await runWith(h, f.land(packet.id, "test -f work.txt"));
    expect(landed.packet.state).toBe("committed");
    expect(sh(dir, "show", "-s", "--format=%P%n%an%n%cn", "HEAD").trim()).toBe(`${base} ${head}\nshitratgit[bot]\nshitratgit[bot]`);
    expect(readFileSync(join(dir, "work.txt"), "utf8")).toBe("offline work\n");
    expect((await runWith(h, load(dir))).lanes.find(lane => lane.slug === f.lane)?.delivery).toBe("landed");
    const catalog = readFileSync(projectPath(dir), "utf8");
    rmSync(f.result.bundle.path);
    expect((await runWith(h, f.land(packet.id, "exit 77"))).packet).toEqual(landed.packet);
    expect((await f.intake()).packet).toEqual(landed.packet);
    expect(readFileSync(projectPath(dir), "utf8")).toBe(catalog);
    expect(sh(dir, "rev-parse", "HEAD").trim()).toBe(landed.packet.landedAs);
  });

  it("uses both box and head as identity, and records missing custody without blocking landing", async () => {
    const f = await fixture();
    const { h, dir, lane, result } = f;
    const { exportReceipt: _receipt, ...withoutReceipt } = result;
    const missing = await runWith(h, packetIntake(dir, { lane, result: withoutReceipt }));
    expect(missing.note).toContain("destroy blocked");
    expect(missing.packet.peon?.exportReceipts).toEqual([]);
    expect(readFileSync(missing.packet.report, "utf8")).toContain("destroy blocked");
    const anotherBox = await f.intake({ box: "box2" });
    expect(anotherBox.packet.id).not.toBe(missing.packet.id);
    await runWith(h, packetVerify(dir, missing.packet.id));
    const landed = await runWith(h, f.land(missing.packet.id));
    expect(landed.packet.state).toBe("committed");
    expect(landed.notes).toContainEqual(expect.stringContaining("destroy blocked"));
    const nextHead = f.add("follow-up", "more\n");
    const anotherHead = await f.intake({ head: nextHead, bundle: f.exportBundle("main", `^${f.head}`) });
    expect(anotherHead.packet.id).not.toBe(missing.packet.id);
  });

  it("shows the rowless packet in status, the Brain board, digest and retro, and drains the lane until its outcome", async () => {
    const f = await fixture();
    const { h, dir, lane } = f;
    const { packet } = await f.intake();
    const status = await runWith(h, projectStatus(dir, { act: true }));
    expect(status.agents).toEqual([]);
    expect(status.board).toContain(`packets waiting: ${packet.id.slice(0, 10)} peon:peon1 reported`);
    const brain = status.notes.find(note => note.startsWith("brain: "))?.slice("brain: ".length);
    expect(readFileSync(brain!, "utf8")).toContain("| peon:peon1 | reported |");
    const digest = await projectDigest(dir, { now: h.now, env: { HOME: h.home, MUSTER_FLEET_COMPUTE: "off" }, available: async () => false, run: async () => '{"slots":0,"holders":[]}' });
    expect(digest.parts.packets).toMatchObject({ state: "ok", text: expect.stringContaining("packets 1 to land") });
    expect(digest.parts.agents).toMatchObject({ state: "ok", text: "agents 0 work 0 idle 0 stale" });
    expect(await runWith(h, laneClose(dir, lane))).toMatchObject({ closed: false, lane: { state: "draining" }, pending: [`packet ${packet.id.slice(0, 12)} is reported`] });
    await runWith(h, packetLand(dir, { id: packet.id, outcome: "rejected", evidence: "fixture" }));
    expect(await runWith(h, laneClose(dir, lane))).toMatchObject({ closed: true });
    const review = await runWith(h, projectReview(dir, { note: "rowless retro" }));
    expect(review.retroLanes).toContainEqual({ slug: lane, reports: [packet.report], sessionFiles: [], closedTails: [] });
  });

  it("attaches ordered custody receipts after landing without letting a stale replay supersede the current receipt", async () => {
    const f = await fixture();
    const { h, dir, lane } = f;
    const { exportReceipt: first, ...withoutReceipt } = f.result;
    const { packet } = await runWith(h, packetIntake(dir, { lane, result: withoutReceipt }));
    expect(readFileSync(packet.report, "utf8")).toContain("destroy blocked");
    await runWith(h, packetVerify(dir, packet.id));
    const landed = await runWith(h, f.land(packet.id));
    expect(landed.notes).toContainEqual(expect.stringContaining("destroy blocked"));
    h.now = new Date(h.now.getTime() + 60_000);
    const firstTime = h.now.toISOString();
    const firstAttach = await f.intake();
    expect(firstAttach.note).toContain("attached permanent raw-session export receipt");
    expect(firstAttach.packet).toMatchObject({ state: "committed", landedAs: landed.packet.landedAs, peon: { exportReceipts: [{ ...first, attachedAt: firstTime }] } });
    expect(readFileSync(packet.report, "utf8")).not.toContain("destroy blocked");
    expect((await runWith(h, f.land(packet.id))).notes).toEqual([]);
    const second = { ...first, id: "peon1/20261122T010000Z-box1", sha256: "b".repeat(64) };
    h.now = new Date(h.now.getTime() + 60_000);
    const secondAttach = await f.intake({ exportReceipt: second });
    expect(secondAttach.packet.peon?.exportReceipts).toEqual([{ ...first, attachedAt: firstTime }, { ...second, attachedAt: h.now.toISOString() }]);
    const report = readFileSync(packet.report, "utf8");
    expect(report).toContain(second.id);
    expect(report).not.toContain(first.id);
    expect(report).toContain("Adds offline work");
    const catalog = readFileSync(projectPath(dir), "utf8");
    expect((await f.intake({ exportReceipt: first })).packet).toEqual(secondAttach.packet);
    expect(readFileSync(projectPath(dir), "utf8")).toBe(catalog);
    expect(readFileSync(packet.report, "utf8")).toBe(report);
  });

  it("refuses replay with a conflicting lane, repo or bundle hash", async () => {
    const f = await fixture();
    const { h, dir, lane, result } = f;
    await f.intake();
    const catalog = readFileSync(projectPath(dir), "utf8");
    for (const [field, value] of [
      ["lane", { lane: "wrong", result }],
      ["repo", { lane, result: { ...result, repo: f.box } }],
      ["bundle sha256", { lane, result: { ...result, bundle: { ...result.bundle, sha256: "b".repeat(64) } } }],
    ] as const) {
      expect(await failWith(h, packetIntake(dir, value))).toMatchObject({ _tag: "GuardFailed", guard: "peon-intake-conflict", message: expect.stringContaining(`intake ${field} conflicts`) });
    }
    expect(readFileSync(projectPath(dir), "utf8")).toBe(catalog);
  });

  it.each(["rejected", "no_changes"] as const)("records %s without needing a verified bundle and only replays the same outcome", async outcome => {
    const f = await fixture();
    const { packet } = await f.intake();
    rmSync(f.result.bundle.path);
    const land = packetLand(f.dir, { id: packet.id, outcome, evidence: "checked in the desk" });
    const landed = await runWith(f.h, land);
    expect(landed.packet).toMatchObject({ state: outcome, landedAs: null, evidence: "checked in the desk" });
    expect((await runWith(f.h, land)).packet).toEqual(landed.packet);
    const before = readFileSync(projectPath(f.dir), "utf8");
    expect(await failWith(f.h, f.land(packet.id))).toMatchObject({ _tag: "InputError", message: expect.stringContaining(`already ${outcome}`) });
    expect(readFileSync(projectPath(f.dir), "utf8")).toBe(before);
    expect(sh(f.dir, "rev-parse", "HEAD").trim()).toBe(f.base);
  });

  it("audits a correction to a terminal peon packet and does not require an agent row", async () => {
    const f = await fixture();
    const { packet } = await f.intake();
    await runWith(f.h, packetVerify(f.dir, packet.id));
    const landed = await runWith(f.h, f.land(packet.id));
    expect(await failWith(f.h, packetLand(f.dir, { id: packet.id, outcome: "rejected" }))).toMatchObject({ _tag: "InputError", message: expect.stringContaining("already committed") });
    const correction = { id: packet.id, corrects: "The recorded outcome was incorrect." };
    f.h.sessionId = "different-session";
    expect(await failWith(f.h, packetLand(f.dir, correction))).toMatchObject({ _tag: "GuardFailed", guard: "packet-owner" });
    const reopened = await runWith(f.h, packetLand(f.dir, { ...correction, takeover: true }));
    expect(reopened.packet).toMatchObject({ state: "verified", landedAs: null, gate: null, peon: landed.packet.peon });
    const audit = JSON.parse(readFileSync(join(f.dir, ".brain", "data", "muster", "corrections.jsonl"), "utf8"));
    expect(audit).toMatchObject({ packetId: packet.id, from: { state: "committed", landedAs: landed.packet.landedAs }, by: "different-session", reason: correction.corrects });
    expect((await runWith(f.h, packetLand(f.dir, { id: packet.id, outcome: "rejected" }))).packet.state).toBe("rejected");
    expect(sh(f.dir, "rev-parse", "HEAD").trim()).toBe(landed.packet.landedAs);
  });

  it("fences a schema-7 writer from a persisted peon catalog without changing it", async () => {
    const f = await fixture();
    await f.intake();
    const path = projectPath(f.dir);
    const catalog = readFileSync(path, "utf8");
    const { writerSchemaVersion } = await runWith(f.h, load(f.dir));
    expect(writerSchemaVersion).toBe(8);
    const fence = await failWith(f.h, guardCatalogWriter(path, writerSchemaVersion ?? 0, 7));
    expect(fence).toMatchObject({ _tag: "StoreError", message: expect.stringContaining("schema 8 > 7") });
    expect(readFileSync(path, "utf8")).toBe(catalog);
  });

  it("reclaims a dead landing claim but does not steal a live one", async () => {
    const f = await fixture();
    const { packet } = await f.intake();
    await runWith(f.h, packetVerify(f.dir, packet.id));
    const lock = join(f.dir, ".git", "muster-peon-land.lock");
    mkdirSync(lock);
    const live = join(lock, `${process.pid}-${randomUUID()}`);
    mkdirSync(live);
    expect(await failWith(f.h, f.land(packet.id))).toMatchObject({ _tag: "GuardFailed", guard: "peon-land-lock" });
    expect(readdirSync(lock)).toEqual([live.split("/").at(-1)]);
    rmSync(live, { recursive: true });
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.status).toBe(0);
    const stale = join(lock, `${dead.pid}-${randomUUID()}`);
    mkdirSync(stale);
    expect((await runWith(f.h, f.land(packet.id))).packet.state).toBe("committed");
    expect(readdirSync(lock)).toEqual([]);
  });

  it("does not replace the result when releasing its landing claim fails", async () => {
    const f = await fixture();
    const gitDir = join(f.dir, ".git");
    const lock = join(gitDir, "muster-peon-land.lock");
    const operation = Effect.sync(() => {
      const [claim] = readdirSync(lock);
      writeFileSync(join(lock, claim!, "release-fails-while-nonempty"), "fixture\n");
      return { landedAs: f.head };
    });
    expect(await runWith(f.h, withPeonLandLock(gitDir, operation))).toEqual({ landedAs: f.head });
  });

  it("copies bundle proof scratch only under the source Git dir and removes it", async () => {
    const f = await fixture();
    const { packet } = await f.intake();
    const proc = f.h.proc;
    const snapshots: string[] = [];
    f.h.proc = { run: (command, args, options) => {
      if (command === "git" && args[0] === "bundle") snapshots.push(args.at(-1)!);
      return proc.run(command, args, options);
    } };
    await runWith(f.h, packetVerify(f.dir, packet.id));
    await runWith(f.h, f.land(packet.id));
    expect(new Set(snapshots).size).toBe(2);
    for (const file of snapshots) {
      expect(file).toMatch(/^.*\/\.git\/muster-peon-bundle-[^/]+\/packet\.bundle$/);
      expect(dirname(dirname(file))).toBe(join(f.dir, ".git"));
      expect(existsSync(dirname(file))).toBe(false);
    }
  });

  it.each([
    ["bundle sha256", /mismatch; restore the exact bundle/],
    ["bundle head", /not advertised by the bundle; rerun.*export/],
    ["head ancestry", /does not descend from base; rerun/],
    ["base reachability", /base is unknown or not reachable.*sync the local source refs/],
    ["report file", /missing or unreadable; restore the recorded report/],
  ] as const)("refuses %s with a typed next step", async (name, fix) => {
    const f = await fixture();
    const { h, dir, box, base, result } = f;
    const edits: Partial<typeof result> = {};
    if (name === "bundle sha256") edits.bundle = { ...result.bundle, sha256: "0".repeat(64) };
    if (name === "bundle head") edits.head = base; // Already in the source, but not an advertised head in the bundle.
    if (name === "head ancestry") {
      writeFileSync(join(dir, "owner.txt"), "owner\n");
      sh(dir, "add", "owner.txt"); sh(dir, "commit", "-qm", "owner-only sibling");
      edits.base = sh(dir, "rev-parse", "HEAD").trim();
    }
    if (name === "base reachability") {
      edits.base = f.head; // A real ancestor in the bundle, absent from the source.
      edits.head = f.add("second", "second\n");
      edits.bundle = f.exportBundle("main");
      expect(sh(box, "merge-base", edits.base, edits.head).trim()).toBe(edits.base);
    }
    const { packet } = await f.intake(edits);
    if (name === "report file") rmSync(packet.report);
    const error = await failWith(h, packetVerify(dir, packet.id));
    expect(error).toMatchObject({ _tag: "PacketCheckFailed", message: expect.stringMatching(fix), failures: [expect.stringContaining(name)] });
    expect((await runWith(h, load(dir))).packets[0]?.state).toBe("reported");
  });

  it("accepts the repo default branch when the lane base does not contain the recorded base", async () => {
    const f = await fixture("refs/heads/not-held-here");
    const bundle = f.exportBundle("main");
    const { packet } = await f.intake({ bundle });
    const result = await runWith(f.h, packetVerify(f.dir, packet.id));
    expect(result.checks.find(check => check.name === "base reachability")?.detail).toContain("refs/remotes/origin/main");
  });

  it("refuses a dirty source without importing the head or modifying owner work", async () => {
    const f = await fixture();
    const { packet } = await f.intake();
    await runWith(f.h, packetVerify(f.dir, packet.id));
    const work = join(f.dir, "README.md");
    writeFileSync(work, "owner's dirty file\n");
    expect(await failWith(f.h, f.land(packet.id))).toMatchObject({ _tag: "GuardFailed", guard: "clean-source" });
    expect(readFileSync(work, "utf8")).toBe("owner's dirty file\n");
    expect(sh(f.dir, "cat-file", "--batch-check", "--batch-all-objects")).not.toContain(f.head);
  });

  it("rechecks the exact bundle before merging even after verification", async () => {
    const f = await fixture();
    const { packet } = await f.intake();
    await runWith(f.h, packetVerify(f.dir, packet.id));
    writeFileSync(f.result.bundle.path, "not the verified bundle\n");
    expect(await failWith(f.h, f.land(packet.id))).toMatchObject({ _tag: "PacketCheckFailed", message: expect.stringContaining("sha256 mismatch") });
    expect(sh(f.dir, "rev-parse", "HEAD").trim()).toBe(f.base);
    expect((await runWith(f.h, load(f.dir))).packets[0]?.state).toBe("verified");
  });

  it("leaves the source and report verified on gate failure and allows retry", async () => {
    const f = await fixture();
    const { packet } = await f.intake();
    await runWith(f.h, packetVerify(f.dir, packet.id));
    expect(await failWith(f.h, f.land(packet.id, "test -f work.txt && exit 42"))).toMatchObject({ _tag: "GuardFailed", guard: "gate", message: expect.stringContaining("exit 42") });
    expect(sh(f.dir, "rev-parse", "HEAD").trim()).toBe(f.base);
    expect(existsSync(join(f.dir, "work.txt"))).toBe(false);
    expect(existsSync(join(f.dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect((await runWith(f.h, f.land(packet.id))).packet.state).toBe("committed");
  });
});
