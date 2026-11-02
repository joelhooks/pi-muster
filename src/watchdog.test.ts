import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeMachines, decodePolicy, decodeWatchdogProbes, decodeWatchdogTails, decodeWatchdogVerdict, mergePolicy, type AgentRow } from "./domain.ts";
import { artifactMtime, judgeProgress, judgeText, previousJudgment, progressFlags, registryJudge, remoteWatchdogScript, sessionProgress, watchdogFingerprint, watchdogLimits, watchdogTail } from "./watchdog.ts";
import { deskInboxItem, deskInboxUpdate, phoneSummary } from "./desk-inbox.ts";
import { agentLaunchForeground, laneOpen, projectOpen, projectStatus, projectUpdate } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { ProcError } from "./errors.ts";
import type { WatchdogJudge } from "./watchdog.ts";
import { MusterEnv, noEmitPaneClose } from "./runtime.ts";
import * as remote from "./remote.ts";

const limits = watchdogLimits();
const now = Date.parse("2026-11-01T12:00:00Z");
const signals = { now, artifactAt: now, artifact: "a", errors: [] as string[], turns: 0 };
const entry = (role: string, content: unknown, more = {}, at = now) => JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role, content, ...more } });
const verdict = JSON.stringify({ verdict: "stuck", why: "same failing check", nudge: "inspect the fixture" });

beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); vi.stubEnv("MUSTER_MACHINE", ""); vi.stubEnv("MUSTER_PROJECT", ""); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("free progress flags", () => {
  it("flags no artifact at the stall threshold (plant: stall)", () => {
    expect(progressFlags({ state: "running" }, { ...signals, artifactAt: now - 120 * 60_000 }, limits)).toEqual(["no artifact"]);
    expect(progressFlags({ state: "running" }, { ...signals, artifactAt: now - 119 * 60_000 }, limits)).toEqual([]);
  });
  it("flags identical repeated tool errors, not different errors (plant: errors)", () => {
    expect(progressFlags({ state: "silent" }, { ...signals, errors: ["bad", "bad", "bad"] }, limits)).toEqual(["repeated tool error"]);
    expect(progressFlags({ state: "running" }, { ...signals, errors: ["a", "b", "c"] }, limits)).toEqual([]);
  });
  it("flags turns without artifacts (plant: turns)", () => {
    expect(progressFlags({ state: "nudged" }, { ...signals, turns: 30 }, limits)).toEqual(["turns without artifact"]);
    expect(progressFlags({ state: "running" }, { ...signals, turns: 29 }, limits)).toEqual([]);
  });
  it("does not flag non-working rows and honors policy overrides", () => {
    expect(progressFlags({ state: "reported" }, { ...signals, turns: 100 }, limits)).toEqual([]);
    const policy = mergePolicy(decodePolicy({ watchdog: { model: "test/judge", repeatedErrors: 4 } }), decodePolicy({ watchdog: { progressStallMin: 1 } }));
    expect(watchdogLimits(policy)).toMatchObject({ model: "test/judge", repeatedErrors: 4, progressStallMin: 1, turnsWithoutArtifact: 30 });
    expect(() => decodePolicy({ watchdog: { errorWindow: 0 } })).toThrow();
  });
});

it("counts bounded tail errors and turns only after artifacts; successful outbound mail advances progress", () => {
  const text = [entry("assistant", [{ type: "toolCall", id: "mail", name: "ratking", arguments: { action: "send", to: "owner" } }], {}, now - 5000),
    entry("toolResult", "Delivered", { toolCallId: "mail" }, now - 4000),
    entry("assistant", [{ type: "thinking", thinking: "never send this" }, { type: "text", text: "working" }], {}, now - 3000),
    ...Array.from({ length: 3 }, () => entry("toolResult", [{ type: "text", text: "bad" }], { isError: true })),
  ].join("\n");
  const parsed = sessionProgress(text, now - 10_000, limits);
  expect(parsed).toMatchObject({ mailAt: now - 4000, artifactAt: now - 4000, turns: 1, errors: ["bad", "bad", "bad"] });
  expect(parsed.tail).not.toContain("never send this");
  expect(sessionProgress(text + "\n" + entry("toolResult", "okay"), now, { ...limits, errorWindow: 1 }).errors).toEqual([]);
  expect(sessionProgress(text.replace('"Delivered"', '"NOT DELIVERED"'), now - 10_000, limits).mailAt).toBe(0);
});

