import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  },
}));
import { agentLaunch, laneOpen, projectOpen, runLaunchJob } from "./ops.ts";
import { load } from "./store.ts";
import { failWith, harness, makeRepo, runWith, sh } from "./test-support.ts";

async function fixture() {
  const h = harness();
  const dir = makeRepo(join(h.root, "project"));
  const repo = makeRepo(join(h.root, "source"));
  writeFileSync(join(repo, "source.txt"), "explicit source\n");
  sh(repo, "add", "source.txt"); sh(repo, "commit", "-qm", "source");
  await runWith(h, projectOpen({ dir, slug: "repo-test", outcome: "persist source", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true, musterExtension: "/muster", deskExtension: null }));
  return { h, dir, repo };
}

it("persists an explicit repo on an open live-root lane with a changed-fields receipt", async () => {
  const { h, dir, repo } = await fixture();
  const first = await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "ship", base: "main" }));
  const result = await runWith(h, laneOpen(dir, { slug: "work", repo }));
  expect((await runWith(h, load(dir))).lanes[0]).toMatchObject({ repo, base: "main", root: first.lane.root });
  expect(result.note).toBe("changed: repo updated");
});

it.each(["new", "proposed", "live", "missing"] as const)("%s: explicit and omitted repo feed completed detached clones, with cwd omitted or explicit", async state => {
  for (const explicitRepo of [false, true]) for (const explicitCwd of [false, true]) {
    const { h, dir, repo } = await fixture();
    if (state !== "new") {
      const first = await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "ship", open: state !== "proposed" }));
      if (state === "missing") h.herdr.panes.delete(first.lane.root!.paneId);
    }
    const opened = await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "ship", ...(explicitRepo ? { repo } : {}) }));
    if (explicitRepo && state !== "new") expect(opened.note).toContain("changed: repo updated");
    // Omitting the field on another call must preserve an explicit source.
    await runWith(h, laneOpen(dir, { slug: "work" }));
    const source = explicitRepo ? repo : dir;
    expect((await runWith(h, load(dir))).lanes[0]!.repo).toBe(explicitRepo ? repo : null);
    if (state === "new" || state === "proposed" || state === "missing") {
      expect(h.herdr.calls.filter(c => c.method === "tab.create").at(-1)?.params.cwd).toBe(source);
    }
    const receipt = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", lane: "work", role: "worker", label: "worker", clone: true, prompt: "Test the source.", ...(explicitCwd ? { cwd: source } : {}) }));
    if (!("jobId" in receipt)) throw new Error("expected detached job");
    expect((await runWith(h, runLaunchJob(dir, receipt.jobId))).kind).toBe("action");
    const row = (await runWith(h, load(dir))).agents[0]!;
    expect(row.state).toBe("running");
    expect(row.clone!.source).toBe(source);
    expect(sh(row.cwd, "remote", "get-url", "origin").trim()).toBe(source);
    if (explicitRepo) expect(readFileSync(join(row.cwd, "source.txt"), "utf8")).toBe("explicit source\n");
  }
}, 30_000);

it("amends proposed repo and preserves it when omitted", async () => {
  const { h, dir, repo } = await fixture();
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "ship", open: false }));
  const amendment = await runWith(h, laneOpen(dir, { slug: "work", repo, open: false }));
  expect(amendment.note).toBe("changed: repo updated; stored goal: ship");
  await runWith(h, laneOpen(dir, { slug: "work", open: false }));
  expect((await runWith(h, load(dir))).lanes[0]!.repo).toBe(repo);
});

it("refuses repo changes while a detached clone launch is still queued", async () => {
  const { h, dir, repo } = await fixture();
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "ship" }));
  const receipt = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", lane: "work", role: "worker", label: "worker", clone: true, prompt: "Test." }));
  if (!("jobId" in receipt)) throw new Error("expected detached job");
  const before = await runWith(h, load(dir));
  expect((await failWith(h, laneOpen(dir, { slug: "work", repo }))).message).toContain("active clone or launch");
  expect(await runWith(h, load(dir))).toEqual(before);
  expect((await runWith(h, runLaunchJob(dir, receipt.jobId))).kind).toBe("action");
  expect((await runWith(h, load(dir))).agents[0]!.clone!.source).toBe(dir);
});

it.each(["live", "missing", "parked"])("refuses source changes with an active clone before any mutation (%s)", async state => {
  const { h, dir, repo } = await fixture();
  const lane = await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "ship" }));
  const receipt = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", lane: "work", role: "worker", label: "worker", clone: true, prompt: "Test." }));
  if (!("jobId" in receipt)) throw new Error("expected detached job");
  await runWith(h, runLaunchJob(dir, receipt.jobId));
  if (state === "missing") h.herdr.panes.delete(lane.lane.root!.paneId);
  const before = await runWith(h, load(dir));
  const calls = h.herdr.calls.length;
  const error = await failWith(h, laneOpen(dir, { slug: "work", repo, base: "release", open: state !== "parked" }));
  expect(error.message).toContain("active clone");
  expect(await runWith(h, load(dir))).toEqual(before);
  expect(h.herdr.calls).toHaveLength(calls);
  // Setting the effective source explicitly is harmless, even with a clone.
  await runWith(h, laneOpen(dir, { slug: "work", repo: dir, open: state !== "parked" }));
  expect((await runWith(h, load(dir))).lanes[0]!.repo).toBe(dir);
});
