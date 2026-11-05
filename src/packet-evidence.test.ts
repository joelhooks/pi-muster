import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Packet } from "./domain.ts";
import { basePathsExceptLanding, blindReviewNote, changedLines, evidenceNote, reviewBrief, staleEvidence } from "./packet-evidence.ts";
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
  const brainBeforeVerify = readdirSync(join(dir, ".brain"), { recursive: true }).sort();
  const verified = await runWith(h, packetVerify(dir, id));
  return { h, dir, row, id, brief, base, verified, brainBeforeVerify };
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
  it("skips only the landing frame and preserves exact NUL-delimited paths", () => {
    const a = "a".repeat(40), b = "b".repeat(40), empty = "c".repeat(40);
    const log = `${a}\0\0\nshared\0${empty}\0\0${b}\0\0\nplain\0${a}\0 spaced \0\nleading\0`;
    expect(basePathsExceptLanding(log, a)).toEqual(["plain", a, " spaced ", "\nleading"]);
    expect(basePathsExceptLanding(log, b)).toEqual(["shared"]);
    expect(basePathsExceptLanding(log, null)).toEqual(["shared", "plain", a, " spaced ", "\nleading"]);
    expect(basePathsExceptLanding("", null)).toEqual([]);
  });
  it("attributes paths to the next frame after an empty commit header", () => {
    const empty = "a".repeat(40), next = "b".repeat(40);
    const log = `${empty}\0\0${next}\0\0\nshared\0work\0`;
    expect(basePathsExceptLanding(log, empty)).toEqual(["shared", "work"]);
    expect(basePathsExceptLanding(log, next)).toEqual([]);
  });
  it("counts insertions and deletions and alarms only above 200", () => {
    expect(changedLines("100\t101\ta\n-\t-\tb\n")).toBe(201);
    expect(blindReviewNote(200, undefined)).toBeNull();
    expect(blindReviewNote(201, undefined)).toBe("no blind review recorded");
    expect(blindReviewNote(201, "/findings.md")).toBeNull();
  });
  it("caps UTF-8 review inputs with a visible cut", () => {
    const brief = reviewBrief({ packet: "hash", report: "report", diff: "é".repeat(100_000) });
    expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(60 * 1024);
    expect(brief).not.toContain("�");
    expect(brief).toContain("[cut:");
    expect(brief).toContain("What was not tested?");
  });
});

