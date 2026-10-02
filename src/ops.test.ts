import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { FORBIDDEN_FLAGS } from "./argv.ts";
import { queuePath, readDesk } from "./desk.ts";
import {
  agentClose,
  agentLaunch,
  deskPost,
  laneClose,
  laneOpen,
  packetLand,
  packetReport,
  packetVerify,
  projectOpen,
  projectReview,
  projectStatus,
  projectUpdate,
  proposeReview,
  reviewDue,
} from "./ops.ts";
import { CAPTURE_REFRESH_MARK } from "./silence.ts";
import { parsePorcelainZ } from "./packet.ts";
import { load, mutate } from "./store.ts";
import { failWith, harness, makeRepo, runWith, sh } from "./test-support.ts";
import type { Harness } from "./test-support.ts";

const open = (h: Harness, dir: string) =>
  runWith(
    h,
    projectOpen({
      dir,
      slug: "probe",
      outcome: "prove muster end to end",
      reviewTrigger: "weekly",
      nextAction: "launch the probe",
      criticalPath: ["probe lane"],
      space: "w1",
      sidebar: true,
      ephemeral: true,
      cadenceMinutes: 15,
      musterExtension: "/muster",
      deskExtension: null,
    }),
  );

async function launchedWorker(h: Harness) {
  const dir = makeRepo(join(h.root, "repo"));
  await open(h, dir);
  await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "one packet" }));
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "do it\n");
  const launched = await runWith(h, agentLaunch(dir, { action: "launch", name: "probe_w", role: "worker", lane: "probe", label: "🔨 probe", clone: true, brief }));
  return { dir, launched, clone: launched.row.cwd };
}

function commitInClone(clone: string, file = "work.txt") {
  writeFileSync(join(clone, file), "packet\n");
  sh(clone, "add", file);
  sh(clone, "commit", "-q", "-m", "work");
  return sh(clone, "rev-parse", "HEAD").trim();
}

describe("lane clone base", () => {
  const prepare = async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    const initial = sh(dir, "rev-parse", "HEAD").trim();
    sh(dir, "branch", "release", initial);
    commitInClone(dir, "default-only.txt");
    await open(h, dir);
    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "g", base: "release" }));
    return { h, dir, initial };
  };
  const launch = (h: Harness, dir: string) => runWith(h, agentLaunch(dir, {
    action: "launch", name: "probe_w", role: "worker", lane: "probe", label: "🔨 probe", clone: true,
  }));

  it("updates a proposed lane's goal and base, and updates a live lane's base without a new tab", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "old", open: false }));
    const updated = await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "new", base: "release", open: false }));
    expect(updated.lane).toMatchObject({ goal: "new", base: "release", state: "proposed", tabId: null });
    const opened = await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "new" }));
    const live = await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "new", base: "abc123" }));
    expect(live.lane.base).toBe("abc123");
    expect(live.lane.tabId).toBe(opened.lane.tabId);
    expect((await runWith(h, load(dir))).lanes.find((lane) => lane.slug === "probe")?.base).toBe("abc123");
  });

  it.each(["release", "sha"])("passes %s through --base and records the resolved base", async (ref) => {
    const { h, dir, initial } = await prepare();
    const base = ref === "sha" ? initial : ref;
    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "g", base }));
    const result = await launch(h, dir);
    expect(result.row.clone?.base).toEqual({ ref: base, sha: initial });
    expect(sh(result.row.cwd, "rev-parse", "HEAD").trim()).toBe(initial);
    expect((await runWith(h, load(dir))).agents[0]?.clone?.base).toEqual({ ref: base, sha: initial });
  });

  it("refuses a clone HEAD mismatch before starting an agent", async () => {
    const { h, dir, initial } = await prepare();
    const wrong = sh(dir, "rev-parse", "HEAD").trim();
    const script = readFileSync(h.workerWorktree, "utf8");
    writeFileSync(h.workerWorktree, script.replace('echo "base: $base $sha"', `echo "base: $base ${wrong}"`));
    const error = await failWith(h, agentLaunch(dir, { action: "launch", name: "probe_w", role: "worker", lane: "probe", label: "🔨 probe", clone: true }));
    expect(error.message).toContain(`lane probe clone HEAD ${initial}`);
    expect(error.message).toContain(wrong);
    expect(h.herdr.calls.some((call) => call.method === "agent.start")).toBe(false);
    expect((await runWith(h, load(dir))).agents).toHaveLength(0);
  });

  it("refuses an old script with no base line and names the script", async () => {
    const { h, dir } = await prepare();
    const script = readFileSync(h.workerWorktree, "utf8");
    writeFileSync(h.workerWorktree, script.replace('echo "base: $base $sha"', ""));
    const error = await failWith(h, agentLaunch(dir, { action: "launch", name: "probe_w", role: "worker", lane: "probe", label: "🔨 probe", clone: true }));
    expect(error.message).toContain(h.workerWorktree);
    expect(error.message).toContain("cannot prove clone base for lane probe");
    expect(h.herdr.calls.some((call) => call.method === "agent.start")).toBe(false);
  });

  it("verifies a packet descends from its recorded clone base, not that HEAD still equals it", async () => {
    const h = harness();
    const { dir, clone, launched } = await launchedWorker(h);
    const commit = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    const verified = await runWith(h, packetVerify(dir, commit));
    expect(verified.packet.verification?.checks.find((check) => check.name === "clone base"))
      .toMatchObject({ outcome: "pass", detail: `default branch ${launched.row.clone?.base?.sha}` });
    await runWith(h, mutate(dir, (project) => Effect.succeed([{
      ...project,
      agents: project.agents.map((row) => ({ ...row, clone: row.clone ? { ...row.clone, base: null } : null })),
    }, undefined] as const)));
    const legacy = await runWith(h, packetVerify(dir, commit));
    expect(legacy.packet.verification?.checks.find((check) => check.name === "clone base"))
      .toMatchObject({ outcome: "skip", detail: "lane probe has no recorded clone base (launched before bases were recorded)" });
  });

  it("fails clone base verification for a packet outside the recorded base history", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const commit = commitInClone(clone);
    // The later source commit exists in the clone but is not in the packet's history.
    const other = commitInClone(dir, "later.txt");
    sh(clone, "fetch", "-q", dir, other);
    await runWith(h, mutate(dir, (project) => Effect.succeed([{
      ...project,
      agents: project.agents.map((row) => ({ ...row, clone: row.clone ? { ...row.clone, base: { ref: "later", sha: other } } : null })),
    }, undefined] as const)));
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    const error = await failWith(h, packetVerify(dir, commit));
    expect(error.failures).toEqual([
      `clone base: lane probe: ${commit} does not descend from later ${other}`,
    ]);
  });
});

