import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { decodeProject } from "./domain.ts";
import { digestLine, gatesPart, kodiakPart, mainPart, projectDigest, pullPart } from "./digest.ts";
import type { DigestOptions } from "./digest.ts";
import { runDigest } from "../bin/muster-digest.ts";

const now = new Date("2026-10-04T16:15:00Z");
const at = "2026-10-04T16:01:00Z";
const pull = { number: 1, isDraft: false, createdAt: "2026-10-04T16:07:00Z", labels: [], autoMergeRequest: null, mergeStateStatus: "CLEAN", statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] };
const pulls = JSON.stringify([pull, { ...pull, number: 2, statusCheckRollup: [{ context: "ci", state: "PENDING" }] }, { ...pull, number: 3, statusCheckRollup: [{ conclusion: "FAILURE" }] }, { ...pull, number: 4, isDraft: true }]);
const gates = { slots: 4, holders: [{ held: true }, { held: true }, { held: true }, { held: false }], queue: [{}], deploySlot: { held: false }, exclusivePending: { held: true } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "muster-digest-"));
  const project = decodeProject({ version: 1, slug: "drovr", label: "drovr", dir, outcome: "o", reviewTrigger: "r", criticalPath: [], nextAction: "n", mode: "rift-merge", spaceId: null, sidebar: "off", ephemeral: true, musterExtension: null, deskExtension: null, cadenceMinutes: null, state: "active", lanes: [], agents: [], packets: [], reviews: [], createdAt: at, updatedAt: at });
  const state = join(dir, ".brain/data/muster");
  mkdirSync(state, { recursive: true });
  const path = join(state, "project.json");
  writeFileSync(path, JSON.stringify(project));
  return { dir, project, path };
}
function runner(remote = true): NonNullable<DigestOptions["run"]> {
  return vi.fn(async (command, args) => {
    if (command === "git") return remote ? "origin\tgit@github.com:badass-courses/drovr.git (fetch)\n" : "";
    if (args[0] === "pr") return pulls;
    if (args[0] === "repo") return JSON.stringify({ defaultBranchRef: { name: "trunk" } });
    if (args[0] === "run") return JSON.stringify([{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "success" }]);
    return JSON.stringify(gates);
  });
}
const options = (run = runner()): DigestOptions => ({ now, run, available: async c => c !== "fleet-compute", env: {} });

describe("digest parsers", () => {
  it("counts non-draft ready, pending, failing checks and blocked merge states", () => {
    expect(pullPart(pulls).text).toBe("PRs 3 ready ✅1 ⏳1 ❌1");
    expect(pullPart(JSON.stringify([{ ...pull, mergeStateStatus: "BLOCKED" }])).text).toContain("✅0 ⏳1");
    expect(pullPart(JSON.stringify([{ ...pull, statusCheckRollup: [{ conclusion: "SKIPPED" }] }])).text).toContain("✅1");
    expect(() => pullPart("{}")).toThrow();
  });
  it("infers Kodiak intent from labels or auto-merge and excludes a rejected Kodiak context", () => {
    const text = JSON.stringify([
      { ...pull, labels: [{ name: "ship" }], statusCheckRollup: [{ context: "kodiakhq", state: "PENDING", createdAt: "2026-10-04T16:09:00Z" }] },
      { ...pull, number: 2, autoMergeRequest: {}, createdAt: "2026-10-04T16:07:00Z" },
      { ...pull, number: 3, labels: [{ name: "ship" }], statusCheckRollup: [{ context: "kodiakhq", state: "FAILURE" }] },
      { ...pull, number: 4, isDraft: true, autoMergeRequest: {} },
    ]);
    expect(kodiakPart(text, "ship", now).text).toBe("kodiak 2 (8m)");
    expect(kodiakPart(text, "automerge", now).text).toBe("kodiak 1 (8m)");
  });
  it("shows latest completed CI, or running when none completed", () => {
    expect(mainPart('[{"status":"completed","conclusion":"failure"}]').text).toBe("main ❌");
    expect(mainPart('[{"status":"in_progress","conclusion":null},{"status":"completed","conclusion":"success"}]').text).toBe("main ✅");
    expect(mainPart('[{"status":"queued","conclusion":null}]').text).toBe("main running");
    expect(mainPart("[]").text).toBe("main –");
  });
  it("parses local and fleet slots, queues and deploy windows", () => {
    expect(gatesPart(JSON.stringify(gates), false).text).toBe("gates 3/4 q1 deploy");
    expect(gatesPart(JSON.stringify({ machines: [{ reading: { state: "live", data: { slots: 4, holders: [{ held: true }] } } }, { reading: { state: "live", data: { load: 1 } } }], queue: [{}, {}], leases: { leases: [{ state: "active" }] } }), true).text).toBe("gates 1/4 q2 deploy");
    expect(() => gatesPart('{"slots":-1,"holders":[]}', false)).toThrow();
    expect(() => gatesPart('{"machines":[{"reading":{"state":"unavailable"}}],"queue":[],"leases":{"leases":[]}}', true)).toThrow("unavailable");
  });
});

