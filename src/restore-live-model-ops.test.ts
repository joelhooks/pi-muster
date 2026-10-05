import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentClose, agentLaunch, laneOpen, projectOpen, projectStatus } from "./ops.ts";
import { liveProc } from "./runtime.ts";
import { load, mutate } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";
const table = `provider model context max-out thinking images
openai-codex gpt-6.1-sol 272K 128K yes yes
claude-bridge claude-opus-5-5 1M 128K yes yes
`;
beforeEach(() => {
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const run = liveProc.run;
  vi.spyOn(liveProc, "run").mockImplementation((command, args, options) => command === "pi" ? Effect.succeed({ code: 0, stdout: table, stderr: "" }) : run(command, args, options));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  const h = harness(); h.proc = liveProc;
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "restore", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "test" }));
  const launched = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "probe", label: "worker", cwd: dir, model: "sol", thinking: "high", prompt: "start" }));
  const file = launched.row.sessionFile!;
  const append = (...entries: unknown[]) => appendFileSync(file, "\n" + entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  return { h, dir, launched, append };
}
const switched = { type: "model_change", provider: "claude-bridge", modelId: "claude-opus-5-5", timestamp: "2026-10-05T17:40:09.345Z" };
it("close prints the switched route and restore persists the live profile and source receipt", async () => {
  const { h, dir, append } = await setup();
  append(switched, { type: "thinking_level_change", thinkingLevel: "medium" });
  const closed = await runWith(h, agentClose(dir, { name: "worker" }));
  expect(closed.restore.argv).toContain("claude-bridge/claude-opus-5-5:medium");
  expect(closed.notes.join("\n")).toContain("from session, switched 17:40Z");
  const restored = await runWith(h, agentLaunch(dir, { action: "restore", name: "worker" }));
  expect(restored.argv).toContain("claude-bridge/claude-opus-5-5:medium");
  expect(restored.row.profile).toMatchObject({ model: "claude-bridge/claude-opus-5-5", thinking: "medium" });
  expect(restored.notes.join("\n")).toContain("from session");
});
it("explicit restore model and thinking beat the session, including stored restore argv", async () => {
  const { h, dir, append } = await setup();
  append(switched, { type: "thinking_level_change", thinkingLevel: "medium" });
  await runWith(h, agentClose(dir, { name: "worker" }));
  const restored = await runWith(h, agentLaunch(dir, { action: "restore", name: "worker", model: "sol:low", thinking: "xhigh" }));
  expect(restored.argv).toContain("openai-codex/gpt-6.1-sol:xhigh");
  expect(restored.row.restore?.argv).toContain("openai-codex/gpt-6.1-sol:xhigh");
  expect(restored.notes.join("\n")).toContain("from explicit model");
});
it("refuses the session's forbidden model without changing catalog or panes", async () => {
  const { h, dir, append } = await setup();
  await runWith(h, agentClose(dir, { name: "worker" }));
  append({ ...switched, modelId: "claude-fable-5-1" });
  const before = await runWith(h, load(dir)); const panes = [...h.herdr.panes.keys()];
  expect((await failWith(h, agentLaunch(dir, { action: "restore", name: "worker" }))).message).toContain("Fable is off fleet-wide");
  expect(await runWith(h, load(dir))).toEqual(before);
  expect([...h.herdr.panes.keys()]).toEqual(panes);
});
it.each([434000, 230000])("guards %i tokens on restore, not close", async tokens => {
  const { h, dir, append } = await setup();
  append({ type: "message", message: { role: "assistant", usage: { totalTokens: tokens } } });
  await runWith(h, agentClose(dir, { name: "worker" }));
  if (tokens > 272000) {
    const before = await runWith(h, load(dir));
    expect((await failWith(h, agentLaunch(dir, { action: "restore", name: "worker" }))).message).toMatch(/434000.*272000.*claude-bridge\/claude-opus-5-5/);
    expect(await runWith(h, load(dir))).toEqual(before);
  } else {
    expect((await runWith(h, agentLaunch(dir, { action: "restore", name: "worker" }))).notes.join("\n")).toMatch(/230000.*272000.*warning/);
  }
});
it("listing failure warns and proceeds even when context is large", async () => {
  const { h, dir, append } = await setup();
  append({ type: "message", message: { role: "assistant", usage: { totalTokens: 434000 } } });
  await runWith(h, agentClose(dir, { name: "worker" }));
  const run = vi.mocked(liveProc.run).getMockImplementation()!;
  vi.mocked(liveProc.run).mockImplementation((command, args, options) => command === "pi" ? Effect.succeed({ code: 1, stdout: "", stderr: "offline" }) : run(command, args, options));
  const restored = await runWith(h, agentLaunch(dir, { action: "restore", name: "worker" }));
  expect(restored.notes.join("\n")).toMatch(/window unknown; warning/);
});
it("status adoption rebuilds switched restore argv", async () => {
  const { h, dir, append } = await setup();
  append(switched);
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, state: "interrupted" as const })) }, undefined] as const)));
  await runWith(h, projectStatus(dir, { act: true }));
  expect((await runWith(h, load(dir))).agents[0]?.restore?.argv).toContain("claude-bridge/claude-opus-5-5:high");
});
