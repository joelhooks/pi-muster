import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProcError } from "./errors.ts";
import { agentLaunch, githubOrigin, checkoutVisibility, laneOpen, projectMove, projectOpen, publicCheckout } from "./ops.ts";
import { Proc } from "./runtime.ts";
import type { ProcShape } from "./runtime.ts";
import { readRegistry } from "./registry.ts";
import { dataDir, load, mutate, projectPath } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

const fakeProc = (visibility: string, origin = "git@github.com:owner/repo.git"): ProcShape => ({
  run: (command, args) => Effect.succeed({ code: 0, stderr: "", stdout: command === "gh" ? JSON.stringify({ visibility }) : args[0] === "remote" ? origin : "/checkout" }),
});
const open = (dir: string) => projectOpen({ dir, slug: "move", outcome: "move safely", reviewTrigger: "weekly", nextAction: "move", ephemeral: true, space: "w1" });

async function fixture(root?: string) {
  const h = harness();
  const old = makeRepo(join(root ?? h.root, "old"));
  await runWith(h, open(old));
  await runWith(h, laneOpen(old, { slug: "work", label: "work", goal: "move" }));
  await runWith(h, laneOpen(old, { slug: "explicit", label: "explicit", goal: "keep repo", repo: old, open: false }));
  const brief = join(dataDir(old), "briefs", "work.md");
  mkdirSync(join(brief, ".."), { recursive: true });
  writeFileSync(brief, "fixture brief\n");
  const agent = await runWith(h, agentLaunch(old, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: old, brief }));
  const report = join(dataDir(old), "reports", "work", "report.md");
  const tail = join(dataDir(old), "closed", "tail.txt");
  for (const file of [report, tail]) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, `fixture ${file}\n`); }
  await runWith(h, mutate(old, (project) => Effect.succeed([{ ...project, packets: [{ id: "fixture", kind: "artifact", lane: "work", agent: "worker", artifact: brief, report, checks: [], state: "reported", verification: null, landedAs: null, gate: null, supersedes: null, reportedAt: project.createdAt, updatedAt: project.updatedAt }] }, undefined] as const)));
  return { h, old, report, tail, brief, agent, to: join(root ?? h.root, "private") };
}

describe("GitHub checkout visibility", () => {
  it.each(["git@github.com:owner/repo.git", "https://github.com/owner/repo.git", "ssh://git@github.com/owner/repo", "https://github.com/owner/repo/"])("parses %s", (origin) => expect(githubOrigin(origin)).toBe("owner/repo"));
  it("does not mistake another host for GitHub", () => {
    expect(githubOrigin("https://github.com.evil/owner/repo")).toBeNull();
    expect(checkoutVisibility("https://gitlab.com/owner/repo", { visibility: "PUBLIC" })).toBe("not-github");
  });
  it.each([["PUBLIC", "public"], ["PRIVATE", "private"], ["garbage", "unknown"]] as const)("classifies %s through fake git/gh", async (visibility, expected) => {
    const h = harness();
    expect(await runWith(h, publicCheckout(h.root).pipe(Effect.provideService(Proc, fakeProc(visibility))))).toBe(expected);
  });
  it("missing gh and malformed output are unknown", async () => {
    const h = harness();
    const missing: ProcShape = { run: (command, args, options) => command === "gh" ? Effect.fail(new ProcError({ command, code: null, stderr: "", message: "ENOENT" })) : fakeProc("PUBLIC").run(command, args, options) };
    expect(await runWith(h, publicCheckout(h.root).pipe(Effect.provideService(Proc, missing)))).toBe("unknown");
    const malformed: ProcShape = { run: (command, args, options) => command === "gh" ? Effect.succeed({ code: 0, stderr: "", stdout: "no json" }) : fakeProc("PUBLIC").run(command, args, options) };
    expect(await runWith(h, publicCheckout(h.root).pipe(Effect.provideService(Proc, malformed)))).toBe("unknown");
  });
  it("project_open warns without blocking", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "public"));
    const result = await runWith(h, open(dir).pipe(Effect.provideService(Proc, fakeProc("PUBLIC"))));
    expect(result.notes).toContain(`⚠ ${dir} is a public GitHub checkout; Muster state there is one commit from being published. Use a private dir.`);
  });
});