describe("project_open", () => {
  it("refuses temp-dir state unless the project says it is throwaway", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    const error = await failWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n" }));
    expect(error._tag).toBe("GuardFailed");
    expect(error.message).toContain("dies on reboot");
  });

  it("creates the project, activates on a space, and returns the pi-until cadence call", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    const result = await open(h, dir);
    expect(result.project.state).toBe("active");
    expect(result.cadence?.tool).toBe("until");
    expect(result.cadence?.args.intervalSeconds).toBe(900);
    expect(existsSync(join(dir, ".brain", "data", "muster", "project.json"))).toBe(true);
    expect(readFileSync(join(dir, ".brain", "projects", "muster", "probe.svx"), "utf8")).toContain("generated_by: pi-muster");
    expect(h.herdr.tokens.get("w1")?.progress).toBe("🐑 no lanes");
    const adopted = await open(h, dir);
    expect(adopted.adopted).toBe(true);
    const quiet = await runWith(h, projectOpen({ dir, sidebar: false }));
    expect(quiet.project.sidebar).toBe("off");
    h.herdr.tokens.clear();
    await runWith(h, deskPost(dir, { kind: "fyi", title: "x" }));
    expect(h.herdr.tokens.size).toBe(0);
    const bad = await failWith(h, projectOpen({ dir, cadenceMinutes: 90 }));
    expect(bad.message).toContain("cache TTL");
  });
});

describe("Brain board type", () => {
  it("stores a custom type on open and preserves it through adoption and refresh", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    const adopted = await runWith(h, projectOpen({ dir, boardType: "report" }));
    expect(adopted.project.boardType).toBe("report");
    expect((await runWith(h, load(dir))).boardType).toBe("report");
    const board = join(dir, ".brain", "projects", "muster", "probe.svx");
    expect(readFileSync(board, "utf8")).toContain('type: "report"');
    await open(h, dir);
    await runWith(h, projectStatus(dir));
    expect(readFileSync(board, "utf8")).toContain('type: "report"');
  });

  it("sets a custom type when creating a project", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    const result = await runWith(h, projectOpen({
      dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n",
      ephemeral: true, boardType: "resource",
    }));
    expect(result.project.boardType).toBe("resource");
    expect((await runWith(h, load(dir))).boardType).toBe("resource");
    expect(readFileSync(join(dir, ".brain", "projects", "muster", "probe.svx"), "utf8")).toContain('type: "resource"');
  });

  it("updates the stored type and rewrites it on the next refresh", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    const board = join(dir, ".brain", "projects", "muster", "probe.svx");
    expect(readFileSync(board, "utf8")).toContain('type: "project"');
    const updated = await runWith(h, projectUpdate(dir, { boardType: "report" }));
    expect(updated.project.boardType).toBe("report");
    expect((await runWith(h, load(dir))).boardType).toBe("report");
    expect(readFileSync(board, "utf8")).toContain('type: "report"');
    writeFileSync(board, readFileSync(board, "utf8").replace('type: "report"', 'type: "project"'));
    await runWith(h, projectStatus(dir));
    expect(readFileSync(board, "utf8")).toContain('type: "report"');
  });
});

describe("pane binding safety", () => {
  async function rootWorker() {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "one packet" }));
    const launched = await runWith(h, agentLaunch(dir, {
      action: "launch", name: "first", role: "worker", lane: "probe", label: "🔨 first", cwd: dir, slot: "root",
    }));
    return { h, dir, row: launched.row };
  }

  it.each(["pane", "terminal"])("keeps a shared %s binding until the last row closes", async (identity) => {
    const { h, dir, row } = await rootWorker();
    const binding = row.pane!;
    await runWith(h, mutate(dir, (project) => Effect.succeed([{
      ...project,
      agents: [{ ...row, state: "failed" as const }, {
        ...row, name: "second", pane: { ...binding, ...(identity === "terminal" ? { paneId: "old-id" } : { terminalId: "old-terminal" }) },
      }],
    }, null] as const)));
    const result = await runWith(h, agentClose(dir, { name: "first" }));
    expect(result.row.state).toBe("closed");
    expect(result.row.pane).toBeNull();
    expect(result.notes).toContain(`pane ${binding.paneId} kept: second is bound to it`);
    expect(h.herdr.calls.filter((call) => call.method === "pane.close")).toHaveLength(0);
    expect(h.herdr.panes.has(binding.paneId)).toBe(true);
    // Bring the survivor's binding up to date, as project_status does.
    await runWith(h, mutate(dir, (project) => Effect.succeed([{
      ...project, agents: project.agents.map((agent) => agent.name === "second" ? { ...agent, pane: binding } : agent),
    }, null] as const)));
    await runWith(h, agentClose(dir, { name: "second" }));
    expect(h.herdr.calls.filter((call) => call.method === "pane.close")).toHaveLength(1);
    expect(h.herdr.panes.has(binding.paneId)).toBe(false);
  });

  it.each(["explicit", "root", "retained"])("refuses a %s pane held by a running row before sending shell input", async (selection) => {
    const { h, dir, row } = await rootWorker();
    if (selection === "retained") {
      await runWith(h, mutate(dir, (project) => Effect.succeed([{
        ...project, agents: [...project.agents, { ...row, name: "second", state: "failed" as const }],
      }, null] as const)));
    }
    h.herdr.calls.length = 0;
    const error = await failWith(h, agentLaunch(dir, {
      action: "launch", name: "second", role: "worker", lane: "probe", label: "🔨 second", cwd: dir,
      ...(selection === "explicit" ? { pane: row.pane!.paneId } : { slot: "root" as const }),
    }));
    expect(error.message).toMatch(/already (bound|runs)/);
    expect(h.herdr.calls.some((call) => ["pane.send_input", "agent.start"].includes(call.method))).toBe(false);
    expect((await runWith(h, load(dir))).agents.find((agent) => agent.name === "first")?.pane).toEqual(row.pane);
  });

  it.each(["failed", "interrupted", "closed"] as const)("moves a %s row's explicit binding and Muster ownership to its replacement", async (state) => {
    const { h, dir, row } = await rootWorker();
    await runWith(h, mutate(dir, (project) => Effect.succeed([{
      ...project, agents: [{ ...row, state }],
    }, null] as const)));
    const result = await runWith(h, agentLaunch(dir, {
      action: "launch", name: "second", role: "worker", lane: "probe", label: "🔨 second", cwd: dir, pane: row.pane!.paneId,
    }));
    expect(result.row.pane).toEqual(row.pane);
    expect((await runWith(h, load(dir))).agents.find((agent) => agent.name === "first")?.pane).toBeNull();
    await runWith(h, agentClose(dir, { name: "first" }));
    expect(h.herdr.panes.has(row.pane!.paneId)).toBe(true);
    await runWith(h, agentClose(dir, { name: "second" }));
    expect(h.herdr.panes.has(row.pane!.paneId)).toBe(false);
  });

  it.each([
    ["missing", "open"], ["reused", "open"], ["missing", "draining"], ["reused", "draining"],
  ])("replaces a %s root in a %s lane and restores onto the new pane", async (kind, laneState) => {
    const { h, dir, row } = await rootWorker();
    const binding = row.pane!;
    if (kind === "missing") h.herdr.panes.delete(binding.paneId);
    else h.herdr.panes.get(binding.paneId)!.terminal_id = "unrelated-terminal";
    await runWith(h, projectStatus(dir));
    if (laneState === "draining") expect((await runWith(h, laneClose(dir, "probe"))).lane.state).toBe("draining");
    h.herdr.calls.length = 0;
    const opened = await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "one packet" }));
    expect(opened.lane.state).toBe("open");
    expect(opened.lane.root?.paneId).not.toBe(binding.paneId);
    expect(opened.lane.root?.openedByMuster).toBe(true);
    expect(opened.note).toBe(`root pane was gone; opened tab ${opened.lane.tabId} pane ${opened.lane.root?.paneId}`);
    expect(h.herdr.calls.filter((call) => call.method === "tab.create")).toHaveLength(1);
    const restored = await runWith(h, agentLaunch(dir, { action: "restore", name: "first", slot: "root" }));
    expect(restored.row.state).toBe("running");
    expect(restored.row.pane).toEqual(opened.lane.root);
    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "one packet" }));
    expect(h.herdr.calls.filter((call) => call.method === "tab.create")).toHaveLength(1);
  });

  it("finds a moved terminal without opening another tab", async () => {
    const { h, dir, row } = await rootWorker();
    const pane = h.herdr.panes.get(row.pane!.paneId)!;
    h.herdr.panes.delete(pane.pane_id);
    pane.pane_id = "moved-pane";
    h.herdr.panes.set(pane.pane_id, pane);
    h.herdr.calls.length = 0;
    const result = await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "one packet" }));
    expect(result.lane.root?.paneId).toBe("moved-pane");
    expect(result.lane.root?.terminalId).toBe(pane.terminal_id);
    expect(h.herdr.calls.some((call) => call.method === "tab.create")).toBe(false);
  });
});

