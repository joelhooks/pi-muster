import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { HerdrApiError } from "@joelhooks/pi-bellwether/herdr-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentClose, agentLaunch, laneOpen, projectOpen, packetReport, packetVerify } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { FakeHerdr } from "./test-support.ts";
import { MusterEnv, Proc, liveProc, noEmitPaneClose, type EnvShape, type ProcShape } from "./runtime.ts";
import { harness, makeRepo, runWith, sh } from "./test-support.ts";

beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", ""); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "safe close", reviewTrigger: "weekly", nextAction: "close", criticalPath: [], space: "w1", sidebar: false, ephemeral: true, cadenceMinutes: 15, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "safe close", repo: dir }));
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", clone: true, noSkills: true }));
  return { h, dir, row };
}

describe("close live clone guard", () => {
  it("keeps a clone under a replacement pane, closes the row, then retires on retry", async () => {
    const { h, dir, row } = await setup();
    h.herdr.panes.delete(row.pane!.paneId);
    const cwd = join(row.cwd, "nested"); mkdirSync(cwd);
    const live = h.herdr.addPane("other-space", "other-tab", cwd);
    live.agent = "pi"; live.agent_status = "idle";
    const closed = await runWith(h, agentClose(dir, { name: row.name }));
    expect(closed.row.state).toBe("closed");
    expect((await runWith(h, load(dir))).agents[0]?.state).toBe("closed");
    expect(existsSync(row.cwd)).toBe(true);
    expect(closed.notes.join("\n")).toContain(`clone kept: ${live.pane_id} (pi idle) still runs in ${cwd}; close that pane, then agent_close again to retire the clone`);
    h.herdr.panes.delete(live.pane_id);
    await runWith(h, agentClose(dir, { name: row.name }));
    expect(existsSync(row.cwd)).toBe(false);
  });

  it("force does not bypass a live pane", async () => {
    const { h, dir, row } = await setup();
    const commit = sh(row.cwd, "rev-parse", "HEAD").trim();
    await runWith(h, packetReport({ dir, agent: row.name, owner: row.owner, cwd: row.cwd, commit, summary: "clean checkpoint", checks: [] }));
    await runWith(h, packetVerify(dir, commit));
    h.herdr.panes.delete(row.pane!.paneId);
    const live = h.herdr.addPane("w1", "t1", row.cwd); live.agent = "pi";
    const result = await runWith(h, agentClose(dir, { name: row.name, force: true }));
    expect(result.row.state).toBe("closed");
    expect(existsSync(row.cwd)).toBe(true);
    expect(result.notes.join("\n")).toContain(`clone kept: ${live.pane_id}`);
  });

  it("retires after closing its own pane and ignores sibling path prefixes", async () => {
    const { h, dir, row } = await setup();
    const sibling = `${row.cwd}-other`; mkdirSync(sibling);
    h.herdr.addPane("w1", "t1", sibling);
    await runWith(h, agentClose(dir, { name: row.name }));
    expect(h.herdr.panes.has(row.pane!.paneId)).toBe(false);
    expect(existsSync(row.cwd)).toBe(false);
  });

  it("keeps an adopted pane's clone without closing that pane", async () => {
    const { h, dir, row } = await setup();
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(agent => agent.name === row.name ? { ...agent, pane: { ...row.pane!, openedByMuster: false } } : agent) }, null] as const)));
    const result = await runWith(h, agentClose(dir, { name: row.name }));
    expect(result.row.state).toBe("closed");
    expect(h.herdr.panes.has(row.pane!.paneId)).toBe(true);
    expect(existsSync(row.cwd)).toBe(true);
    expect(result.notes.join("\n")).toContain(`clone kept: ${row.pane!.paneId}`);
  });

  it("resolves symlink aliases before comparing clone paths", async () => {
    const { h, dir, row } = await setup();
    h.herdr.panes.delete(row.pane!.paneId);
    const alias = join(h.root, "alias"); symlinkSync(row.cwd, alias);
    const live = h.herdr.addPane("w1", "t1", alias);
    const result = await runWith(h, agentClose(dir, { name: row.name }));
    expect(existsSync(row.cwd)).toBe(true);
    expect(result.notes.join("\n")).toContain(`clone kept: ${live.pane_id}`);
  });

  it("keeps the clone and closes a stale-bound row when pane listing fails", async () => {
    const { h, dir, row } = await setup();
    h.herdr.panes.delete(row.pane!.paneId);
    const client = h.herdr.client(); const request = client.request;
    vi.spyOn(h.herdr, "client").mockReturnValue({ ...client, request: req => req.method === "pane.list"
      ? Effect.fail(new HerdrApiError({ operation: "pane.list", code: "unavailable", message: "listing unavailable" }))
      : request(req) });
    const result = await runWith(h, agentClose(dir, { name: row.name }));
    expect(result.row.state).toBe("closed");
    expect(existsSync(row.cwd)).toBe(true);
    expect(result.notes.join("\n")).toContain("clone kept: cannot establish pane safety:");
    expect(result.notes.join("\n")).toContain("listing unavailable");
  });

  it("does not let an unrelated deleted cwd block clone retirement", async () => {
    const { h, dir, row } = await setup();
    h.herdr.addPane("w1", "t1", join(h.root, "missing"));
    const result = await runWith(h, agentClose(dir, { name: row.name }));
    expect(result.row.state).toBe("closed");
    expect(existsSync(row.cwd)).toBe(false);
  });

  it("keeps a clone when a deleted pane cwd lies under the raw clone path", async () => {
    const { h, dir, row } = await setup();
    const live = h.herdr.addPane("w1", "t1", join(row.cwd, "deleted"));
    const result = await runWith(h, agentClose(dir, { name: row.name }));
    expect(existsSync(row.cwd)).toBe(true);
    expect(result.notes.join("\n")).toContain(`clone kept: ${live.pane_id}`);
  });

  it.each(["raw", "resolved"] as const)("compares a deleted cwd against the %s root when the row uses a symlink", async root => {
    const { h, dir, row } = await setup();
    const alias = join(h.root, "clone-alias"); symlinkSync(row.cwd, alias);
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(agent => agent.name === row.name ? { ...agent, cwd: alias } : agent) }, null] as const)));
    const live = h.herdr.addPane("w1", "t1", join(root === "raw" ? alias : row.cwd, "deleted"));
    const result = await runWith(h, agentClose(dir, { name: row.name }));
    expect(existsSync(row.cwd)).toBe(true);
    expect(result.notes.join("\n")).toContain(`clone kept: ${live.pane_id}`);
  });

  it("skips a cwd-less pane with a note", async () => {
    const { h, dir, row } = await setup();
    const unknown = h.herdr.addPane("w1", "t1", "");
    const result = await runWith(h, agentClose(dir, { name: row.name }));
    expect(existsSync(row.cwd)).toBe(false);
    expect(result.notes.join("\n")).toContain(`pane ${unknown.pane_id} skipped: no cwd`);
  });

  it("checks the remote Herdr and resolves paths on that machine, then retires on retry", async () => {
    const { h, dir, row } = await setup();
    const remote = new FakeHerdr(h.home);
    const alias = join(h.root, "remote-alias"); symlinkSync(row.cwd, alias);
    const live = remote.addPane("remote-space", "remote-tab", alias); live.agent = "pi"; live.agent_status = "working";
    remote.addPane("remote-space", "remote-tab", dir);
    remote.addPane("remote-space", "remote-tab", join(h.root, "remote-deleted"));
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(agent => agent.name === row.name ? { ...agent, machine: "remote" } : agent) }, null] as const)));
    const env: EnvShape = { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: h.workerWorktree, createId: () => "remote-id", sleep: () => Effect.void, emitPaneClose: noEmitPaneClose,
      machines: { remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/muster", workerWorktree: h.workerWorktree, env: {}, wrap: [] } }, remoteHerdr: () => Effect.succeed(remote.client()) };
    const commands: string[] = [];
    const proc: ProcShape = { run: (command, args, options) => {
      if (command !== "ssh") return h.proc.run(command, args, options);
      commands.push(args.at(-1)!);
      return liveProc.run("sh", ["-c", args.at(-1)!], { cwd: h.home, timeoutMs: options.timeoutMs });
    } };
    const close = () => runWith(h, agentClose(dir, { name: row.name }).pipe(Effect.provideService(MusterEnv, env), Effect.provideService(Proc, proc)));
    const result = await close();
    expect(result.row.state).toBe("closed");
    expect(existsSync(row.cwd)).toBe(true);
    expect(result.notes.join("\n")).toContain(`clone kept: ${live.pane_id} (pi working)`);
    expect(commands.filter(command => command.includes("realpathSync"))).toHaveLength(1);
    expect(h.herdr.panes.has(row.pane!.paneId)).toBe(true);
    remote.panes.delete(live.pane_id);
    await close();
    expect(existsSync(row.cwd)).toBe(false);
  });
});
