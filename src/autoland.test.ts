import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { findLanding } from "./autoland.ts";
import { decodeProject } from "./domain.ts";
import { projectOpen, laneOpen, agentLaunch, packetReport } from "./ops.ts";
import { load } from "./store.ts";
import { ProcError } from "./errors.ts";
import { liveProc } from "./runtime.ts";
import { harness, makeRepo, runWith, sh } from "./test-support.ts";

async function fixture() {
  const h = harness();
  const origin = makeRepo(join(h.root, "origin"));
  const dir = join(h.root, "repo"); sh(h.root, "clone", "-q", origin, dir);
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "test", reviewTrigger: "weekly", nextAction: "test", criticalPath: [], space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "test" }));
  const row = (await runWith(h, agentLaunch(dir, { action: "launch", name: "probe_w", label: "probe", role: "worker", lane: "probe", clone: true, prompt: "test" }))).row;
  writeFileSync(join(row.cwd, "work"), "one"); sh(row.cwd, "add", "work"); sh(row.cwd, "commit", "-qm", "work");
  const id = sh(row.cwd, "rev-parse", "HEAD").trim();
  const packet = (await runWith(h, packetReport({ dir, agent: row.name, owner: row.owner, cwd: row.cwd, commit: id, summary: "work", checks: [] }))).packet;
  const project = await runWith(h, load(dir));
  return { h, origin, dir, row, packet, project };
}

function github(f: Awaited<ReturnType<typeof fixture>>, response: unknown, fail = false) {
  const calls: string[] = [];
  f.h.proc = { run: (cmd, args, opts) => {
    if (cmd === "gh") {
      calls.push(args.join(" "));
      return fail ? Effect.fail(new ProcError({ command: "gh", code: null, stderr: "", message: "missing gh" }))
        : Effect.succeed({ code: 0, stdout: JSON.stringify(response), stderr: "" });
    }
    if (args[0] === "remote") return Effect.succeed({ code: 0, stdout: "git@github.com:owner/repo.git", stderr: "" });
    return liveProc.run(cmd, args, opts);
  } };
  return calls;
}

describe("autoland evidence", () => {
  it("fetches a real origin and finds an ancestor without changing the worktree", async () => {
    const f = await fixture();
    sh(f.origin, "fetch", "-q", f.row.cwd, f.packet.id); sh(f.origin, "merge", "--ff-only", "FETCH_HEAD");
    const before = sh(f.dir, "rev-parse", "HEAD");
    const found = await runWith(f.h, findLanding(f.project, f.packet));
    expect(found).toMatchObject({ sha: f.packet.id, how: "ancestor" });
    expect(sh(f.dir, "rev-parse", "HEAD")).toBe(before);
  });
  it("finds a merged PR only when its sha is on the base, including a later containing head", async () => {
    const f = await fixture();
    writeFileSync(join(f.row.cwd, "followup"), "two"); sh(f.row.cwd, "add", "followup"); sh(f.row.cwd, "commit", "-qm", "followup");
    const head = sh(f.row.cwd, "rev-parse", "HEAD").trim();
    const merged = sh(f.origin, "rev-parse", "HEAD").trim();
    const pull = { number: 42, merged_at: "2026-09-29", merge_commit_sha: merged, base: { ref: "main" }, merged_by: { login: "kodiak" } };
    const calls = github(f, []);
    const prev = f.h.proc;
    f.h.proc = { run: (cmd, args, opts) => cmd === "gh" && args[1]?.includes(head)
      ? Effect.succeed({ code: 0, stdout: JSON.stringify([[pull]]), stderr: "" }) : prev.run(cmd, args, opts) };
    expect(await runWith(f.h, findLanding(f.project, f.packet))).toMatchObject({ sha: merged, pr: 42, by: "kodiak", how: "squash" });
    expect(calls[0]).toContain(f.packet.id);
  });
  it.each(["unmerged", "wrong base", "unreachable", "no match"])("rejects %s evidence", async reason => {
    const f = await fixture();
    github(f, reason === "no match" ? [] : [{ number: 1, merged_at: reason === "unmerged" ? null : "today", merge_commit_sha: reason === "unreachable" ? "a".repeat(40) : sh(f.origin, "rev-parse", "HEAD").trim(), base: { ref: reason === "wrong base" ? "release" : "main" } }]);
    expect(await runWith(f.h, findLanding(f.project, f.packet))).toBeNull();
  });
  it("missing gh is nonfatal with an ancestor-only note", async () => {
    const f = await fixture(); github(f, null, true); const notes: string[] = [];
    expect(await runWith(f.h, findLanding(f.project, f.packet, { notes }))).toBeNull();
    expect(notes.join(" ")).toContain("ancestor-only");
  });
  it("failed fetch does not trust stale refs", async () => {
    const f = await fixture();
    f.h.proc = { run: (cmd, args, opts) => args[0] === "fetch" ? Effect.succeed({ code: 1, stdout: "", stderr: "offline" }) : liveProc.run(cmd, args, opts) };
    const notes: string[] = [];
    expect(await runWith(f.h, findLanding(f.project, f.packet, { notes }))).toBeNull();
    expect(notes.join(" ")).toContain("stale refs");
  });
  it("skips terminal packets before any process and decodes old files", async () => {
    const f = await fixture();
    const old = JSON.parse(JSON.stringify(f.project)); delete old.packets[0].autolandCheckedAt;
    expect(decodeProject(old).packets[0]?.autolandCheckedAt).toBeUndefined();
    f.h.proc = { run: () => { throw new Error("must not run"); } };
    for (const state of ["rejected", "committed", "no_changes"] as const) expect(await runWith(f.h, findLanding(f.project, { ...f.packet, state }))).toBeNull();
  });
});