describe("field-use regressions", () => {
  it("retries a busy shell without re-running the prelude", async () => {
    const h = harness();
    h.herdr.startErrors = ["agent_pane_busy"];
    const { launched } = await launchedWorker(h);
    expect(launched.row.state).toBe("running");
    expect(h.herdr.calls.filter((call) => call.method === "agent.start")).toHaveLength(2);
    expect(h.herdr.calls.filter((call) => call.method === "pane.send_input" && String(call.params.text).startsWith("cd "))).toHaveLength(1);
  });

  it("starts when the shell stays busy past the old five-second retry budget", async () => {
    const h = harness();
    h.herdr.startErrors = Array(30).fill("agent_pane_busy");
    const { launched } = await launchedWorker(h);
    expect(launched.row.state).toBe("running");
    expect(h.herdr.calls.filter((call) => call.method === "agent.start")).toHaveLength(31);
    expect(h.herdr.calls.filter((call) => call.method === "pane.send_input" && String(call.params.text).startsWith("cd "))).toHaveLength(1);
  });

  it("bounds busy retries and does not retry other start errors", async () => {
    for (const code of ["agent_pane_busy", "agent_not_found"]) {
      const h = harness();
      h.herdr.startErrors = Array(70).fill(code);
      await expect(launchedWorker(h)).rejects.toThrow(code === "agent_pane_busy" ? "agent-start available-shell wait exhausted after 15000 ms" : "start rejected");
      expect(h.herdr.calls.filter((call) => call.method === "agent.start")).toHaveLength(code === "agent_pane_busy" ? 61 : 1);
      const project = await runWith(h, load(join(h.root, "repo")));
      expect(project.agents[0]?.state).toBe("failed");
    }
  });

  it("lands without committing unrelated staged or unstaged source edits", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    mkdirSync(join(dir, ".brain", "data", "muster"), { recursive: true });
    sh(dir, "add", ".brain/data/muster/project.json");
    sh(dir, "commit", "-q", "-m", "track catalog");
    const commit = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    await runWith(h, packetVerify(dir, commit));
    writeFileSync(join(dir, "README.md"), "staged user edit\n");
    sh(dir, "add", "README.md");
    writeFileSync(join(dir, "README.md"), "unstaged user edit\n");
    sh(dir, "add", ".brain/data/muster/project.json");
    const staged = sh(dir, "show", ":README.md");
    const catalog = sh(dir, "show", ":.brain/data/muster/project.json");
    const result = await runWith(h, packetLand(dir, { id: commit, outcome: "committed" }));
    expect(result.packet.state).toBe("committed");
    expect(sh(dir, "show", "HEAD:README.md")).toBe("hello\n");
    expect(sh(dir, "show", ":README.md")).toBe(staged);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("unstaged user edit\n");
    expect(sh(dir, "show", ":.brain/data/muster/project.json")).toBe(catalog);
    expect(sh(dir, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD^1", "HEAD").trim()).toBe("work.txt");
  });

  it("refuses dirty source paths that overlap the merge", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const commit = commitInClone(clone, "README.md");
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    await runWith(h, packetVerify(dir, commit));
    writeFileSync(join(dir, "README.md"), "user edit\n");
    const before = sh(dir, "rev-parse", "HEAD");
    const error = await failWith(h, packetLand(dir, { id: commit, outcome: "committed" }));
    expect(error.message).toContain("overlap");
    expect(error.message).toContain("README.md");
    expect(sh(dir, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("user edit\n");
  });

  it("leaves an existing source merge to its owner", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const commit = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    await runWith(h, packetVerify(dir, commit));
    const mergeHead = join(dir, ".git", "MERGE_HEAD");
    const previous = sh(dir, "rev-parse", "HEAD");
    writeFileSync(mergeHead, previous);
    expect((await failWith(h, packetLand(dir, { id: commit, outcome: "committed" }))).message).toContain("already has a merge");
    expect(readFileSync(mergeHead, "utf8")).toBe(previous);
  });

  it("reports to the adopted catalog owner rather than the launch owner", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    h.sessionId = "new-owner";
    await runWith(h, projectStatus(dir, { takeover: true, act: false }));
    expect((await runWith(h, load(dir))).agents[0]?.owner).toBe("new-owner");
    expect(h.herdr.calls.some((call) => call.method === "pane.close")).toBe(false);
    const commit = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "owner-session", cwd: clone, commit, summary: "s", checks: [] }));
    expect(h.sent.at(-1)?.to).toBe("new-owner");
  });

  it("does not report new work from a landed row whose agent exited", async () => {
    const h = harness();
    const { dir, clone, launched } = await launchedWorker(h);
    const first = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit: first, summary: "s", checks: [] }));
    await runWith(h, packetLand(dir, { id: first, outcome: "no_changes" }));
    delete h.herdr.panes.get(launched.row.pane!.paneId)!.agent;
    const second = commitInClone(clone, "next.txt");
    expect((await failWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit: second, summary: "s", checks: [] }))).message).toMatch(/needs its bound pane .* to host a live agent/);
  });

  it("allows another packet after no_changes but keeps terminal outcomes final", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const first = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit: first, summary: "s", checks: [] }));
    await runWith(h, packetLand(dir, { id: first, outcome: "no_changes" }));
    const second = commitInClone(clone, "next.txt");
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit: second, summary: "s", checks: [] }));
    expect((await runWith(h, load(dir))).packets.map((packet) => packet.state)).toEqual(["no_changes", "reported"]);
    const firstPacket = (await runWith(h, load(dir))).packets[0]!;
    const reportBefore = readFileSync(firstPacket.report, "utf8");
    expect((await failWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit: first, summary: "overwrite", checks: [] }))).message).toContain("already no_changes");
    expect(readFileSync(firstPacket.report, "utf8")).toBe(reportBefore);
  });
});

