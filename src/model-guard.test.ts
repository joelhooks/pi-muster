import { join } from "node:path";
import { ProcError } from "./errors.ts";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentClose, agentLaunchForeground as agentLaunch, laneOpen, projectOpen, projectStatus, projectUpdate } from "./ops.ts";
import { liveProc } from "./runtime.ts";
import { promptWithProof } from "./herdr.ts";
import { load, mutate } from "./store.ts";
import { stepAgent } from "./machines.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

const table = `provider       model                     context  max-out  thinking  images
claude-bridge  claude-opus-5-5           1M       128K     yes       yes
claude-bridge  claude-fable-5-1          1M       128K     yes       yes
claude-bridge  claude-sonnet-5-5         1M       128K     yes       yes
openai-codex   gpt-6.1-sol               400K     128K     yes       yes
`;
beforeEach(() => {
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const run = liveProc.run;
  vi.spyOn(liveProc, "run").mockImplementation((command, args, options) => command === "pi"
    ? Effect.succeed({ code: 0, stdout: table, stderr: "" }) : run(command, args, options));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup(slug = "probe") {
  const h = harness();
  h.proc = liveProc;
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug, outcome: "model guard", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "test" }));
  const launch = (model?: string) => agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "probe", label: "worker", cwd: dir, prompt: "start", ...(model ? { model } : {}) });
  return { h, dir, launch };
}
it("refuses an unauthenticated route before pane or catalog allocation", async () => {
  const { h, dir, launch } = await setup();
  const panes = [...h.herdr.panes.keys()];
  const error = await failWith(h, launch("anthropic/claude-opus-5-5"));
  expect(error.message).toContain("use claude-bridge/claude-opus-5-5");
  expect([...h.herdr.panes.keys()]).toEqual(panes);
  expect((await runWith(h, load(dir))).agents).toEqual([]);
});
it.each([ ["opus", "claude-bridge/claude-opus-5-5"], ["sol", "openai-codex/gpt-6.1-sol"] ])("resolves %s in launch and policy", async (alias, model) => {
  const { h, dir, launch } = await setup();
  const update = await runWith(h, projectUpdate(dir, { policy: { roles: { worker: { model: alias } } } }));
  expect(update.policy).toHaveProperty("aliases.opus", "claude-bridge/claude-opus-5-5");
  const result = await runWith(h, launch());
  expect(result.row.profile.model).toBe(model);
  expect(result.proof?.state).toBe("proven");
  const explicit = await runWith(h, agentLaunch(dir, { action: "launch", name: "explicit", role: "worker", lane: "probe", label: "explicit", cwd: dir, model: alias }));
  expect(explicit.row.profile.model).toBe(model);
});
it.each(["sonnet", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5-5", "fable", "fable:high", "claude-bridge/claude-fable-5-1", "nope"])("rejects forbidden/unknown choice %s", async (model) => {
  const { h, launch } = await setup();
  const error = await failWith(h, launch(model));
  expect(error.message).toMatch(model.includes("sonnet") ? /Sonnet is not used/ : model.includes("fable") ? /Fable is off fleet-wide \(Joel, 2026-10-04\); use opus/ : /aliases: opus, sol$/);
});
it("allows Joel's named front-desk Sonnet route there only, and Fable nowhere", async () => {
  const front = await setup("front-desk");
  const update = await runWith(front.h, projectUpdate(front.dir, { policy: { roles: { worker: { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" } } } }));
  expect(update.policy.roles.worker).toMatchObject({ model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" });
  expect((await runWith(front.h, front.launch())).row.profile.model).toBe("claude-bridge/claude-sonnet-5-5");
  expect((await failWith(front.h, projectUpdate(front.dir, { policy: { roles: { judge: { model: "claude-bridge/claude-sonnet-5" } } } }))).message).toContain("Sonnet is not used");
  expect((await failWith(front.h, projectUpdate(front.dir, { policy: { roles: { judge: { model: "claude-bridge/claude-fable-5-1" } } } }))).message).toContain("Fable is off");
  const other = await setup("not-front-desk");
  expect((await failWith(other.h, projectUpdate(other.dir, { policy: { roles: { worker: { model: "claude-bridge/claude-sonnet-5-5" } } } }))).message).toContain("Sonnet is not used");
});
it("lets a worker opt into Sonnet 5.5 by explicit choice only, in any project", async () => {
  const { h, dir, launch } = await setup("drovr");
  const worker = await runWith(h, launch("claude-bridge/claude-sonnet-5-5:medium"));
  expect(worker.row.profile).toMatchObject({ model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" });
  for (const role of ["judge", "boss", "hawk"] as const) {
    const error = await failWith(h, agentLaunch(dir, { action: "launch", name: role, role, lane: "probe", label: role, cwd: dir, prompt: "start", model: "claude-bridge/claude-sonnet-5-5" }));
    expect(error.message).toContain("Sonnet is not used");
  }
  expect((await failWith(h, projectUpdate(dir, { policy: { roles: { worker: { model: "claude-bridge/claude-sonnet-5-5" } } } }))).message).toContain("Sonnet is not used");
  const bare = await failWith(h, agentLaunch(dir, { action: "launch", name: "bare", role: "worker", lane: "probe", label: "bare", cwd: dir, prompt: "start", model: "sonnet" }));
  expect(bare.message).toContain("Sonnet is not used");
});
it.each(["nonzero", "empty", "timeout"])("allows a %s model listing with a skip note", async (kind) => {
  const { h, launch } = await setup();
  const run = vi.mocked(liveProc.run).getMockImplementation()!;
  vi.mocked(liveProc.run).mockImplementation((command, args, options) => command === "pi"
    ? kind === "timeout"
      ? Effect.fail(new ProcError({ command: "pi --list-models", code: null, stderr: "", message: "timed out after 20000ms" }))
      : Effect.succeed({ code: kind === "nonzero" ? 1 : 0, stdout: "", stderr: kind === "nonzero" ? "offline" : "" })
    : run(command, args, options));
  const result = await runWith(h, launch("sol"));
  expect(result.notes.join("\n")).toContain(`model check skipped: ${kind === "nonzero" ? "offline" : kind === "empty" ? "empty" : "timed out"}`);
});
it("checks exactly once in launch cwd with a 20s timeout", async () => {
  const { h, dir, launch } = await setup();
  await runWith(h, launch("sol"));
  expect(vi.mocked(liveProc.run).mock.calls.filter(([command]) => command === "pi")).toEqual([["pi", ["--list-models"], { cwd: dir, timeoutMs: 20_000 }]]);
});
it.each(["fork", "restore"] as const)("refuses an unauthenticated %s before creating a pane or changing catalog", async (action) => {
  const { h, dir, launch } = await setup();
  await runWith(h, launch("sol"));
  if (action === "restore") await runWith(h, agentClose(dir, { name: "worker" }));
  const before = await runWith(h, load(dir));
  const panes = [...h.herdr.panes.keys()];
  const error = await failWith(h, agentLaunch(dir, { action, name: action === "fork" ? "forked" : "worker", from: "worker", model: "anthropic/claude-opus-5-5", prompt: "start" }));
  expect(error.message).toContain("use claude-bridge/claude-opus-5-5");
  expect([...h.herdr.panes.keys()]).toEqual(panes);
  expect(await runWith(h, load(dir))).toEqual(before);
});
it("keeps clean argv proof proven; explicit re-prompts retain rate-limit warnings", async () => {
  const { h, launch } = await setup();
  const handle = h.herdr.handle.bind(h.herdr);
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read"
    ? { type: "pane_read", read: { text: "Error: rate limit exceeded" } } : handle(method, params));
  const result = await runWith(h, launch("sol"));
  expect(result.row.delivery).toBe("proven");
  expect(result.proof).toMatchObject({ state: "proven", via: "argv" });
  const proof = await runWith(h, promptWithProof(result.row.pane!.paneId, "follow-up"));
  expect(proof).toMatchObject({ state: "proven", warning: "Error: rate limit exceeded" });
});
it("rejects forbidden policy before writing it", async () => {
  const { h, dir } = await setup();
  const before = await runWith(h, load(dir));
  const error = await failWith(h, projectUpdate(dir, { policy: { roles: { worker: { model: "sonnet" } } } }));
  expect(error.message).toContain("Sonnet is not used");
  expect(await runWith(h, load(dir))).toEqual(before);
});
it("rejects a first assistant error after argv submission, preserving the pane", async () => {
  const { h, dir, launch } = await setup();
  h.herdr.firstTurn = "error";
  h.herdr.firstTurnError = "Error: No API key found for anthropic";
  const result = await runWith(h, launch("sol"));
  expect(result.proof).toMatchObject({ state: "unproven", firstTurn: true, detail: expect.stringContaining("No API key found") });
  const row = (await runWith(h, load(dir))).agents[0];
  expect(row?.state).toBe("running");
  expect(row?.delivery).toBe("unproven");
  expect(h.herdr.panes.has(row?.pane?.paneId ?? "")).toBe(true);
  expect(row?.events?.at(-1)).toMatchObject({ type: "FIRST_TURN", detail: expect.stringContaining("No API key found") });
});
it.each(["idle", "startup"])("records model failures even with %s instead of a model turn", async (phase) => {
  const { h, dir, launch } = await setup();
  h.herdr.promptWorking = false;
  if (phase === "startup") h.herdr.startSessions = false;
  const handle = h.herdr.handle.bind(h.herdr);
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read"
    ? { type: "pane_read", read: { text: "Error: Unknown model bad" } } : handle(method, params));
  if (phase === "idle") {
    h.herdr.firstTurn = "error";
    h.herdr.firstTurnError = "Error: Unknown model bad";
    const result = await runWith(h, launch("sol"));
    expect(result.proof).toMatchObject({ state: "unproven", firstTurn: true, detail: expect.stringContaining("Unknown model bad") });
    const row = (await runWith(h, load(dir))).agents[0];
    expect(row?.delivery).toBe("unproven");
    expect(row?.events?.at(-1)).toMatchObject({ type: "FIRST_TURN", detail: expect.stringContaining("Unknown model bad") });
  } else {
    const error = await failWith(h, launch("sol"));
    expect(error.message).toContain("delivery: unproven (model error: Error: Unknown model bad)");
    const row = (await runWith(h, load(dir))).agents[0];
    expect(row?.state).toBe("failed");
    expect(row?.events?.at(-1)?.detail).toBe("Error: Unknown model bad");
  }
});
it.each(["running"] as const)("status flags model errors on %s without adoption or nudging, then fails on act", async (state) => {
  const { h, dir, launch } = await setup();
  await runWith(h, launch("sol"));
  const handle = h.herdr.handle.bind(h.herdr);
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read"
    ? { type: "pane_read", read: { text: "Error: No API key found for anthropic" } } : handle(method, params));
  await runWith(h, mutate(dir, (project) => Effect.gen(function* () {
    const row = project.agents[0];
    if (!row) throw new Error("missing launched row");
    let next = row.state;

    return [{ ...project, agents: [{ ...row, state: next }] }, undefined] as const;
  })));
  const preview = await runWith(h, projectStatus(dir, { act: false }));
  expect(preview.board).toContain("FAILED (model error: Error: No API key found for anthropic)");
  expect((await runWith(h, load(dir))).agents[0]?.state).toBe(state);
  await runWith(h, projectStatus(dir, { act: true }));
  expect((await runWith(h, load(dir))).agents[0]?.state).toBe("failed");
  await runWith(h, projectStatus(dir, { act: true }));
  expect((await runWith(h, load(dir))).agents[0]?.state).toBe("failed");
});

it.each([
  ["working prose", "authentication middleware returns 401", true],
  ["working Pi error", "Error: No API key found for anthropic.", true],
  ["idle prose", "authentication middleware returns 401", false],
  ["old error", "Error: No API key found for anthropic.\nTests passed; continuing work", false],
] as const)("does not fail healthy status for %s", async (_case, output, working) => {
  const { h, dir, launch } = await setup();
  await runWith(h, launch("sol"));
  const handle = h.herdr.handle.bind(h.herdr);
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => {
    if (method === "pane.read") return { type: "pane_read", read: { text: output } };
    const result = handle(method, params);
    if (method === "pane.list" && working && typeof result === "object" && result !== null && "panes" in result && Array.isArray(result.panes)) {
      return { ...result, panes: result.panes.map((pane) => ({ ...pane, agent_status: "working" })) };
    }
    return result;
  });
  const result = await runWith(h, projectStatus(dir, { act: true }));
  expect(result.board).not.toContain("FAILED (model error:");
  expect((await runWith(h, load(dir))).agents[0]?.state).toBe("running");
});
it.each(["reported", "verified", "landed", "closed"] as const)("keeps %s work finished even with a Pi error line", async (state) => {
  const { h, dir, launch } = await setup();
  await runWith(h, launch("sol"));
  await runWith(h, mutate(dir, (project) => Effect.gen(function* () {
    const row = project.agents[0];
    if (!row) throw new Error("missing row");
    let next = yield* stepAgent(row.name, row.state, { type: "REPORT" });
    if (state === "verified") next = yield* stepAgent(row.name, next, { type: "VERIFY" });
    if (state === "landed") next = yield* stepAgent(row.name, next, { type: "LAND" });
    if (state === "closed") next = yield* stepAgent(row.name, next, { type: "CLOSE" });
    return [{ ...project, agents: [{ ...row, state: next }] }, undefined] as const;
  })));
  const handle = h.herdr.handle.bind(h.herdr);
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read"
    ? { type: "pane_read", read: { text: "Error: No API key found for anthropic." } } : handle(method, params));
  const result = await runWith(h, projectStatus(dir, { act: true }));
  expect(result.board).not.toContain("FAILED (model error:");
  expect((await runWith(h, load(dir))).agents[0]?.state).toBe(state);
});
