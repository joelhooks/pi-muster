import { join } from "node:path";
import { Effect } from "effect";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { agentGet, promptWithProof } from "./herdr.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { agentRewind } from "./rewind.ts";
import { machineConfig, onRemote } from "./remote.ts";
import { Comms, Herdr, MusterEnv, Proc, liveProc } from "./runtime.ts";
import { mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

async function setup(machine: "local" | "remote") {
  const h = harness();
  h.sleep = ms => { h.now = new Date(h.now.getTime() + ms); };
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "ready", outcome: "readiness", reviewTrigger: "weekly", criticalPath: [], nextAction: "test", space: "w1", ephemeral: true, deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "test" }));
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", cwd: dir, label: "worker" }));
  const pane = h.herdr.panes.get(row.pane!.paneId)!;
  const tree = SessionManager.open(row.sessionFile!);
  tree.appendMessage({ role: "user", content: "Read source", timestamp: 1 });
  const target = tree.appendMessage({ role: "assistant", content: [{ type: "text", text: "Read" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6.1-sol", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  tree.appendMessage({ role: "user", content: "Wrong instruction", timestamp: 2 });
  const base = h.proc;
  h.proc = { run: (command, args, options) => command === "ssh"
    ? liveProc.run("sh", ["-c", args.at(-1)!], options)
    : base.run(command, args, options) };
  if (machine === "remote") await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(agent => ({ ...agent, machine })) }, undefined] as const)));
  const run = <A, E>(program: Effect.Effect<A, E, Herdr | MusterEnv | Proc | Comms>) => runWith(h, Effect.gen(function* () {
    const env = yield* MusterEnv;
    return yield* program.pipe(Effect.provideService(MusterEnv, { ...env,
      machines: { remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: process.cwd(), workerWorktree: h.workerWorktree, env: {}, wrap: [] } },
      remoteHerdr: () => Effect.succeed(h.herdr.client()),
    }));
  }));
  const prompt = () => machine === "local" ? run(promptWithProof(pane.pane_id, "Corrected work")) : run(Effect.gen(function* () {
    const config = yield* machineConfig(machine);
    return yield* onRemote(machine, config, promptWithProof(pane.pane_id, "Corrected work"));
  }));
  const rewind = () => run(agentRewind(dir, { name: row.name, to: target }));
  const original = h.herdr.handle.bind(h.herdr);
  h.herdr.handle = (method, params) => {
    if (method === "pane.send_input" && String(params.text).startsWith("/muster-rewind")) tree.branchWithSummary(target, "Corrected branch");
    return original(method, params);
  };
  h.herdr.calls.length = 0;
  return { h, pane, target, prompt, rewind };
}

for (const machine of ["local", "remote"] as const) describe(`${machine} finished-agent readiness`, () => {
  it.each(["idle", "done"] as const)("re-prompts %s exactly once with fresh first-turn evidence", async status => {
    const s = await setup(machine); s.pane.agent_status = status;
    expect(await s.prompt()).toMatchObject({ state: "proven" });
    expect(s.h.herdr.typedPrompts).toEqual(["Corrected work"]);
    expect(s.h.herdr.calls.filter(c => c.method === "agent.prompt")).toHaveLength(1);
  });
  it.each(["idle", "done"] as const)("rewinds %s exactly once without waiting", async status => {
    const s = await setup(machine); s.pane.agent_status = status;
    expect(await s.rewind()).toMatchObject({ entryId: s.target, evidence: expect.any(String) });
    expect(s.h.herdr.calls.filter(c => c.method === "pane.send_input")).toHaveLength(1);
    expect(s.h.herdr.calls.some(c => c.method === "agent.wait")).toBe(false);
  });
  it.each(["blocked", "unknown", "pending", "foreign"] as const)("refuses %s with a named reason and no submission", async reason => {
    const s = await setup(machine);
    s.pane.agent_status = reason === "blocked" || reason === "unknown" ? reason : "done";
    if (reason === "pending") s.h.herdr.readinessPending = 100;
    if (reason === "foreign") s.pane.agent = "claude";
    expect(await s.prompt()).toMatchObject({ state: "unproven", detail: expect.stringContaining(reason) });
    s.h.herdr.readinessPending = reason === "pending" ? 100 : 0;
    await expect(s.rewind()).rejects.toThrow(reason);
    expect(s.h.herdr.typedPrompts).toEqual([]);
    expect(s.h.herdr.calls.some(c => c.method === "pane.send_input" || c.method === "pane.send_keys")).toBe(false);
  });
  it("interrupts working once and accepts a done wait result", async () => {
    const s = await setup(machine); s.pane.agent_status = "working";
    const original = s.h.herdr.handle.bind(s.h.herdr);
    s.h.herdr.handle = (method, params) => {
      if (method === "agent.wait") s.pane.agent_status = "done";
      return original(method, params);
    };
    expect(await s.rewind()).toMatchObject({ entryId: s.target });
    expect(s.h.herdr.calls.filter(c => c.method === "pane.send_keys")).toHaveLength(1);
    expect(s.h.herdr.calls.find(c => c.method === "agent.wait")?.params.until).toEqual(["idle", "done"]);
    expect(s.h.herdr.calls.filter(c => c.method === "pane.send_input")).toHaveLength(1);
  });
  it("does not retry a done agent after an unproven submission", async () => {
    const s = await setup(machine); s.pane.agent_status = "done"; s.h.herdr.promptWorking = false;
    expect(await s.prompt()).toMatchObject({ state: "unproven", submission: "submitted" });
    expect(s.h.herdr.typedPrompts).toEqual(["Corrected work"]);
    expect(s.h.herdr.calls.filter(c => c.method === "agent.prompt")).toHaveLength(1);
  });
  it("refuses a foreign catalog name even when kind, terminal and session match", async () => {
    const s = await setup(machine); s.pane.name = "other-worker";
    await expect(s.rewind()).rejects.toThrow("foreign");
    expect(s.h.herdr.calls.some(c => c.method === "pane.send_input" || c.method === "pane.send_keys")).toBe(false);
  });
});

describe("FakeHerdr identity and status", () => {
  it.each(["idle", "working", "blocked", "done", "unknown"] as const)("preserves %s and keeps kind separate from name", async status => {
    const h = harness(); const pane = h.herdr.addPane("w1", "t", h.root);
    pane.agent = "claude"; pane.name = "worker"; pane.agent_status = status;
    expect(await runWith(h, agentGet(pane.pane_id))).toMatchObject({ agent: "claude", name: "worker", agent_status: status });
    pane.name = null;
    expect(await runWith(h, agentGet(pane.pane_id))).not.toHaveProperty("name");
  });
});