describe("follow-up packets", () => {
  async function verifiedWorker() {
    const h = harness();
    const worker = await launchedWorker(h);
    const first = commitInClone(worker.clone);
    const report = (commit: string) => runWith(h, packetReport({
      dir: worker.dir, agent: "probe_w", owner: "o", cwd: worker.clone,
      commit, summary: "follow-up", checks: [],
    }));
    await report(first);
    await runWith(h, packetVerify(worker.dir, first));
    return { h, ...worker, first, report };
  }

  it("reports from verified and lands both packets with one landing id", async () => {
    const { h, dir, clone, first, report } = await verifiedWorker();
    const second = commitInClone(clone, "safety.txt");
    expect((await report(second)).packet.supersedes).toBe(first);
    expect((await runWith(h, load(dir))).agents[0]?.state).toBe("reported");
    expect((await runWith(h, packetVerify(dir, second))).packet.supersedes).toBe(first);
    const landed = await runWith(h, packetLand(dir, { id: second, outcome: "committed" }));
    const packets = (await runWith(h, load(dir))).packets;
    expect(packets.map((packet) => packet.state)).toEqual(["committed", "committed"]);
    expect(packets.map((packet) => packet.landedAs)).toEqual([landed.packet.landedAs, landed.packet.landedAs]);
    expect(packets[0]?.evidence).toBe(`landed with ${second}`);
    expect((await failWith(h, packetLand(dir, { id: first, outcome: "rejected" }))).message).toContain("already committed");
  });

  it("refuses a non-ancestor without changing the earlier packet or row", async () => {
    const { h, dir, clone, first } = await verifiedWorker();
    sh(clone, "checkout", "-q", "-b", "unrelated", `${first}^`);
    const second = commitInClone(clone, "different.txt");
    const error = await failWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit: second, summary: "s", checks: [] }));
    expect(error.message).toContain("needs an outcome first; land or reject it");
    const project = await runWith(h, load(dir));
    expect(project.packets.map((packet) => packet.state)).toEqual(["verified"]);
    expect(project.agents[0]?.state).toBe("verified");
    expect(h.sent).toHaveLength(1);
  });

  it.each(["rejected", "no_changes"] as const)("leaves the earlier verified packet landable after %s", async (outcome) => {
    const { h, dir, clone, first, report } = await verifiedWorker();
    const second = commitInClone(clone, "safety.txt");
    await report(second);
    await runWith(h, packetVerify(dir, second));
    await runWith(h, packetLand(dir, { id: second, outcome }));
    expect((await runWith(h, load(dir))).packets.map((packet) => packet.state)).toEqual(["verified", outcome]);
    await runWith(h, packetLand(dir, { id: first, outcome: "committed" }));
    expect((await runWith(h, load(dir))).packets.map((packet) => packet.state)).toEqual(["committed", outcome]);
  });

  it("requires the verified worker's pane to still hold a live agent", async () => {
    const { h, dir, clone, launched, first } = await verifiedWorker();
    delete h.herdr.panes.get(launched.row.pane!.paneId)!.agent;
    const second = commitInClone(clone, "safety.txt");
    expect((await failWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit: second, summary: "s", checks: [] }))).message).toMatch(/needs its bound pane .* to host a live agent/);
    const project = await runWith(h, load(dir));
    expect(project.packets.map((packet) => packet.id)).toEqual([first]);
    expect(project.agents[0]?.state).toBe("verified");
  });

  it("preserves the link on re-report and lands a chain of follow-ups", async () => {
    const { h, dir, clone, first, report } = await verifiedWorker();
    const second = commitInClone(clone, "safety.txt");
    await report(second);
    expect((await report(second)).packet.supersedes).toBe(first);
    const third = commitInClone(clone, "more.txt");
    expect((await report(third)).packet.supersedes).toBe(second);
    await runWith(h, packetVerify(dir, third));
    const landed = await runWith(h, packetLand(dir, { id: third, outcome: "committed" }));
    const packets = (await runWith(h, load(dir))).packets;
    expect(packets.map((packet) => packet.state)).toEqual(["committed", "committed", "committed"]);
    expect(packets.every((packet) => packet.landedAs === landed.packet.landedAs)).toBe(true);
  });
});

