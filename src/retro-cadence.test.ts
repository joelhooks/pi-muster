import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeProject } from "./domain.ts";
import { agentLaunchForeground as agentLaunch, laneClose, laneOpen, projectOpen } from "./ops.ts";
import { FakeHerdr, harness, makeRepo, runWith } from "./test-support.ts";
import { Effect } from "effect";
import { MusterEnv, Proc, type EnvShape, type ProcShape } from "./runtime.ts";
import { flowLine } from "./tokens.ts";
import { retroCadence } from "./retro-cadence.ts";
import { projectPath } from "./store.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  const { project } = await runWith(h, projectOpen({ dir, slug: "retro", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  const { lane } = await runWith(h, laneOpen(dir, { slug: "review", kind: "retro", label: "🔁 retro", goal: "review" }));
  return { h, dir, project, lane };
}

describe("retro cadence", () => {
  for (const count of [0, 1, 2, 3]) for (const age of [86_399_999, 86_400_000, 86_400_001]) for (const cursor of [false, true]) {
    it(`${count} closed, ${age} ms, cursor ${cursor}`, async () => {
      const { h, project, lane } = await setup();
      const at = new Date(h.now.getTime() - age).toISOString();
      const p = decodeProject({ ...project, ...(cursor ? { lastRetroAt: at } : {}), lanes: Array.from({ length: count }, (_, i) => ({ ...lane, slug: `work-${i}`, kind: "work", state: "closed", closedAt: cursor ? h.now.toISOString() : at })) });
      expect(retroCadence(p, h.now.getTime())).toMatchObject({ count, due: count >= 3 || count >= 1 && age >= 86_400_000 });
    });
  }

  it("defaults a retro judge to its roster alternate", async () => {
    const { h, dir } = await setup();
    mkdirSync(join(h.home, ".config", "muster"), { recursive: true });
    writeFileSync(join(h.home, ".config", "muster", "roster.json"), JSON.stringify({ version: 1, roles: { judge: { model: "claude-bridge/claude-opus-5-5", alternates: [{ model: "openai-codex/gpt-6-astra", thinking: "xhigh", useFor: ["retro"] }] } } }));
    const result = await runWith(h, agentLaunch(dir, { action: "launch", name: "reviewer", role: "judge", lane: "review", label: "🔎 judge", cwd: dir }));
    expect(result.row.profile).toMatchObject({ model: "openai-codex/gpt-6-astra", thinking: "xhigh" });
    expect(result.argv).toContain("openai-codex/gpt-6-astra:xhigh");
  });
  it.each([
    { kind: "retro", model: "openai-codex/gpt-6.1-sol", thinking: "medium", expected: "openai-codex/gpt-6.1-sol", level: "medium", alternate: true },
    { kind: "retro", model: undefined, thinking: "high", expected: "openai-codex/gpt-6-astra", level: "high", alternate: true },
    { kind: "work", model: undefined, thinking: undefined, expected: "claude-bridge/claude-opus-5-5", level: "high", alternate: true },
    { kind: "retro", model: undefined, thinking: undefined, expected: "claude-bridge/claude-opus-5-5", level: "high", alternate: false },
  ] as const)("judge selection $kind/$model/$thinking/$alternate", async ({ kind, model, thinking, expected, level, alternate }) => {
    const { h, dir } = await setup();
    mkdirSync(join(h.home, ".config", "muster"), { recursive: true });
    writeFileSync(join(h.home, ".config", "muster", "roster.json"), JSON.stringify({ version: 1, roles: { judge: { model: "claude-bridge/claude-opus-5-5", alternates: alternate ? [{ model: "openai-codex/gpt-6-astra", thinking: "xhigh", useFor: ["retro"] }] : [] } } }));
    if (kind === "work") await runWith(h, laneOpen(dir, { slug: "work", goal: "ship", label: "work" }));
    const result = await runWith(h, agentLaunch(dir, { action: "launch", name: "reviewer", role: "judge", lane: kind === "work" ? "work" : "review", label: "🔎 judge", cwd: dir, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }));
    expect(result.row.profile).toMatchObject({ model: expected, thinking: level });
    expect(result.notes.join("\n").includes('missing roster judge alternate with useFor: "retro"')).toBe(!alternate);
  });

  it("defaults a remote retro judge to the same alternate", async () => {
    const { h, dir } = await setup();
    mkdirSync(join(h.home, ".config", "muster"), { recursive: true });
    writeFileSync(join(h.home, ".config", "muster", "roster.json"), JSON.stringify({ version: 1, roles: { judge: { alternates: [{ model: "openai-codex/gpt-6-astra", thinking: "xhigh", useFor: ["retro"] }] } } }));
    const remote = new FakeHerdr(h.home);
    const proc: ProcShape = { run: (command, args, options) => {
      if (command !== "ssh") return h.proc.run(command, args, options);
      const script = args.at(-1) ?? "";
      if (["'node' '-e'", "'git'", "'mkdir'", "'mktemp'"].some(part => script.includes(part))) return h.proc.run("sh", ["-c", script], { ...options, cwd: dir });
      return Effect.succeed({ code: 0, stdout: script.includes("'printenv' 'PATH'") ? "/usr/bin\n" : "", stderr: "" });
    } };
    const env: EnvShape = {
      home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/owner/muster", workerWorktree: h.workerWorktree,
      createId: () => "remote-id", sleep: ms => Effect.sync(() => h.sleep(ms)), emitPaneClose: h.emitPaneClose,
      machines: { remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/remote/muster", workerWorktree: h.workerWorktree, env: {}, wrap: [] } },
      remoteHerdr: () => Effect.succeed(remote.client()),
    };
    const result = await runWith(h, agentLaunch(dir, { action: "launch", machine: "remote", name: "remote-reviewer", role: "judge", lane: "review", label: "🔎 judge", cwd: dir, noSkills: true }).pipe(Effect.provideService(MusterEnv, env), Effect.provideService(Proc, proc)));
    expect(result.row.profile).toMatchObject({ model: "openai-codex/gpt-6-astra", thinking: "xhigh" });
    expect(result.argv).toContain("openai-codex/gpt-6-astra:xhigh");
  });

  it("close and flow agree on the day rule and close names the judge model", async () => {
    const { h, dir, project, lane } = await setup();
    mkdirSync(join(h.home, ".config", "muster"), { recursive: true });
    writeFileSync(join(h.home, ".config", "muster", "roster.json"), JSON.stringify({ version: 1, roles: { judge: { alternates: [{ model: "openai-codex/gpt-6-astra", thinking: "xhigh", useFor: ["retro"] }] } } }));
    const at = new Date(h.now.getTime() - 86_400_000).toISOString();
    const p = decodeProject({ ...project, lanes: [{ ...lane, slug: "old", kind: "work", state: "closed", closedAt: at }, { ...lane, slug: "new", kind: "work", root: null }] });
    writeFileSync(projectPath(dir), JSON.stringify(p));
    const result = await runWith(h, laneClose(dir, "new"));
    expect(result.retro).toContain("2 lanes closed since the last retro (1d)");
    expect(result.retro).toContain("judge model: openai-codex/gpt-6-astra:xhigh");
    expect(flowLine(p, h.now.getTime())).toContain("retro: due (1d, 1 closed)");
  });

  it("ignores consumed, discarded, and non-work lanes and uses the oldest close", async () => {
    const { h, project, lane } = await setup();
    const old = new Date(h.now.getTime() - 86_400_000).toISOString();
    const fresh = h.now.toISOString();
    const p = decodeProject({ ...project, lanes: [
      { ...lane, slug: "old", kind: "work", state: "closed", closedAt: old },
      { ...lane, slug: "fresh", kind: "work", state: "closed", closedAt: fresh },
      { ...lane, slug: "discard", kind: "work", state: "closed", discarded: true, closedAt: old },
      { ...lane, state: "closed", closedAt: old },
    ] });
    expect(retroCadence(p, h.now.getTime())).toMatchObject({ count: 2, reason: "day" });
    expect(retroCadence({ ...p, lastRetroAt: old }, h.now.getTime())).toMatchObject({ count: 1, reason: "day" });
    expect(retroCadence({ ...p, lastRetroAt: fresh }, h.now.getTime())).toMatchObject({ count: 0, due: false });
    expect(flowLine(decodeProject({ ...p, lanes: [...p.lanes, { ...lane, slug: "running" }] }), h.now.getTime())).toContain("retro: running running");
  });

  it("shows the one-day due state in the flow line", async () => {
    const { h, project, lane } = await setup();
    const closed = new Date(h.now.getTime() - 86_400_000).toISOString();
    const p = decodeProject({ ...project, lanes: [{ ...lane, kind: "work", state: "closed", closedAt: closed }] });
    expect(flowLine(p, h.now.getTime())).toContain("retro: due (1d, 1 closed)");
  });
});
