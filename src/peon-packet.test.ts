import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packetIntake, packetLand, packetVerify, laneOpen, projectOpen } from "./ops.ts";
import { load, projectPath } from "./store.ts";
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
    expect(packet).toMatchObject({ state: "reported", checks: f.result.checks, peon: { box: "box1", peon: "peon1", base, head, exportReceipt: f.receipt } });
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
    expect(missing.packet.peon?.exportReceipt).toBeNull();
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