describe("a lane from launch to close", () => {
  it("launches with the full profile, reads the real session, and proves delivery", async () => {
    const h = harness();
    const { launched, clone } = await launchedWorker(h);
    expect(launched.row.state).toBe("running");
    expect(launched.row.delivery).toBe("proven");
    expect(launched.row.clone?.branch).toBe("worker/probe-w");
    expect(launched.row.sessionFile).toMatch(/_probe_w-20260929T060000\.jsonl$/);
    expect(launched.row.pane?.openedByMuster).toBe(true);
    expect(launched.argv.filter((arg) => FORBIDDEN_FLAGS.includes(arg))).toEqual([]);
    expect(launched.argv).toEqual(expect.arrayContaining(["-ns", "--compact-at", "300000", "--approve", "-e", "/muster"]));
    const prelude = h.herdr.calls.find((call) => call.method === "pane.send_input");
    expect(String(prelude?.params.text)).toContain(`cd '${clone}'`);
    expect(String(prelude?.params.text)).toContain("export MUSTER_AGENT='probe_w'");
    expect(String(prelude?.params.text)).toContain("export MUSTER_OWNER='owner-session'");
    const methods = h.herdr.calls.map((call) => call.method);
    expect(methods.indexOf("agent.start")).toBeLessThan(methods.indexOf("pane.rename"));
    expect(methods.indexOf("pane.rename")).toBeLessThan(methods.indexOf("agent.prompt"));
    const split = h.herdr.calls.find((call) => call.method === "pane.split");
    expect(split?.params.direction).toBe("right");
  });

  it("marks delivery unproven when Herdr never sees working, after exactly one extra Enter", async () => {
    const h = harness();
    h.herdr.promptWorking = false;
    const { launched } = await launchedWorker(h);
    expect(launched.row.delivery).toBe("unproven");
    expect(h.herdr.calls.filter((call) => call.method === "agent.prompt")).toHaveLength(1);
    expect(h.herdr.calls.filter((call) => call.method === "pane.send_keys")).toHaveLength(1);
  });

  it("fails a launch whose Pi never starts a session, then relaunches in the same pane and clone", async () => {
    const h = harness();
    h.herdr.startSessions = false;
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "one packet" }));
    const launch = agentLaunch(dir, { action: "launch", name: "probe_w", role: "worker", lane: "probe", label: "🔨 probe", clone: true, prompt: "go" });
    const error = await failWith(h, launch);
    expect(error._tag).toBe("GuardFailed");
    expect(error.message).toContain("no Pi session appeared");
    const failed = (await runWith(h, load(dir))).agents[0];
    expect(failed?.state).toBe("failed");
    const panesBefore = h.herdr.panes.size;
    h.herdr.startSessions = true;
    h.herdr.promptFails = true;
    const relaunched = await runWith(h, launch);
    expect(relaunched.row.state).toBe("running");
    expect(relaunched.row.pane?.paneId).toBe(failed?.pane?.paneId);
    expect(relaunched.row.cwd).toBe(failed?.cwd);
    expect(h.herdr.panes.size).toBe(panesBefore);
    expect(relaunched.row.delivery).toBe("unproven");
  });

  it("retries the work prompt while Herdr has not yet registered the agent name", async () => {
    const h = harness();
    h.herdr.promptNotReady = 2;
    const { launched } = await launchedWorker(h);
    expect(h.herdr.promptNotReady).toBe(0);
    expect(launched.row.delivery).toBe("proven");
  });

  it("reports, verifies, lands --no-ff as the bot, closes the agent, and closes the lane", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const commit = commitInClone(clone);
    const reported = await runWith(
      h,
      packetReport({ dir, agent: "probe_w", owner: "owner-session", cwd: clone, commit: "HEAD", summary: "adds work.txt", checks: [{ name: "unit", outcome: "pass" }] }),
    );
    expect(reported.packet.id).toBe(commit);
    expect(reported.delivery.status).toBe("sent");
    expect(h.sent[0]?.to).toBe("owner-session");
    expect(h.sent[0]?.message).toContain(commit.slice(0, 12));
    expect((await runWith(h, load(dir))).agents[0]?.state).toBe("reported");

    const early = await failWith(h, packetLand(dir, { id: commit, outcome: "committed" }));
    expect(early.message).toContain("packet_verify");

    const verified = await runWith(h, packetVerify(dir, commit.slice(0, 8)));
    expect(verified.packet.state).toBe("verified");

    const drained = await runWith(h, laneClose(dir, "probe"));
    expect(drained.closed).toBe(false);
    expect(drained.lane.state).toBe("draining");

    const landed = await runWith(h, packetLand(dir, { id: commit, outcome: "committed", gate: "test -f work.txt" }));
    expect(landed.packet.state).toBe("committed");
    const head = sh(dir, "log", "-1", "--format=%an|%cn|%P");
    expect(head.split("|")[0]).toBe("shitratgit[bot]");
    expect(head.split("|")[1]).toBe("shitratgit[bot]");
    expect(head.trim().split("|")[2]?.split(" ")).toHaveLength(2);
    expect(landed.packet.landedAs).toBe(sh(dir, "rev-parse", "HEAD").trim());

    const closed = await runWith(h, agentClose(dir, { name: "probe_w" }));
    expect(closed.row.state).toBe("closed");
    expect(closed.cloneError).toBeNull();
    expect(existsSync(clone)).toBe(false);
    expect(closed.restore.argv.slice(0, 2)[0]).toBe("--session");
    expect(closed.restore.env.MUSTER_AGENT).toBe("probe_w");

    const done = await runWith(h, laneClose(dir, "probe"));
    expect(done.closed).toBe(true);
    expect(h.herdr.panes.size).toBe(0);
    expect(h.herdr.tokens.get("w1")?.progress).toBe("🐑 1/1 lanes");
  });

  it("records an artifact packet with evidence and no merge, which lets the lane close", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const artifact = join(h.root, "ops-report.txt");
    writeFileSync(artifact, "did remote things\n");
    const reported = await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, artifact, summary: "remote ops", checks: [] }));
    const id = reported.packet.id;
    await runWith(h, packetVerify(dir, id));
    const missing = await failWith(h, packetLand(dir, { id, outcome: "committed" }));
    expect(missing._tag).toBe("InputError");
    expect(missing.message).toContain("evidence");
    const head = sh(dir, "rev-parse", "HEAD");
    const landed = await runWith(h, packetLand(dir, { id, outcome: "committed", evidence: "ssh remote: config present at ~/x" }));
    expect(landed.packet.state).toBe("committed");
    expect(landed.packet.evidence).toBe("ssh remote: config present at ~/x");
    expect(sh(dir, "rev-parse", "HEAD")).toBe(head);
    await runWith(h, agentClose(dir, { name: "probe_w" }));
    expect((await runWith(h, laneClose(dir, "probe"))).closed).toBe(true);
  });

  it("refuses to record an unverified artifact packet", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const artifact = join(h.root, "ops-report.txt");
    writeFileSync(artifact, "x\n");
    const reported = await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, artifact, summary: "s", checks: [] }));
    const error = await failWith(h, packetLand(dir, { id: reported.packet.id, outcome: "committed", evidence: "e" }));
    expect(error._tag).toBe("GuardFailed");
  });

  it("fails a gate by aborting the merge and leaves the source untouched", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const commit = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    await runWith(h, packetVerify(dir, commit));
    const before = sh(dir, "rev-parse", "HEAD");
    const error = await failWith(h, packetLand(dir, { id: commit, outcome: "committed", gate: "exit 3" }));
    expect(error.message).toContain("gate failed");
    expect(sh(dir, "rev-parse", "HEAD")).toBe(before);
    expect(sh(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("refuses closing another owner's agent and force without a verified packet", async () => {
    const h = harness();
    const { dir } = await launchedWorker(h);
    h.sessionId = "someone-else";
    expect((await failWith(h, agentClose(dir, { name: "probe_w" }))).message).toContain("belongs to owner session");
    h.sessionId = "owner-session";
    expect((await failWith(h, agentClose(dir, { name: "probe_w", force: true }))).message).toContain("packet_verify");
  });
});

describe("packet_land external squash landings", () => {
  async function verifiedWorker() {
    const h = harness();
    const worker = await launchedWorker(h);
    await runWith(h, projectOpen({ dir: worker.dir, mode: "pr-merge" }));
    const commit = commitInClone(worker.clone);
    await runWith(h, packetReport({ dir: worker.dir, agent: "probe_w", owner: "o", cwd: worker.clone, commit, summary: "s", checks: [] }));
    await runWith(h, packetVerify(worker.dir, commit));
    sh(worker.dir, "fetch", "-q", worker.clone, commit);
    return { h, ...worker, commit };
  }

  function squash(dir: string, commit: string) {
    sh(dir, "merge", "--squash", commit);
    sh(dir, "commit", "-q", "-m", "squash landing");
    return sh(dir, "rev-parse", "HEAD").trim();
  }

  it("still records an ancestor landing", async () => {
    const { h, dir, commit } = await verifiedWorker();
    sh(dir, "merge", "--no-ff", "-m", "external merge", commit);
    const landedAs = sh(dir, "rev-parse", "HEAD").trim();
    const result = await runWith(h, packetLand(dir, { id: commit, outcome: "committed", landedAs }));
    expect(result.note).toBe("recorded an external landing");
    expect(result.packet.state).toBe("committed");
    expect(result.packet.landedAs).toBe(landedAs);
  });

  it("records an identical squash patch and stores the rule with caller evidence", async () => {
    const { h, dir, commit } = await verifiedWorker();
    const landedAs = squash(dir, commit);
    const result = await runWith(h, packetLand(dir, { id: commit, outcome: "committed", landedAs, evidence: "reviewed PR" }));
    expect(result.note).toBe("recorded a squash landing (patch-id match)");
    expect(result.packet.landedAs).toBe(landedAs);
    expect(result.packet.evidence).toBe(`reviewed PR\n${result.note}`);
    expect((await runWith(h, load(dir))).packets[0]?.evidence).toBe(result.packet.evidence);
  });

  it("records a squash with other PR changes when packet paths match", async () => {
    const { h, dir, clone, commit } = await verifiedWorker();
    commitInClone(clone, "extra.txt");
    sh(dir, "fetch", "-q", clone, "HEAD");
    const landedAs = squash(dir, sh(clone, "rev-parse", "HEAD").trim());
    const result = await runWith(h, packetLand(dir, { id: commit, outcome: "committed", landedAs }));
    expect(result.note).toBe("recorded a squash landing (paths identical at landedAs)");
    expect(result.packet.evidence).toBe(result.note);
    expect(result.packet.state).toBe("committed");
  });

  it("compares deleted and renamed paths literally in the path fallback", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    await runWith(h, projectOpen({ dir, mode: "pr-merge" }));
    const filename = "literal[1].txt";
    writeFileSync(join(clone, filename), "rename me\n");
    sh(clone, "add", filename);
    sh(clone, "commit", "-q", "-m", "base file");
    const base = sh(clone, "rev-parse", "HEAD").trim();
    sh(dir, "fetch", "-q", clone, base);
    sh(dir, "merge", "--ff-only", base);
    sh(clone, "mv", filename, "renamed.txt");
    sh(clone, "commit", "-q", "-m", "rename");
    const commit = sh(clone, "rev-parse", "HEAD").trim();
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "rename", checks: [] }));
    await runWith(h, packetVerify(dir, commit));
    const extra = commitInClone(clone, "extra.txt");
    sh(dir, "fetch", "-q", clone, extra);
    const landedAs = squash(dir, extra);
    const result = await runWith(h, packetLand(dir, { id: commit, outcome: "committed", landedAs }));
    expect(result.note).toBe("recorded a squash landing (paths identical at landedAs)");
  });

  it("harvests the packet object from its clone when missing from the source", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    await runWith(h, projectOpen({ dir, mode: "pr-merge" }));
    const commit = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    await runWith(h, packetVerify(dir, commit));
    writeFileSync(join(dir, "work.txt"), "packet\n");
    sh(dir, "add", "work.txt");
    sh(dir, "commit", "-q", "-m", "squash without packet object");
    const landedAs = sh(dir, "rev-parse", "HEAD").trim();
    const result = await runWith(h, packetLand(dir, { id: commit, outcome: "committed", landedAs }));
    expect(result.note).toBe("recorded a squash landing (patch-id match)");
  });

  it("refuses a different change on a packet path and names the path", async () => {
    const { h, dir, commit } = await verifiedWorker();
    sh(dir, "merge", "--squash", commit);
    writeFileSync(join(dir, "work.txt"), "wrong change\n");
    sh(dir, "add", "work.txt");
    sh(dir, "commit", "-q", "-m", "different squash");
    const landedAs = sh(dir, "rev-parse", "HEAD").trim();
    const error = await failWith(h, packetLand(dir, { id: commit, outcome: "committed", landedAs }));
    expect(error._tag).toBe("GuardFailed");
    expect(error.message).toContain('differing paths: "work.txt"');
    expect((await runWith(h, load(dir))).packets[0]?.state).toBe("verified");
  });

  it("refuses an unknown landedAs commit", async () => {
    const { h, dir, commit } = await verifiedWorker();
    const error = await failWith(h, packetLand(dir, { id: commit, outcome: "committed", landedAs: "f".repeat(40) }));
    expect(error._tag).toBe("GuardFailed");
    expect(error.message).toContain("unknown landedAs commit");
    expect((await runWith(h, load(dir))).packets[0]?.state).toBe("verified");
  });

  it("fetches a missing squash commit from origin before comparing it", async () => {
    const { h, dir, clone, commit } = await verifiedWorker();
    const remote = join(h.root, "remote");
    sh(h.root, "clone", "-q", dir, remote);
    sh(remote, "config", "user.name", "Test");
    sh(remote, "config", "user.email", "test@example.test");
    sh(remote, "fetch", "-q", clone, commit);
    const landedAs = squash(remote, commit);
    sh(dir, "remote", "add", "origin", remote);
    const result = await runWith(h, packetLand(dir, { id: commit, outcome: "committed", landedAs }));
    expect(result.note).toBe("recorded a squash landing (patch-id match)");
    expect(result.packet.landedAs).toBe(landedAs);
  });
});