describe("project_move", () => {
  it("carries all state, keeps code paths, verifies copies and removes only old Muster files", async () => {
    const { h, old, to, report, tail, brief, agent } = await fixture();
    const reportBytes = readFileSync(report);
    const tailBytes = readFileSync(tail);
    const board = join(old, ".brain", "projects", "muster", "move.svx");
    const unrelated = join(old, ".brain", "projects", "keep.svx");
    writeFileSync(unrelated, "keep me");
    const calls = h.herdr.calls.length;
    const result = await runWith(h, projectMove(old, to));
    expect(result.copiedFiles).toBe(5);
    expect(result.lanesGivenRepo).toEqual(["work"]);
    expect(result.agentsToRestore).toEqual(["restore worker to pick up the new project dir"]);
    expect(result.notes.join(" ")).toContain("cadence still points at the old dir");
    const project = await runWith(h, load(to));
    expect(project.dir).toBe(to);
    expect(project.lanes.map((lane) => lane.repo)).toEqual([old, old]);
    expect(project.agents[0]?.cwd).toBe(agent.row.cwd);
    expect(project.agents[0]?.restore?.cwd).toBe(agent.row.restore?.cwd);
    expect(project.agents[0]?.restore?.env.MUSTER_PROJECT).toBe(to);
    expect(project.agents[0]?.brief).toBe(brief.replace(old, to));
    expect(project.packets[0]?.report).toBe(report.replace(old, to));
    expect(project.packets[0]?.artifact).toBe(brief.replace(old, to));
    expect(readFileSync(report.replace(old, to))).toEqual(reportBytes);
    expect(readFileSync(tail.replace(old, to))).toEqual(tailBytes);
    expect(readFileSync(board.replace(old, to), "utf8")).toContain(report.replace(old, to));
    expect(existsSync(dataDir(old))).toBe(false);
    expect(existsSync(board)).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("keep me");
    expect(existsSync(join(old, "README.md"))).toBe(true);
    expect(h.herdr.calls.length).toBe(calls);
  });
  it("appends the new registry dir for a durable project", async () => {
    // A test-owned durable dir lets the real move exercise registry writes.
    const root = mkdtempSync(join(process.cwd(), ".muster-move-fixture-"));
    try {
      const { h, old, to } = await fixture(root);
      await runWith(h, mutate(old, (project) => Effect.succeed([{ ...project, ephemeral: false }, undefined] as const)));
      expect(readRegistry(h.home).get("move")?.dir).toBe(old);
      await runWith(h, projectMove(old, to).pipe(Effect.provideService(Proc, fakeProc("PRIVATE"))));
      expect(readRegistry(h.home).get("move")?.dir).toBe(to);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
  it("refuses relative, existing and public targets", async () => {
    const { h, old, to } = await fixture();
    expect((await failWith(h, projectMove(old, "relative"))).message).toContain("absolute");
    expect((await failWith(h, projectMove(old, old))).message).toContain("overlap");
    expect((await failWith(h, projectMove(old, to).pipe(Effect.provideService(Proc, fakeProc("PUBLIC"))))).message).toContain("public GitHub");
    expect(existsSync(to)).toBe(false);
    await runWith(h, open(makeRepo(to)));
    expect((await failWith(h, projectMove(old, to))).message).toContain("already holds");
    expect(existsSync(projectPath(old))).toBe(true);
  });
  it("missing reports fail verification without removing the source", async () => {
    const { h, old, to } = await fixture();
    await runWith(h, mutate(old, (project) => Effect.succeed([{ ...project, packets: project.packets.map((packet) => ({ ...packet, report: join(dataDir(old), "missing.md") })) }, undefined] as const)));
    expect((await failWith(h, projectMove(old, to))).message).toContain("missing rewritten report");
    expect(existsSync(projectPath(old))).toBe(true);
  });
  it("refuses pre-existing target files without overwriting them", async () => {
    const { h, old, to } = await fixture();
    const file = join(dataDir(to), "briefs", "work.md");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "existing target work");
    expect((await failWith(h, projectMove(old, to))).message).toContain("target file already exists");
    expect(readFileSync(file, "utf8")).toBe("existing target work");
    expect(existsSync(projectPath(old))).toBe(true);
  });
  it("refuses temp destinations for durable projects", async () => {
    const { h, old, to } = await fixture();
    await runWith(h, mutate(old, (project) => Effect.succeed([{ ...project, ephemeral: false }, undefined] as const)));
    expect((await failWith(h, projectMove(old, to))).message).toContain("temp dir");
  });
  it("refuses symlinked target parents", async () => {
    const { h, old, to } = await fixture();
    mkdirSync(to);
    const elsewhere = join(h.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(to, ".brain"));
    expect((await failWith(h, projectMove(old, to))).message).toContain("symlinked state path");
    expect(existsSync(projectPath(old))).toBe(true);
  });
  it("refuses symlinked state files rather than moving their referents", async () => {
    const { h, old, to } = await fixture();
    symlinkSync(join(old, "README.md"), join(dataDir(old), "unsafe"));
    expect((await failWith(h, projectMove(old, to))).message).toContain("non-regular");
    expect(existsSync(projectPath(old))).toBe(true);
  });
});
