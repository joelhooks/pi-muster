import { join } from "node:path";
import { ProcError } from "./errors.ts";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentClose, agentLaunch, laneOpen, projectOpen, projectStatus, projectUpdate } from "./ops.ts";
import { liveProc } from "./runtime.ts";
import { load, mutate } from "./store.ts";
import { stepAgent } from "./machines.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

const table = `provider       model                     context  max-out  thinking  images
claude-bridge  claude-opus-5-5           1M       128K     yes       yes
claude-bridge  claude-fable-5-1          1M       128K     yes       yes
openai-codex   gpt-6.1-sol               400K     128K     yes       yes
`;
beforeEach(() => {
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const run = liveProc.run;
  vi.spyOn(liveProc, "run").mockImplementation((command, args, options) => command === "pi"
    ? Effect.succeed({ code: 0, stdout: table, stderr: "" }) : run(command, args, options));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  const h = harness();
  h.proc = liveProc;
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "model guard", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
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
it.each([ ["opus", "claude-bridge/claude-opus-5-5"], ["fable", "claude-bridge/claude-fable-5-1"], ["sol", "openai-codex/gpt-6.1-sol"] ])("resolves %s in launch and policy", async (alias, model) => {
  const { h, dir, launch } = await setup();
  const update = await runWith(h, projectUpdate(dir, { policy: { roles: { worker: { model: alias } } } }));
  expect(update.policy).toHaveProperty("aliases.opus", "claude-bridge/claude-opus-5-5");
  const result = await runWith(h, launch());
  expect(result.row.profile.model).toBe(model);
  expect(result.proof?.state).toBe("proven");
  const explicit = await runWith(h, agentLaunch(dir, { action: "launch", name: "explicit", role: "worker", lane: "probe", label: "explicit", cwd: dir, model: alias }));
  expect(explicit.row.profile.model).toBe(model);
});
it.each(["sonnet", "anthropic/claude-sonnet-5", "nope"])("rejects forbidden/unknown choice %s", async (model) => {
  const { h, launch } = await setup();
  const error = await failWith(h, launch(model));
  expect(error.message).toMatch(model.includes("sonnet") ? /Sonnet is not used/ : /aliases:.*fable.*opus.*sol/);
});
it.each(["nonzero", "empty", "timeout"])("allows a %s model listing with a skip note", async (kind) => {
  const { h, launch } = await setup();
  vi.mocked(liveProc.run).mockReturnValue(kind === "timeout"
    ? Effect.fail(new ProcError({ command: "pi --list-models", code: null, stderr: "", message: "timed out after 20000ms" }))
    : Effect.succeed({ code: kind === "nonzero" ? 1 : 0, stdout: "", stderr: kind === "nonzero" ? "offline" : "" }));
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
it("keeps clean proof proven, and rate limits only warn", async () => {
  const { h, launch } = await setup();
  const handle = h.herdr.handle.bind(h.herdr);
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read"
    ? { type: "pane_read", read: { text: "rate limit exceeded" } } : handle(method, params));
  const result = await runWith(h, launch("sol"));
  expect(result.row.delivery).toBe("proven");
  expect(result.notes.join("\n")).toContain("model warning: rate limit exceeded");
});
it("rejects forbidden policy before writing it", async () => {
  const { h, dir } = await setup();
  const before = await runWith(h, load(dir));
  const error = await failWith(h, projectUpdate(dir, { policy: { roles: { worker: { model: "sonnet" } } } }));
  expect(error.message).toContain("Sonnet is not used");
  expect(await runWith(h, load(dir))).toEqual(before);
});
it("fails a working flash followed by a model error, preserving the pane", async () => {
  const { h, dir, launch } = await setup();
  const handle = h.herdr.handle.bind(h.herdr);
  let reads = 0;
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read"
    ? { type: "pane_read", read: { text: ++reads === 1 ? "clean" : "Error: No API key found for anthropic" } }
    : handle(method, params));
  const error = await failWith(h, launch("sol"));
  expect(error.message).toContain("delivery: unproven (model error: Error: No API key found for anthropic)");
  const row = (await runWith(h, load(dir))).agents[0];
  expect(row?.state).toBe("failed");
  expect(row?.delivery).toBe("unproven");
  expect(h.herdr.panes.has(row?.pane?.paneId ?? "")).toBe(true);
  expect(JSON.stringify(row)).toContain("No API key found");
});
it.each(["idle", "startup"])("records model failures even with %s instead of a model turn", async (phase) => {
  const { h, dir, launch } = await setup();
  h.herdr.promptWorking = false;
  if (phase === "startup") h.herdr.startSessions = false;
  const handle = h.herdr.handle.bind(h.herdr);
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read"
    ? { type: "pane_read", read: { text: "Unknown model bad" } } : handle(method, params));
  const error = await failWith(h, launch("sol"));
  expect(error.message).toContain("delivery: unproven (model error: Unknown model bad)");
  const row = (await runWith(h, load(dir))).agents[0];
  expect(row?.state).toBe("failed");
  expect(row?.events?.at(-1)?.detail).toBe("Unknown model bad");
});
it.each(["running", "reported", "verified", "landed", "interrupted"] as const)("status flags model errors on %s without adoption or nudging, then fails on act", async (state) => {
  const { h, dir, launch } = await setup();
  await runWith(h, launch("sol"));
  const handle = h.herdr.handle.bind(h.herdr);
  vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read"
    ? { type: "pane_read", read: { text: "Error: No API key found for anthropic" } } : handle(method, params));
  await runWith(h, mutate(dir, (project) => Effect.gen(function* () {
    const row = project.agents[0];
    if (!row) throw new Error("missing launched row");
    let next = row.state;
    if (state === "reported" || state === "verified" || state === "landed") next = yield* stepAgent(row.name, next, { type: "REPORT" });
    if (state === "verified") next = yield* stepAgent(row.name, next, { type: "VERIFY" });
    if (state === "landed") next = yield* stepAgent(row.name, next, { type: "LAND" });
    if (state === "interrupted") next = yield* stepAgent(row.name, next, { type: "PANE_GONE" });
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