describe("packet_verify against fixtures", () => {
  it("fails dirty paths that differ from source but allows generated ones", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const commit = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    mkdirSync(join(clone, ".brain"), { recursive: true });
    writeFileSync(join(clone, ".brain", "note.svx"), "generated\n");
    writeFileSync(join(clone, "stray.ts"), "not in source\n");
    const error = await failWith(h, packetVerify(dir, commit));
    expect(error._tag).toBe("PacketCheckFailed");
    expect(JSON.stringify(error.failures)).toContain("stray.ts");
    expect(JSON.stringify(error.failures)).not.toContain(".brain");
    writeFileSync(join(dir, "stray.ts"), "not in source\n");
    expect((await runWith(h, packetVerify(dir, commit))).packet.state).toBe("verified");
  });

  it("fails a commit that is off the lane branch, and a missing report", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const commit = commitInClone(clone);
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit, summary: "s", checks: [] }));
    sh(clone, "reset", "-q", "--hard", "HEAD~1");
    const project = await runWith(h, load(dir));
    writeFileSync(project.packets[0]?.report as string, "");
    const error = await failWith(h, packetVerify(dir, commit));
    const text = JSON.stringify(error.failures);
    expect(text).toContain("not an ancestor of worker/probe-w");
    expect(text).toContain("missing or empty");
  });

  it("fails a commit from an unrelated repo", async () => {
    const h = harness();
    const { dir, clone } = await launchedWorker(h);
    const other = join(h.root, "other");
    mkdirSync(other);
    sh(other, "init", "-q", "-b", "main");
    writeFileSync(join(other, "foreign.txt"), "another project\n");
    sh(other, "add", "foreign.txt");
    sh(other, "commit", "-q", "-m", "foreign root");
    sh(clone, "fetch", "-q", other, "main:foreign");
    sh(clone, "merge", "-q", "--allow-unrelated-histories", "-m", "mix", "foreign");
    const foreign = sh(clone, "rev-parse", "foreign").trim();
    await runWith(h, packetReport({ dir, agent: "probe_w", owner: "o", cwd: clone, commit: foreign, summary: "s", checks: [] }));
    const error = await failWith(h, packetVerify(dir, foreign));
    expect(JSON.stringify(error.failures)).toContain("shares no root commit");
  });

  it("parses porcelain -z with renames", () => {
    expect(parsePorcelainZ("?? a.txt\0R  new.txt\0old.txt\0 M b.txt\0")).toEqual(["a.txt", "new.txt", "b.txt"]);
  });
});