describe("project digest", () => {
  it("reads ages, catalog states, silence policy and unlanded packets without writing", async () => {
    const { dir, project, path } = fixture();
    const session = join(dir, "session.jsonl");
    writeFileSync(session, "unchanged\n"); utimesSync(session, now, new Date("2026-10-04T16:03:00Z"));
    const agent = { name: "worker", role: "worker", lane: "work", cwd: dir, clone: null, profile: { label: "worker", model: "m", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: null }, sessionId: "worker-1", sessionFile: session, parentSessionFile: null, pane: null, owner: "o", brief: null, state: "running", delivery: "proven", restarts: 0, restore: null, createdAt: at, updatedAt: now.toISOString() };
    const packet = { id: "abc", kind: "commit", lane: "work", agent: "worker", artifact: null, report: "/report", checks: [], state: "reported", verification: null, landedAs: null, reportedAt: at, updatedAt: at };
    writeFileSync(path, JSON.stringify({ ...project, policy: { nudgeAfterMin: 10 }, agents: [agent, { ...agent, name: "fresh", sessionFile: null }, { ...agent, name: "idle", state: "reported" }, { ...agent, name: "gone", state: "closed" }], packets: [packet, { ...packet, id: "def", state: "verified" }, { ...packet, id: "landed", state: "committed" }] }));
    const before = readFileSync(path, "utf8");
    const result = await projectDigest(dir, options());
    expect(result.parts.agents.text).toBe("agents 1 work 1 idle 1 stale");
    expect(result.parts.packets.text).toBe("packets 2 to land (14m)");
    expect(result.notes).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(session, "utf8")).toBe("unchanged\n");
  });
  it("isolates a command failure from all other parts", async () => {
    const base = runner();
    const result = await projectDigest(fixture().dir, options(async (command, args, opts) => { if (args[0] === "run") throw new Error("CI unavailable"); return base(command, args, opts); }));
    expect(result.parts.main.text).toBe("main ?");
    expect(result.parts.prs.state).toBe("ok");
    expect(result.parts.gates.state).toBe("ok");
    expect(result.notes.join(" ")).toContain("CI unavailable");
  });
  it("treats a GitHub repo without workflow runs as no CI, not failure", async () => {
    const base = runner();
    const result = await projectDigest(fixture().dir, options(async (command, args, opts) => args[0] === "run" ? "[]" : base(command, args, opts)));
    expect(result.parts.main.text).toBe("main –");
    expect(result.parts.main.state).toBe("ok");
    expect(result.notes).toEqual([]);
  });
  it("bounds a hung source and aborts its runner", async () => {
    let signal: AbortSignal | undefined;
    const base = runner();
    const result = await projectDigest(fixture().dir, { ...options(async (command, args, opts) => { if (args[0] === "run") { signal = opts.signal; return new Promise(() => {}); } return base(command, args, opts); }), timeoutMs: 30 });
    expect(result.parts.main.state).toBe("unknown");
    expect(signal?.aborted).toBe(true);
    expect(result.parts.agents.state).toBe("ok");
    expect(result.notes.join(" ")).toContain("Timeout");
  });
  it("skips GitHub cleanly with no remote or no gh", async () => {
    for (const noRemote of [true, false]) {
      const run = runner(!noRemote);
      const result = await projectDigest(fixture().dir, { ...options(run), available: async c => c === "muster-heavy" });
      expect(result.parts.prs.state).toBe("skipped");
      expect(result.parts.main.state).toBe("skipped");
      expect(result.line).not.toContain("PRs");
      expect(result.notes.join(" ")).toContain("GitHub skipped");
      expect(vi.mocked(run).mock.calls.some(([cmd]) => cmd === "gh")).toBe(false);
    }
  });
  it("respects fleet off and falls back to packaged heavy bin", async () => {
    const run = runner(false);
    const result = await projectDigest(fixture().dir, { ...options(run), env: { MUSTER_FLEET_COMPUTE: "off" }, available: async c => c === "fleet-compute" });
    expect(result.parts.gates.text).toBe("gates 3/4 q1 deploy");
    expect(vi.mocked(run).mock.calls.some(([cmd]) => cmd === "fleet-compute")).toBe(false);
    expect(vi.mocked(run).mock.calls.some(([cmd, args]) => cmd === process.execPath && args[0]?.endsWith("muster-heavy.ts"))).toBe(true);
  });
  it("reads Kodiak config (including a first-line merge table) and uses default branch", async () => {
    const { dir } = fixture();
    writeFileSync(join(dir, ".kodiak.toml"), '[merge]\nautomerge_label = "ship"\n');
    const base = runner();
    const run = vi.fn<NonNullable<DigestOptions["run"]>>(async (command, args, opts) => args[0] === "pr" ? JSON.stringify([{ ...pull, labels: [{ name: "ship" }] }]) : base(command, args, opts));
    const result = await projectDigest(dir, options(run));
    expect(result.parts.kodiak.text).toBe("kodiak 1 (8m)");
    expect(run.mock.calls.find(([, args]) => args[0] === "run")?.[1]).toContain("trunk");
    expect(run.mock.calls.find(([, args]) => args[0] === "pr")?.[1]).toContain("badass-courses/drovr");
  });
  it("fits 160 and 100 columns, even with a long Unicode header", async () => {
    const result = await projectDigest(fixture().dir, options());
    for (const width of [160, 100]) {
      expect(visibleWidth(digestLine("drovr 16:15", result.parts, width))).toBeLessThanOrEqual(width);
      expect(visibleWidth(digestLine("🐑".repeat(200), result.parts, width))).toBeLessThanOrEqual(width);
    }
    const full = digestLine("drovr 16:15", result.parts, 160);
    const narrow = digestLine("drovr 16:15", result.parts, 100);
    expect(full).toContain("agents");
    expect(narrow).not.toContain(" ready ");
    expect(narrow).not.toContain("\n");
  });
  it("keeps other sources when catalog or JSON is broken", async () => {
    const { dir, path } = fixture(); writeFileSync(path, "{}");
    const result = await projectDigest(dir, options());
    expect(result.parts.agents.state).toBe("unknown");
    expect(result.parts.packets.state).toBe("unknown");
    expect(result.parts.prs.state).toBe("ok");
    expect(result.notes.some(n => n.startsWith("catalog:"))).toBe(true);
  });
});