it.each(["secrets lease token", "sc fetch token", "op read vault/item", "op item get item", "printenv SERVICE", "env", "security find-generic-password", "cat config/.env", "cat auth.json"])("withholds sensitive bash results: %s (plant: bash)", command => {
  const text = [entry("assistant", [{ type: "toolCall", id: "lease", name: "bash", arguments: { command } }]), entry("toolResult", "leased-value", { toolCallId: "lease" })].join("\n");
  expect(sessionProgress(text, now - 1000, limits).tail).not.toContain("leased-value");
});
it("withholds a bare mixed-case 40-character token (plant: opaque)", () => {
  expect(judgeText("AbCdEf0123456789AbCdEf0123456789AbCdEf01", 1000, {})).toBe("[sensitive line withheld]");
});
it("keeps git sha1 and labelled sha256 but withholds bare 64-character hex (plant: hex)", () => {
  expect(judgeText("a".repeat(64), 1000, {})).toBe("[sensitive line withheld]");
  expect(judgeText("a".repeat(40), 1000, {})).toBe("a".repeat(40));
  expect(judgeText(`sha256: ${"a".repeat(64)}`, 1000, {})).toBe(`sha256: ${"a".repeat(64)}`);
  expect(judgeText(`commit ${"a".repeat(64)}`, 1000, {})).toBe("[sensitive line withheld]");
});
it.each([["AWS_SECRET_ACCESS_KEY=short-value", "AWS"], ["postgres://alice:pass@db.invalid/name", "DB URL"], ["eyJabc.def.gh", "JWT"]])("withholds %s (plant: %s)", (text) => {
  expect(judgeText(text!, 1000, {})).toBe("[sensitive line withheld]");
});
it("redacts credential lines and environment values before byte capping", () => {
  const safe = judgeText("normal\nAPI_KEY=super-secret\nBearer abcdef\nsk-test1234\n" + "秘密".repeat(4000), 8192, { SERVICE_TOKEN: "super-secret" });
  expect(safe).not.toMatch(/super-secret|abcdef|sk-test1234/);
  expect(Buffer.byteLength(safe)).toBeLessThanOrEqual(8192);
});
it("keeps the brief head and ordinary token-budget prose", () => {
  const text = "Outcome: ship\n" + "detail ".repeat(5000);
  expect(judgeText(text, 100, {}, "head")).toMatch(/^Outcome: ship/);
  expect(judgeText("tokens: now=123\ntoken budget is 30k", 100, {})).toBe("tokens: now=123\ntoken budget is 30k");
});
it("strictly decodes judge verdicts, rejecting multiline, extras and malformed JSON", async () => {
  expect(() => decodeWatchdogVerdict({ verdict: "stuck", why: "a\nb", nudge: "c" })).toThrow();
  expect(() => decodeWatchdogVerdict({ verdict: "stuck", why: "a", nudge: "c", execute: true })).toThrow();
  expect(await Effect.runPromise(judgeProgress(async () => "not JSON", "test/model", "brief", "tail"))).toContain("judge unavailable");
});
it("bounds a hung judge and aborts its signal", async () => {
  let signal: AbortSignal | undefined;
  const result = await Effect.runPromise(judgeProgress(async request => { signal = request.signal; return new Promise(() => {}); }, "test/model", "brief", "tail", 5));
  expect(result).toContain("timed out");
  expect(signal?.aborted).toBe(true);
});
it("never falls back when the named registry model is absent", async () => {
  const find = vi.fn(() => undefined);
  const judge = registryJudge({ find } as unknown as Parameters<typeof registryJudge>[0]);
  const line = await Effect.runPromise(judgeProgress(judge, "missing/model", "brief", "tail"));
  expect(find).toHaveBeenCalledExactlyOnceWith("missing", "model");
  expect(line).toContain("missing/model");
});