describe("project_status live adoption", () => {
  async function candidate(state: "failed" | "launching" = "failed", byId = false) {
    const h = harness();
    const { dir, launched, clone } = await launchedWorker(h);
    const pane = h.herdr.panes.get(launched.row.pane?.paneId as string)!;
    pane.agent = "pi";
    await runWith(h, mutate(dir, (project) => {
      const row = { ...project.agents[0]!, state, sessionFile: byId ? null : launched.row.sessionFile, restore: null };
      return Effect.succeed([{ ...project, agents: [row] }, row] as const);
    }));
    const before = (await runWith(h, load(dir))).agents[0]!;
    h.herdr.calls = [];
    return { h, dir, pane, before, clone, file: launched.row.sessionFile! };
  }

  function noPaneInput(h: Harness) {
    expect(h.herdr.calls.filter((call) => /^(agent\.(start|prompt|wait)|pane\.(send_input|send_text|send_keys|close))$/.test(call.method))).toEqual([]);
  }

  it.each(["failed", "launching"] as const)("adopts %s by session file and lets the worker report", async (state) => {
    const { h, dir, pane, file, clone } = await candidate(state);
    const stale = new Date(h.now.getTime() - 120 * 60_000);
    utimesSync(file, stale, stale);
    const status = await runWith(h, projectStatus(dir, { act: true }));
    const row = status.project.agents[0]!;
    expect(row.state).toBe("running");
    expect(row.sessionFile).toBe(file);
    expect(row.restore?.cwd).toBe(clone);
    expect(row.restore?.argv).toEqual(expect.arrayContaining(["--session", file]));
    expect(row.restore?.env).toMatchObject({ MUSTER_AGENT: row.name });
    expect(status.board).toContain("adopted (live pi session matches)");
    expect(h.herdr.calls.some((call) => call.method === "pane.get" && call.params.pane_id === pane.pane_id)).toBe(true);
    noPaneInput(h);
    const commit = commitInClone(clone);
    const report = await runWith(h, packetReport({ dir, cwd: clone, agent: row.name, owner: row.owner, commit, summary: "live worker", checks: [] }));
    expect(report.packet.state).toBe("reported");
  });

  it("adopts by session id and records the session path", async () => {
    const { h, dir, file, before } = await candidate("failed", true);
    const status = await runWith(h, projectStatus(dir));
    expect(status.project.agents[0]).toMatchObject({ state: "running", sessionFile: file, sessionId: before.sessionId });
    noPaneInput(h);
  });

  it("rebinds a moved pane by terminal id before adopting", async () => {
    const { h, dir, pane } = await candidate();
    h.herdr.panes.delete(pane.pane_id);
    pane.pane_id = "moved";
    pane.tab_id = "moved-tab";
    h.herdr.panes.set(pane.pane_id, pane);
    const status = await runWith(h, projectStatus(dir));
    expect(status.project.agents[0]).toMatchObject({ state: "running", pane: { paneId: "moved", tabId: "moved-tab" } });
    noPaneInput(h);
  });

  it("refuses a terminal-id mismatch", async () => {
    const { h, dir, pane, before } = await candidate();
    pane.terminal_id = "another-terminal";
    const status = await runWith(h, projectStatus(dir));
    expect(status.project.agents[0]).toEqual(before);
    noPaneInput(h);
  });

  it.each([false, true])("refuses a different session without learning it (by id: %s)", async (byId) => {
    const { h, dir, pane, before } = await candidate("failed", byId);
    pane.agent_session!.value = "/sessions/timestamp_other-session.jsonl";
    for (let pass = 0; pass < 2; pass += 1) {
      const status = await runWith(h, projectStatus(dir));
      expect(status.project.agents[0]).toEqual(before);
    }
    noPaneInput(h);
  });

  it.each(["claude", undefined])("refuses a non-Pi pane (%s)", async (agent) => {
    const { h, dir, pane, before } = await candidate();
    if (agent) pane.agent = agent;
    else delete pane.agent;
    const status = await runWith(h, projectStatus(dir));
    expect(status.project.agents[0]).toEqual(before);
    noPaneInput(h);
  });

  it("refuses a row owned by another session", async () => {
    const { h, dir, before } = await candidate();
    h.sessionId = "other-owner";
    const status = await runWith(h, projectStatus(dir));
    expect(status.project.agents[0]).toEqual(before);
    noPaneInput(h);
  });

  it("reports adoptable with act: false and changes no row", async () => {
    const { h, dir, pane, before } = await candidate("launching", true);
    h.herdr.panes.delete(pane.pane_id);
    pane.pane_id = "moved";
    h.herdr.panes.set(pane.pane_id, pane);
    const status = await runWith(h, projectStatus(dir, { act: false }));
    expect(status.project.agents[0]).toEqual(before);
    expect(status.board).toContain("adoptable (live pi session matches; act: false)");
    noPaneInput(h);
  });
});