describe("muster-digest bin", () => {
  it("returns 0 and one line for a valid directory even with unavailable telemetry", async () => {
    const out = { line: vi.fn(), error: vi.fn() };
    const code = await runDigest([fixture().dir], options(async () => { throw new Error("offline"); }), out);
    expect(code).toBe(0); expect(out.line).toHaveBeenCalledTimes(1); expect(out.error).not.toHaveBeenCalled();
  });
  it("returns 2 for missing dir, file instead of dir and bad arguments", async () => {
    const { dir, path } = fixture();
    for (const args of [[], [dir, "extra"], [join(dir, "missing")], [path]]) expect(await runDigest(args, options(), { line: vi.fn(), error: vi.fn() })).toBe(2);
  });
  it("runs via node with actual exit codes and no import-time effects", () => {
    const { dir } = fixture();
    execFileSync("git", ["init", "-q", dir]);
    const good = spawnSync(process.execPath, [resolve("bin/muster-digest.ts"), dir], { encoding: "utf8", env: { ...process.env, MUSTER_FLEET_COMPUTE: "off" }, timeout: 15_000 });
    expect(good.status).toBe(0); expect(good.stdout.trim().split("\n")).toHaveLength(1);
    const bad = spawnSync(process.execPath, [resolve("bin/muster-digest.ts"), join(dir, "missing")], { encoding: "utf8" });
    expect(bad.status).toBe(2);
  });
});