describe("blind review diff budget", () => {
  const patch = (path: string, content = "+new\n-old\n") =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${content}`;
  const render = (diff: string, extra = {}) => reviewBrief({ packet: "hash", report: "report", diff, ...extra });

  it("puts source ahead of 80 KiB of receipts and inventories their full counts", () => {
    const receipt = patch(".brain/data/receipts.jsonl", "+receipt\n".repeat(10_240));
    const source = patch("src/worker.ts");
    const input = receipt + source;
    const text = render(input);
    expect(text).toContain(source);
    expect(text).not.toContain("+receipt\n");
    expect(text).toContain('## Not shown');
    expect(text).toContain('".brain/data/receipts.jsonl": +10240 -0');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(60 * 1024);
    expect(render(input)).toBe(text);
  });

  it("keeps the head of an oversized source file, with full counts and a cut marker", () => {
    const text = render(patch("src/large.ts", "-old\n" + "+é🙂\n".repeat(15_000)));
    expect(text).toContain("diff --git a/src/large.ts b/src/large.ts");
    expect(text).toContain("+é🙂\n");
    expect(text).toContain('[cut: "src/large.ts" truncated]');
    expect(text).toContain('"src/large.ts": +15000 -1');
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(60 * 1024);
  });

  it("caps both prose sections without starving a 30 KiB source diff", () => {
    const source = patch("src/worker.ts", "+new\n".repeat(6_000));
    const text = render(source, { brief: "é".repeat(80_000), report: "🙂".repeat(80_000) });
    expect(text).toContain("[cut: lane brief capped at 12 KiB]");
    expect(text).toContain("[cut: packet report capped at 12 KiB]");
    expect(text).toContain(source);
    expect(text).not.toContain("Not shown");
    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(60 * 1024);
  });

  it("preserves small file content and git order inside each class", () => {
    const paths = [".brain/data/a.ts", "package-lock.json", "docs/guide.md", "tests/worker.ts", "src/a.test.ts", "lib/main.py", "src/z.ts", "src/clock.ts", "generated/a.ts", "config.json", "README.md"];
    const text = render(paths.map(path => patch(path)).join(""));
    const expected = ["lib/main.py", "src/z.ts", "src/clock.ts", "tests/worker.ts", "src/a.test.ts", "docs/guide.md", "README.md", ".brain/data/a.ts", "package-lock.json", "generated/a.ts", "config.json"].map(path => patch(path)).join("");
    expect(text.split("## Packet diff\n\n")[1]).toBe(expected + "\n");
    expect(text).not.toContain("[cut:");
    expect(text).not.toContain("Not shown");
  });

  it("cuts whole tail files and lists every omitted path, including deletions and renames", () => {
    const source = patch("src/worker.ts", "+new\n".repeat(7_000));
    const second = patch("tests/worker.ts", "+test\n".repeat(7_000));
    const deleted = 'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n';
    const renamed = 'diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\n';
    const text = render(source + second + deleted + renamed);
    expect(text).toContain(source);
    expect(text).not.toContain("diff --git a/tests/worker.ts");
    expect(text).not.toContain("[cut:");
    expect(text).toContain('"tests/worker.ts": +7000 -0');
    expect(text).toContain('"old.txt": +0 -2');
    expect(text).toContain('"new.md": +0 -0');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(60 * 1024);
  });

  it("names space-containing and quoted paths, and counts content resembling file headers", () => {
    const source = patch("src/worker.ts", "+new\n".repeat(7_000));
    const space = patch("docs/a b/file.md", "+++added\n---removed\n".repeat(3_000));
    const quoted = 'diff --git "a/docs/quoted\\\\t.md" "b/docs/quoted\\\\t.md"\n--- "a/docs/quoted\\\\t.md"\n+++ "b/docs/quoted\\\\t.md"\n@@ -1 +1 @@\n+new\n-old\n';
    const text = render(source + space + quoted);
    expect(text).toContain(source);
    expect(text).toContain('"docs/a b/file.md": +3000 -3000');
    expect(text).toContain(JSON.stringify("docs/quoted\\\\t.md") + ": +1 -1");
  });

  it("bounds an inventory larger than the entire review and names its overflow", () => {
    const text = render(Array.from({ length: 2_000 }, (_, i) => patch(`data/receipt-${i}.json`, "+receipt\n".repeat(20))).join(""));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(60 * 1024);
    expect(text).toContain("[cut: Not shown inventory exceeds review budget]");
  });
});

describe("packet evidence integration", () => {
  it("records base and changed paths, and writes a context-blind review brief", async () => {
    const s = await fixture();
    expect(s.verified.packet.verification).toMatchObject({ baseSha: s.base, paths: ["shared", "work"] });
    const file = join(s.h.home, ".local", "state", "muster", "reviews", "probe", `${s.id}.md`);
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
  it("keeps the brief in private owner state without adding files to the project Brain", async () => {
    const s = await fixture();
    const dir = join(s.h.home, ".local", "state", "muster", "reviews", "probe");
    const file = join(dir, `${s.id}.md`);
    expect(s.verified.reviewFile).toBe(file);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(s.dir, ".brain"), { recursive: true }).sort()).toEqual(s.brainBeforeVerify);
    // Re-verifying restores private modes and still adds nothing to the project's Brain.
    chmodSync(dir, 0o755); chmodSync(file, 0o644);
    await runWith(s.h, packetVerify(s.dir, s.id));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(s.dir, ".brain"), { recursive: true }).sort()).toEqual(s.brainBeforeVerify);
  });
  it.each([true, false])("alarms on overlapping moved inputs only (overlap=%s), without refusing", async overlap => {
    const s = await fixture(); advance(s, overlap);
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed" }));
    expect(result.packet.state).toBe("committed");
    if (overlap) {
      expect(result.note).toContain('evidence stale: refs/heads/main moved under "shared" (1 paths) since verify; pass gate or re-run packet_verify');
    } else expect(result.note).not.toContain("evidence stale:");
  });
  it.each([
    ["merge", "none"], ["merge", "before"], ["merge", "after"],
    ["squash", "none"], ["squash", "before"], ["squash", "after"],
  ] as const)("attested %s landing excludes its own paths, keeping foreign commits %s (plant: own landing)", async (kind, foreign) => {
    const s = await fixture();
    if (foreign === "before") advance(s, true);
    sh(s.dir, "fetch", "-q", s.row.cwd, s.id);
    if (kind === "merge") sh(s.dir, "merge", "--no-ff", "-qm", "packet landing", s.id);
    else { sh(s.dir, "merge", "--squash", s.id); sh(s.dir, "commit", "-qm", "packet squash landing"); }
    const landedAs = sh(s.dir, "rev-parse", "HEAD").trim();
    if (foreign === "after") advance(s, true);
    const original = s.h.proc;
    const seen: string[][] = [];
    s.h.proc = { run: (command, args, options) => {
      if (command === "git" && args[0] === "log") seen.push([...args]);
      return original.run(command, args, options);
    } };
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs: landedAs.slice(0, 12), attested: true, evidence: "owner checked packet landing" }));
    expect(result.packet).toMatchObject({ state: "committed", landedAs });
    expect(result.note).not.toContain("alarm unavailable");
    if (foreign === "none") expect(result.note).not.toContain("evidence stale:");
    else expect(result.note).toContain('moved under "shared" (1 paths) since verify');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(expect.arrayContaining(["--no-merges", `^${s.id}`]));
  });
  it("does not alarm when a gate actually runs", async () => {
    const s = await fixture(); advance(s, true);
    // Pin discovery as well as execution: the host may disable or lack fleet-compute.
    const runner = join(s.h.root, "fleet-compute.js");
    writeFileSync(runner, "// Execution is handled by the Proc fake.\n");
    const original = s.h.proc;
    const calls: string[][] = [];
    s.h.proc = { run: (command, args, options) => command === "node" && args[0] === runner
      ? Effect.sync(() => {
        calls.push([...args]);
        const value = (flag: string) => args[args.indexOf(flag) + 1]!;
        writeFileSync(value("--receipt"), JSON.stringify({ host: "gate-host", runId: "packet-evidence-gate", tree: value("--tree"), slot: 1, durationMs: 5, exit: 0 }));
        return { code: 0, stdout: "", stderr: "" };
      }) : original.run(command, args, options) };
    const saved = process.env.MUSTER_FLEET_COMPUTE;
    process.env.MUSTER_FLEET_COMPUTE = runner;
    try {
      const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", gate: "true" }));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.arrayContaining(["gate", "--receipt", "--tree"]));
      expect(calls[0]!.slice(-4)).toEqual(["--", "sh", "-c", "true"]);
      expect(result.packet.gate).toMatchObject({ runId: "packet-evidence-gate", tree: sh(s.dir, "rev-parse", "HEAD^{tree}").trim() });
      expect(result.note).not.toContain("evidence stale:");
    } finally {
      if (saved === undefined) delete process.env.MUSTER_FLEET_COMPUTE;
      else process.env.MUSTER_FLEET_COMPUTE = saved;
    }
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
      return command === "git" && args.includes(alarm === "stale" ? "log" : "diff") && args.includes(alarm === "stale" ? "--name-only" : "--numstat") && args.at(-1) === "--"
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
  it("keeps an attested landing live without reopening the clone when the packet object is absent", async () => {
    const s = await fixture(201);
    writeFileSync(join(s.dir, "work"), "ported packet plus other work\n"); sh(s.dir, "add", "work"); sh(s.dir, "commit", "-qm", "larger landing");
    const landedAs = sh(s.dir, "rev-parse", "HEAD").trim();
    const original = s.h.proc;
    s.h.proc = { run: (command, args, options) => {
      if (options.cwd === s.row.cwd || args.includes(s.row.cwd)) throw new Error("attested alarm reopened the worker clone");
      return original.run(command, args, options);
    } };
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", landedAs, attested: true, evidence: "owner checked the port" }));
    expect(result.packet.state).toBe("committed");
    expect(result.note).toContain("blind review alarm unavailable:");
  });
  it("does not warn on a small packet and rejects a relative review path before merging", async () => {
    const s = await fixture();
    expect((await failWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed", review: "findings.md" }))).message).toContain("absolute path");
    const result = await runWith(s.h, packetLand(s.dir, { id: s.id, outcome: "committed" }));
    expect(result.note).not.toContain("no blind review recorded");
    expect(result.note).not.toContain("evidence stale:");
  });
});