it("uses the real model registry lookup and auth shape with low thinking and bounded output", async () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  registry.registerProvider("cliproxy-codex", { baseUrl: "https://example.invalid", api: "openai-responses", apiKey: "test-placeholder", models: [{
    id: "gpt-5.6-terra", name: "Terra", reasoning: true, input: ["text"], contextWindow: 10000, maxTokens: 300,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }] });
  const completion = vi.fn<typeof ai.completeSimple>().mockResolvedValue({ content: [{ type: "text", text: verdict }], stopReason: "stop" } as Awaited<ReturnType<typeof ai.completeSimple>>);
  expect(registry.getAll().some(model => model.provider === "cliproxy-codex" && model.id === "gpt-5.6-terra")).toBe(true);
  const line = await Effect.runPromise(judgeProgress(registryJudge(registry, completion), limits.model, "brief", "tail"));
  expect(line).toContain("stuck — same failing check");
  expect(completion).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "cliproxy-codex", id: "gpt-5.6-terra" }), expect.any(Object), expect.objectContaining({ reasoning: "low", maxTokens: 300, apiKey: "test-placeholder" }));
});
it.each(["claude-bridge/claude-haiku-5-5", "another-provider/alias"])("refuses session-bound APIs regardless of provider name: %s (plant: API)", async model => {
  const find = vi.fn(() => ({ api: "claude-bridge" }));
  const auth = vi.fn(); const complete = vi.fn();
  const judge = registryJudge({ find, getApiKeyAndHeaders: auth } as unknown as Parameters<typeof registryJudge>[0], complete);
  const line = await Effect.runPromise(judgeProgress(judge, model, "brief", "tail"));
  expect(line).toBe("judge unavailable: claude-bridge is not a supported stateless HTTP API; set watchdog.model to a stateless provider");
  expect(find).toHaveBeenCalledTimes(1);
  expect(auth).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(watchdogLimits().model).toBe("cliproxy-codex/gpt-5.6-terra");
});
it("phone cap includes the trim marker and keeps full item details (plant: phone)", () => {
  const long = Array.from({ length: 130 }, (_, i) => `word${i}`).join(" ");
  expect(phoneSummary(long).split(/\s+/)).toHaveLength(100);
  expect(phoneSummary(long)).toMatch(/word98 \[trimmed\]$/);
  expect(phoneSummary("a\n b")).toBe("a\n b");
  const record = deskInboxItem({ project: "test", queueItem: { id: "item", ts: new Date(now).toISOString(), from: "desk", kind: "decision", title: long, body: "detail" },
    card: { id: "item", kind: "decision", title: long, why: long, group: "test", age: "", timeline: "", shows: [], not_shows: [], choices: [] } });
  expect(`${record.title} ${record.why}`.split(/\s+/)).toHaveLength(100);
  expect(record.body).toContain(long);
  expect(record.body).toContain("detail");
  expect(deskInboxUpdate({ project: "test", itemId: "item", state: "resolved", text: long }).text?.split(/\s+/)).toHaveLength(100);
});

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "watchdog", outcome: "ship", reviewTrigger: "weekly", nextAction: "finish the watchdog", space: "w1", ephemeral: true, deskExtension: null }));
  await runWith(h, projectUpdate(dir, { policy: { nudgeAfterMin: 999999, restartAfterMin: null } }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "ship", repo: dir }));
  const { row } = await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "worker", label: "Worker", role: "worker", lane: "work", cwd: dir, noSkills: true }));
  const patch = (change: Partial<AgentRow>) => runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: p.agents.map(r => r.name === row.name ? { ...r, ...change } : r) }, undefined] as const)));
  await patch({ createdAt: new Date(h.now.getTime() - 3 * 3600_000).toISOString() });
  h.herdr.agentStatus = "working";
  h.herdr.calls.length = 0;
  return { h, dir, row, patch };
}
it("status preview uses fast flags only, no model call or event", async () => {
  const s = await setup(); const judge = vi.fn(async () => verdict);
  const before = await runWith(s.h, load(s.dir));
  const result = await runWith(s.h, projectStatus(s.dir, { act: false }, judge));
  expect(result.board).toContain("watchdog: worker no artifact (fast path; act: false)");
  expect(judge).not.toHaveBeenCalled();
  expect(await runWith(s.h, load(s.dir))).toEqual(before);
});
it.each(["bad JSON", "failure", "timeout"])("status finishes after judge %s", async kind => {
  const s = await setup();
  const judge = vi.fn(async () => { if (kind === "failure") throw Error("provider broke"); if (kind === "timeout") return new Promise<string>(() => {}); return "bad JSON"; });
  if (kind === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const resultPromise = runWith(s.h, projectStatus(s.dir, {}, judge));
  if (kind === "timeout") { await vi.waitFor(() => expect(judge).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(16_000); }
  const result = await resultPromise;
  expect(result.board).toContain("watchdog: worker judge unavailable");
  expect(result.project.agents.find(r => r.name === "worker")?.state).toBe("running");
});
it("owned flagged rows judge once, persist cooldown, and rejudge only changed evidence", async () => {
  const s = await setup(); const judge = vi.fn<WatchdogJudge>(async () => verdict);
  const first = await runWith(s.h, projectStatus(s.dir, {}, judge));
  expect(first.board).toContain("watchdog: worker stuck — same failing check; suggest: inspect the fixture");
  expect(judge).toHaveBeenCalledTimes(1);
  expect(judge.mock.calls[0]?.[0]).toMatchObject({ brief: "finish the watchdog" });
  const row = first.project.agents.find(r => r.name === "worker")!;
  expect(row.events?.filter(e => e.type === "WATCHDOG")).toHaveLength(1);
  expect(previousJudgment(row, watchdogFingerprint({ ...signals, now: s.h.now.getTime(), artifactAt: Date.parse(row.createdAt), artifact: ":0" }, ["no artifact"], limits.model), s.h.now.getTime(), limits)).toContain("stuck");
  await runWith(s.h, projectStatus(s.dir, {}, judge));
  expect(judge).toHaveBeenCalledTimes(1);
  appendFileSync(row.sessionFile!, "\n" + Array.from({ length: 3 }, () => entry("toolResult", "new failure", { isError: true }, s.h.now.getTime())).join("\n"));
  await runWith(s.h, projectStatus(s.dir, {}, judge));
  expect(judge).toHaveBeenCalledTimes(2);
  expect((await runWith(s.h, load(s.dir))).agents.find(r => r.name === "worker")?.events?.filter(e => e.type === "WATCHDOG")).toHaveLength(1);
  expect(s.h.herdr.calls.filter(call => ["pane.send_keys", "pane.send_input", "agent.prompt", "pane.close"].includes(call.method))).toEqual([]);
});
it("a new clone HEAD and a fresh packet both reset the stall signal", async () => {
  const s = await setup(); const judge = vi.fn(async () => verdict);
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: s.dir, encoding: "utf8" }).trim();
  await s.patch({ clone: { source: s.dir, branch: "worker", base: { ref: "HEAD", sha: base } } });
  expect((await runWith(s.h, projectStatus(s.dir, { act: false }, judge))).board).toContain("watchdog: worker no artifact");
  writeFileSync(join(s.dir, "artifact.txt"), "proof\n");
  execFileSync("git", ["add", "artifact.txt"], { cwd: s.dir });
  execFileSync("git", ["-c", "user.name=shitratgit[bot]", "-c", "user.email=286405550+shitratgit[bot]@users.noreply.github.com", "commit", "-m", "test artifact"], { cwd: s.dir });
  expect((await runWith(s.h, projectStatus(s.dir, { act: false }, judge))).board).not.toContain("watchdog:");
  await s.patch({ clone: null });
  await runWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p, packets: [{ id: "artifact", kind: "artifact", lane: "work", agent: "worker", artifact: null, report: join(s.dir, "missing-report"), checks: [], state: "reported", verification: null, gate: null, supersedes: null, landedAs: null, reportedAt: s.h.now.toISOString(), updatedAt: s.h.now.toISOString() }] }, undefined] as const)));
  expect((await runWith(s.h, projectStatus(s.dir, { act: false }, judge))).board).not.toContain("watchdog:");
  expect(judge).not.toHaveBeenCalled();
});
it("cooldown expires without making new turns into new evidence", async () => {
  const s = await setup(); const judge = vi.fn(async () => verdict);
  const first = await runWith(s.h, projectStatus(s.dir, {}, judge));
  const row = first.project.agents.find(r => r.name === "worker")!;
  const event = row.events!.find(e => e.type === "WATCHDOG")!;
  const fingerprint = JSON.parse(event.detail).fingerprint;
  expect(previousJudgment(row, fingerprint, s.h.now.getTime() + 119 * 60_000, limits)).toContain("stuck");
  expect(previousJudgment(row, fingerprint, s.h.now.getTime() + 120 * 60_000, limits)).toBeNull();
  expect(watchdogFingerprint(signals, ["no artifact"], limits.model)).toBe(watchdogFingerprint({ ...signals, turns: 20 }, ["no artifact"], limits.model));
});
it("caps new judgments at three, oldest artifact first, then serves deferred rows (plant: judge cap)", async () => {
  const s = await setup(); const judge = vi.fn<WatchdogJudge>(async () => verdict);
  await runWith(s.h, mutate(s.dir, project => {
    const base = project.agents.find(row => row.name === "worker")!;
    const rows = Array.from({ length: 5 }, (_, index) => {
      const sessionFile = join(s.h.root, `row-${index}.jsonl`);
      writeFileSync(sessionFile, entry("assistant", [{ type: "text", text: "working" }], {}, s.h.now.getTime()));
      return { ...base, name: `worker${index}`, pane: null, sessionFile, sessionId: randomUUID(), createdAt: new Date(s.h.now.getTime() - (7 - index) * 3600_000).toISOString() };
    });
    return Effect.succeed([{ ...project, agents: rows }, undefined] as const);
  }));
  const first = await runWith(s.h, projectStatus(s.dir, {}, judge));
  expect(judge).toHaveBeenCalledTimes(3);
  expect(first.project.agents.filter(row => row.events?.some(event => event.type === "WATCHDOG")).map(row => row.name)).toEqual(["worker0", "worker1", "worker2"]);
  expect(first.board).toContain("watchdog: worker3 no artifact (fast path; judge deferred)");
  expect(first.board).toContain("watchdog: worker4 no artifact (fast path; judge deferred)");
  await runWith(s.h, projectStatus(s.dir, {}, judge));
  expect(judge).toHaveBeenCalledTimes(5);
});
it("remote probes stop at the budget, retain closed-row mtimes, and cap at 100 rows (plant: probe budget)", () => {
  const h = harness(); const file = join(h.root, "tail.jsonl");
  writeFileSync(file, entry("assistant", [{ type: "text", text: "working" }]));
  const row = { name: "worker", cwd: h.root, artifactAt: 0, artifact: "", files: [], sessionFile: file, brief: null, clone: { base: null } };
  const raw = execFileSync(process.execPath, ["--input-type=module", "-e", remoteWatchdogScript(false, 0), JSON.stringify({ rows: [{ ...row, name: "closed", watchdog: false }, ...Array.from({ length: 101 }, (_, i) => ({ ...row, name: `worker${i}` }))], limits })], { encoding: "utf8" });
  const probes = decodeWatchdogProbes(JSON.parse(raw));
  expect(probes).toHaveLength(100);
  expect(probes[0]).toMatchObject({ name: "closed", mtime: expect.any(Number), errors: [], turns: 0 });
  expect(probes[0]?.unavailable).toBeUndefined();
  expect(probes.slice(1).every(probe => probe.unavailable === "probe budget")).toBe(true);
});
it("unflagged and foreign-owned rows never call the judge", async () => {
  const s = await setup(); const judge = vi.fn(async () => verdict);
  await s.patch({ createdAt: s.h.now.toISOString() });
  expect((await runWith(s.h, projectStatus(s.dir, {}, judge))).board).not.toContain("watchdog:");
  await s.patch({ owner: "foreign", createdAt: new Date(s.h.now.getTime() - 3 * 3600_000).toISOString() });
  expect((await runWith(s.h, projectStatus(s.dir, {}, judge))).board).toContain("watchdog: worker no artifact");
  expect(judge).not.toHaveBeenCalled();
});
it.each(["desk", "hawk", "judge", "caller"])("watchdog excludes %s rows", async kind => {
  const s = await setup(); const judge = vi.fn(async () => verdict);
  await s.patch(kind === "caller" ? { sessionId: s.h.sessionId } : { role: kind as AgentRow["role"] });
  const result = await runWith(s.h, projectStatus(s.dir, { act: false }, judge));
  expect(result.board).not.toContain("watchdog:");
  expect(judge).not.toHaveBeenCalled();
});
it("remote scripts return counters only, then bounded flagged text; local/remote scanning agrees", () => {
  const h = harness(); const file = join(h.root, "tail.jsonl");
  writeFileSync(file, Array.from({ length: 31 }, () => entry("assistant", [{ type: "text", text: "working" }])).join("\n"));
  const repo = makeRepo(join(h.root, "source"));
  const script = join(h.root, "probe.mjs");
  const rows = [{ name: "worker", cwd: repo, artifactAt: now - 3600_000, artifact: "", files: [], sessionFile: file, brief: null, clone: { base: { sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() } } }];
  const run = (tails: boolean) => {
    writeFileSync(script, remoteWatchdogScript(tails));
    return execFileSync(process.execPath, [script, JSON.stringify({ rows, limits, nextAction: "ship" })], { encoding: "utf8" });
  };
  const probes = decodeWatchdogProbes(JSON.parse(run(false)));
  expect(probes[0]).toMatchObject({ turns: 31, errors: [] });
  expect(run(false)).not.toContain("working");
  expect(decodeWatchdogTails(JSON.parse(run(true)))[0]).toMatchObject({ brief: "ship" });
  expect(watchdogTail(file)).toContain("working");
  expect(artifactMtime(file)).toBeGreaterThan(0);
});
it.each([false, true])("remote status flags rows or reports unavailable probes (failure=%s)", async failure => {
  const s = await setup();
  await s.patch({ machine: "remote" });
  const machines = decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/muster", workerWorktree: s.h.workerWorktree, env: {}, wrap: [] } });
  const original = remote.remoteNode;
  const probe = vi.spyOn(remote, "remoteNode").mockImplementation((...args) => {
    if (args[2].includes("const {rows,limits,nextAction}")) return failure ? Effect.fail(new ProcError({ command: "ssh", code: 255, stderr: "offline", message: "offline" })) : Effect.succeed(JSON.stringify([{ name: "worker", artifactAt: s.h.now.getTime() - 3 * 3600_000, artifact: "", turns: 0, errors: [] }]));
    return original(...args);
  });
  const result = await runWith(s.h, projectStatus(s.dir, { act: false }).pipe(Effect.provideService(MusterEnv, { home: s.h.home, now: () => s.h.now, sessionId: s.h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: s.h.workerWorktree, createId: () => "id", sleep: () => Effect.void, emitPaneClose: noEmitPaneClose, machines, remoteHerdr: () => Effect.succeed(s.h.herdr.client()) })));
  expect(result.board).toContain(failure ? "watchdog: remote probes unavailable" : "watchdog: worker no artifact");
  expect(probe.mock.calls.filter(call => call[2].includes("const {rows,limits,nextAction}"))).toHaveLength(1);
});