describe("project_status", () => {
  it("interrupts rows whose pane is gone and reports cache cost from usage", async () => {
    const h = harness();
    const { dir, launched } = await launchedWorker(h);
    const file = launched.row.sessionFile as string;
    writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, cacheRead: 1000, cacheWrite: 10, totalTokens: 1011 } } })}\n`);
    h.live = [launched.row.sessionId];
    const status = await runWith(h, projectStatus(dir));
    const line = status.agents[0];
    expect(line?.cost?.cost).toBeCloseTo(1 + 100 + 12.5);
    expect(line?.cost?.contextTokens).toBe(1011);
    expect(line?.cache).toBe("warm");
    expect(line?.intercom).toBe("reachable");
    expect(status.board).toContain("cacheRead×0.1");

    const pane = h.herdr.panes.get(launched.row.pane?.paneId as string);
    if (pane) delete pane.agent;
    const exited = await runWith(h, projectStatus(dir));
    expect(exited.agents[0]?.state).toBe("interrupted");
    expect(exited.agents[0]?.action).toBe("agent exited to its shell: interrupted");
    if (pane) pane.agent = "probe_w";
    await runWith(h, agentLaunch(dir, { action: "restore", name: "probe_w" }));
    h.herdr.panes.delete(launched.row.pane?.paneId as string);
    const gone = await runWith(h, projectStatus(dir));
    expect(gone.agents[0]?.state).toBe("interrupted");
    expect(gone.agents[0]?.action).toBe("pane gone: interrupted");
  });

  it("nudges at 30 minutes and restarts with /new at 60, only for its own rows", async () => {
    const h = harness();
    const { dir, launched } = await launchedWorker(h);
    const file = launched.row.sessionFile as string;
    const age = (minutes: number) => {
      const when = new Date(h.now.getTime() - minutes * 60_000);
      utimesSync(file, when, when);
    };
    age(31);
    h.sessionId = "not-the-owner";
    const observed = await runWith(h, projectStatus(dir));
    expect(observed.agents[0]?.action).toContain("nudge due");
    expect(observed.agents[0]?.state).toBe("running");

    h.sessionId = "owner-session";
    const nudged = await runWith(h, projectStatus(dir));
    expect(nudged.agents[0]?.state).toBe("nudged");
    const keys = h.herdr.calls.filter((call) => call.method === "pane.send_keys");
    expect(keys.at(-1)?.params.keys).toEqual(["Escape"]);

    age(61);
    const restarted = await runWith(h, projectStatus(dir));
    expect(restarted.agents[0]?.state).toBe("restarted");
    expect(restarted.agents[0]?.action).toContain("/new");
    const row = (await runWith(h, load(dir))).agents[0];
    expect(row?.restarts).toBe(1);
    expect(row?.sessionId).toMatch(/^fresh-/);
    expect(h.herdr.calls.some((call) => call.method === "pane.send_input" && call.params.text === "/new")).toBe(true);
  });
});

describe("bridge capture and the sidebar", () => {
  const failed = JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "error", errorMessage: "prompt-capture: this wake carries an older prompt" } });

  it("types one refresh into its own stuck bridge lane and flags anyone else's", async () => {
    const h = harness();
    const { dir, launched } = await launchedWorker(h);
    const file = launched.row.sessionFile as string;
    writeFileSync(file, `${failed}\n`);

    h.sessionId = "not-the-owner";
    const observed = await runWith(h, projectStatus(dir));
    expect(observed.agents[0]?.action).toContain("stuck on bridge prompt capture");
    expect(h.herdr.tokens.get("w1")?.agents).toContain("⚠️ 1 stuck");

    h.sessionId = "owner-session";
    const prompts = () => h.herdr.calls.filter((call) => call.method === "agent.prompt").length;
    const before = prompts();
    const refreshed = await runWith(h, projectStatus(dir));
    expect(refreshed.agents[0]?.action).toContain("refreshed bridge prompt capture");
    expect(prompts()).toBe(before + 1);
    expect(String(h.herdr.calls.at(-1)?.method)).not.toBe("pane.send_keys");

    const user = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `${CAPTURE_REFRESH_MARK} ...` }] } });
    writeFileSync(file, `${failed}\n${user}\n${failed}\n`);
    const again = await runWith(h, projectStatus(dir));
    expect(again.agents[0]?.action).toContain("failed again after a refresh");
    expect(prompts()).toBe(before + 1);
  });

  it("keeps the space label a name and takes headline and policy through project_update", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    expect((await runWith(h, load(dir))).label).toBe("fake");

    const space = h.herdr.workspaces.get("w1");
    if (space) space.label = "[probe] cutover live · Joel: merge";
    const status = await runWith(h, projectStatus(dir));
    expect(status.notes.join("\n")).toContain("put back");
    expect(h.herdr.workspaces.get("w1")?.label).toBe("fake");

    const updated = await runWith(
      h,
      projectUpdate(dir, { headline: "cutover live", label: "Probe", policy: { restartAfterMin: null, roles: { worker: { model: "openai-codex/gpt-6-luna" } } } }),
    );
    expect(h.herdr.tokens.get("w1")?.now).toBe("cutover live");
    expect(h.herdr.workspaces.get("w1")?.label).toBe("Probe");
    expect(updated.policy.restartAfterMin).toBeNull();
    expect(updated.policy.roles.worker).toMatchObject({ model: "openai-codex/gpt-6-luna", thinking: "medium", compactAt: 300000 });
    await runWith(h, projectUpdate(dir, { policy: { roles: { worker: { compactAt: 200000 } } } }));
    const merged = await runWith(h, projectUpdate(dir, { headline: null }));
    expect(merged.policy.roles.worker).toMatchObject({ model: "openai-codex/gpt-6-luna", compactAt: 200000 });
    expect(h.herdr.tokens.get("w1")?.now).toBe("launch the probe");

    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "g" }));
    const launched = await runWith(h, agentLaunch(dir, { action: "launch", name: "tuned", role: "worker", lane: "probe", label: "🔨 t", cwd: dir }));
    expect(launched.row.profile).toMatchObject({ model: "openai-codex/gpt-6-luna", compactAt: 200000 });
    expect((await failWith(h, projectUpdate(dir, { policy: { nudgeAfterMin: -5 } }))).message).toBeTruthy();
  });
});

describe("roster", () => {
  const roster = {
    version: 1,
    roles: {
      boss: {
        model: "claude-bridge/claude-opus-5-5",
        alternates: [{ model: "openai-codex/gpt-6.1-sol", thinking: "high", compactAt: 200000, useFor: ["root-causing bugs"], avoidFor: ["front-end taste"] }],
      },
      worker: { model: "openai-codex/gpt-6-luna" },
    },
  };

  it("launches from the fleet roster, and an alternate brings its settings", async () => {
    const h = harness();
    mkdirSync(join(h.home, ".config", "muster"), { recursive: true });
    writeFileSync(join(h.home, ".config", "muster", "roster.json"), JSON.stringify(roster));
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "g" }));
    const boss = await runWith(h, agentLaunch(dir, { action: "launch", name: "boss", role: "boss", lane: "probe", label: "🧭 boss", cwd: dir }));
    expect(boss.row.profile).toMatchObject({ model: "claude-bridge/claude-opus-5-5", compactAt: 400000 });
    const auditor = await runWith(h, agentLaunch(dir, { action: "launch", name: "auditor", role: "boss", lane: "probe", label: "🔎 audit", cwd: dir, slot: "split", model: "openai-codex/gpt-6.1-sol" }));
    expect(auditor.row.profile).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "high", compactAt: 200000 });
    const worker = await runWith(h, agentLaunch(dir, { action: "launch", name: "w", role: "worker", lane: "probe", label: "🔨 w", cwd: dir }));
    expect(worker.row.profile).toMatchObject({ model: "openai-codex/gpt-6-luna", compactAt: 300000, noSkills: true });

    const update = await runWith(h, projectUpdate(dir, {}));
    expect(update.policy.roles.boss).toMatchObject({ model: "claude-bridge/claude-opus-5-5", alternates: [{ model: "openai-codex/gpt-6.1-sol", useFor: ["root-causing bugs"] }] });
    expect(update.notes.join("\n")).toContain("roster.json");

    writeFileSync(join(h.home, ".config", "muster", "roster.json"), JSON.stringify({ version: 1, roles: { boss: { alternates: [{ model: "x" }] } } }));
    expect((await failWith(h, agentLaunch(dir, { action: "launch", name: "bad", role: "boss", lane: "probe", label: "b", cwd: dir }))).message).toContain("roster");
  });
});

describe("desk and review", () => {
  it("posts to the dark-wizard queue and drives needs", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    const posted = await runWith(h, deskPost(dir, { kind: "decision", title: "Ship the probe?" }));
    expect(posted.open).toBe(1);
    expect(h.herdr.tokens.get("w1")?.needs).toBe("🙋 Ship the probe?");
    const items = readDesk(queuePath("probe", h.home));
    expect(items[0]).toMatchObject({ kind: "decision", title: "Ship the probe?", from: "🐑 probe owner" });
    await runWith(h, deskPost(dir, { kind: "done", title: "Shipped", resolves: posted.record.id }));
    expect(h.herdr.tokens.get("w1")?.needs).toBeNull();
    expect((await failWith(h, deskPost(dir, { kind: "done", title: "x", resolves: "nope" }))).message).toContain("no desk item");
  });

  it("flags an overdue weekly review on the board and echoes the outcome when a lane opens", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    const opened = await runWith(h, laneOpen(dir, { slug: "a", label: "🅰️ a", goal: "g" }));
    const project = await runWith(h, load(dir));
    expect(opened.outcome).toBe(project.outcome);
    const start = Date.parse(project.createdAt);
    const day = 24 * 60 * 60 * 1000;
    expect(reviewDue(project, start + 6 * day)).toBeNull();
    expect(reviewDue(project, start + 9 * day)).toBe("⚠ review overdue: no project_review in 9d");
    const reviewed = { ...project, reviews: [{ at: new Date(start + 8 * day).toISOString(), note: "n", proposal: "continue" as const, decision: "continue" as const }] };
    expect(reviewDue(reviewed, start + 9 * day)).toBeNull();
    expect(reviewDue(reviewed, start + 16 * day)).toBe("⚠ review overdue: last project_review 8d ago");
  });

  it("reviews, archives closed lanes, and archives the project only on request", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await open(h, dir);
    await runWith(h, laneOpen(dir, { slug: "a", label: "🅰️ a", goal: "g" }));
    await runWith(h, laneClose(dir, "a"));
    expect(proposeReview(await runWith(h, load(dir)))).toBe("archive");
    const kept = await runWith(h, projectReview(dir, { note: "still going", nextAction: "next" }));
    expect(kept.project.state).toBe("active");
    expect(kept.archivedLanes).toEqual(["a"]);
    const reopened = await runWith(h, laneOpen(dir, { slug: "a", label: "🅰️ a", goal: "g" }));
    expect(reopened.lane).toMatchObject({ state: "open", archived: false });
    expect((await runWith(h, projectStatus(dir))).board).toContain("lanes: a=open");
    await runWith(h, laneClose(dir, "a"));
    await runWith(h, projectReview(dir, { note: "closed again" }));
    const archived = await runWith(h, projectReview(dir, { note: "done", decision: "archive" }));
    expect(archived.project.state).toBe("archived");
    expect(h.herdr.tokens.get("w1")?.progress).toBe("🐑 archived");
  });
});
