import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodePolicy, decodeRestartDistillReceipt, mergePolicy } from "./domain.ts";
import { digestJournal, effectiveDistill, fleetDistill, restartDistill, RESTART_DISTILL_TIMEOUT_MS, sessionHeaderId } from "./restart-distill.ts";
import { liveProc } from "./runtime.ts";
import { harness, runWith } from "./test-support.ts";

/** An actual subprocess, not a mocked receipt: writes only the requested child and reports the frozen parent. */
export const fakeDistillScript = `
const fs = require('node:fs'), crypto = require('node:crypto');
const [mode, parent, child] = process.argv.slice(2);
const bytes = fs.readFileSync(parent);
fs.writeFileSync(parent + '.called', process.cwd());
if (mode === 'exit') process.exit(7);
if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
if (mode === 'json') { console.log('not json'); return; }
const lines = bytes.toString().trim().split('\\n');
const kept = lines.filter((line, i) => i === 0 || line.includes('pi-until-') || line.includes('thinking_level_change') || (mode !== 'nosystem' && line.includes('"role":"system"')));
if (mode === 'newid') { const h = JSON.parse(kept[0]); h.id = 'fresh-' + h.id; kept[0] = JSON.stringify(h); }
const output = kept.join('\\n') + '\\n';
if (mode === 'directory') fs.mkdirSync(child);
else if (mode === 'symlink') fs.symlinkSync(parent, child);
else if (mode !== 'missing') fs.writeFileSync(child, mode === 'empty' ? '' : output, {flag: 'wx'});
console.log(JSON.stringify({pivotAllowed: mode !== 'pivot', parentBytes: bytes.length,
 childBytes: mode === 'cut' ? bytes.length : Buffer.byteLength(output), child,
 parentSha256: mode === 'hash' ? '0'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex'),
 ignored: 'unknown fields are fine'}));
`;

function setup(mode = "ok") {
  const h = harness();
  const snapshot = join(h.root, "snapshot.jsonl"), sessionFile = join(h.root, "old.jsonl"), childOut = join(h.root, "child.jsonl");
  const bytes = JSON.stringify({ type: "session", id: "parent", version: 3 }) + "\n"
    + JSON.stringify({ type: "message", id: "loadout", parentId: null, message: { role: "system", content: "", toolsAdded: [{ name: "bash" }, { name: "read" }] } }) + "\n"
    + JSON.stringify({ type: "message", id: "text", parentId: "loadout", message: { role: "user", content: "x".repeat(4096) } }) + "\n";
  writeFileSync(snapshot, bytes); writeFileSync(sessionFile, bytes);
  const script = join(h.root, "distill.cjs"); writeFileSync(script, fakeDistillScript);
  const pane = h.herdr.addPane("w1", "t1", h.root); pane.agent = "pi"; pane.agent_status = "idle";
  const runs: { command: string; args: readonly string[]; timeoutMs?: number }[] = [];
  h.proc = { run: (command, args, options) => {
    runs.push({ command, args, timeoutMs: options.timeoutMs });
    if (command === "sh" && args[1] === "command -v muster-heavy") return Effect.succeed({ code: 1, stdout: "", stderr: "" });
    return liveProc.run(command, args, mode === "timeout" ? { ...options, timeoutMs: 40 } : options);
  } };
  const input = { policy: { command: [process.execPath, script, mode], minMb: 0 }, role: "desk" as const, remote: false, self: false, paneId: pane.pane_id, sessionFile, snapshot, childOut, cwd: h.root };
  const run = (overrides: Partial<Parameters<typeof restartDistill>[0]> = {}) => runWith(h, restartDistill({ ...input, ...overrides }));
  const unchanged = () => { expect(readFileSync(snapshot, "utf8")).toBe(bytes); expect(readFileSync(sessionFile, "utf8")).toBe(bytes); };
  return { h, input, pane, run, runs, bytes, unchanged };
}

describe("restart distill", () => {
  it("is off when absent or null and does no IO or Herdr probing", async () => {
    const s = setup();
    for (const policy of [undefined, null]) expect(await s.run({ policy, snapshot: "/not/read" })).toEqual({ parentSessionFile: "/not/read" });
    expect(s.runs).toEqual([]); expect(s.h.herdr.calls).toEqual([]); s.unchanged();
    expect(decodePolicy({} as unknown).distill ?? null).toBeNull();
  });
  it("selects the child after two idle reads two seconds apart; sources unchanged", async () => {
    const s = setup(); const sleeps: number[] = [];
    s.h.sleep = ms => { sleeps.push(ms); expect(s.h.herdr.calls.filter(c => c.method === "agent.get")).toHaveLength(1); };
    const result = await s.run();
    expect(result).toEqual({ parentSessionFile: s.input.childOut, detail: `distilled ${Buffer.byteLength(s.bytes)} -> ${lstatSync(s.input.childOut).size}` });
    expect(sleeps).toEqual([2000]);
    expect(s.h.herdr.calls.filter(c => c.method === "agent.get")).toHaveLength(2);
    expect(s.runs.at(-1)?.timeoutMs).toBe(RESTART_DISTILL_TIMEOUT_MS);
    expect(readFileSync(s.input.snapshot + ".called", "utf8")).toBe(s.h.root); s.unchanged();
  });
  it.each(["desk", "hawk", "boss"] as const)("allows standing role %s", async role => {
    const s = setup(); expect((await s.run({ role })).parentSessionFile).toBe(s.input.childOut); s.unchanged();
  });
  it.each(["worker", "judge"] as const)("never runs for %s, even on self restart", async role => {
    const s = setup(); expect((await s.run({ role, self: true })).note).toContain("not standing");
    expect(s.runs).toEqual([]); s.unchanged();
  });
  it("skips remote before reading a local path", async () => {
    const s = setup(); expect((await s.run({ remote: true, snapshot: "/not/local" })).note).toContain("distill: local rows only"); expect(s.runs).toEqual([]);
  });
  it("defaults minMb to 64 and checks size before idle or command", async () => {
    const s = setup(); const result = await s.run({ policy: { command: s.input.policy.command } });
    expect(result.parentSessionFile).toBe(s.input.snapshot); expect(result.note).toContain("< 64 MiB");
    expect(s.runs).toEqual([]); expect(s.h.herdr.calls).toEqual([]); s.unchanged();
  });
  it("accepts an exact size threshold", async () => {
    const s = setup(); expect((await s.run({ policy: { ...s.input.policy, minMb: Buffer.byteLength(s.bytes) / 1024 / 1024 } })).detail).toContain("distilled");
  });
  it.each(["working", "done", "unknown", "blocked"] as const)("rejects non-idle %s on first read", async status => {
    const s = setup(); s.pane.agent_status = status;
    const result = await s.run(); expect(result.parentSessionFile).toBe(s.input.snapshot); expect(result.note).toContain("not settled idle"); expect(s.runs).toEqual([]); s.unchanged();
  });
  it("rejects a second read that is working", async () => {
    const s = setup(); s.h.sleep = () => { s.pane.agent_status = "working"; };
    expect((await s.run()).note).toContain("second read"); expect(s.runs).toEqual([]); s.unchanged();
  });
  it("rejects an idle pane with a tool call in flight", async () => {
    const s = setup(); appendFileSync(s.input.sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "pending" }] } }) + "\n");
    expect((await s.run()).note).toContain("tool call in flight"); expect(s.runs).toEqual([]);
  });
  it("accepts a resolved tool call", async () => {
    const s = setup(); appendFileSync(s.input.sessionFile, [{ message: { role: "assistant", content: [{ type: "toolCall", id: "done" }] } }, { message: { role: "toolResult", toolCallId: "done", content: [] } }].map(v => JSON.stringify(v)).join("\n") + "\n");
    expect((await s.run()).detail).toContain("distilled");
  });
  it("self restart exempts its own working turn and pending restart tool", async () => {
    const s = setup(); s.pane.agent_status = "working";
    appendFileSync(s.input.sessionFile, JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id: "restart" }] } }) + "\n");
    expect((await s.run({ self: true })).detail).toContain("distilled"); expect(s.h.herdr.calls).toEqual([]);
  });
  it.each([
    ["pivot", "pivotAllowed false"], ["cut", "cut 0 < 0.5"], ["missing", "ENOENT"], ["exit", "exited 7"],
    ["timeout", "timed out"], ["json", "SyntaxError"], ["empty", "non-empty"], ["directory", "regular file"],
    ["symlink", "regular file"], ["hash", "parent identity mismatch"],
  ])("%s fails open with one note", async (mode, note) => {
    const s = setup(mode); const result = await s.run();
    expect(result.parentSessionFile).toBe(s.input.snapshot); expect(result.detail).toBeUndefined(); expect(result.note).toContain(note); s.unchanged();
  });
  it("runs under muster-heavy when on PATH, preserving argv and timeout", async () => {
    const s = setup(); const heavy = join(s.h.root, "muster-heavy");
    writeFileSync(heavy, '#!/bin/sh\nshift 3\nexec "$@"\n'); chmodSync(heavy, 0o755);
    const proc = s.h.proc;
    s.h.proc = { run: (command, args, options) => command === "sh" && args[1] === "command -v muster-heavy"
      ? Effect.succeed({ code: 0, stdout: heavy + "\n", stderr: "" }) : proc.run(command, args, options) };
    expect((await s.run()).detail).toContain("distilled");
    expect(s.runs.at(-1)).toMatchObject({ command: heavy, args: ["--wait", "600", "--", ...s.input.policy.command, s.input.snapshot, s.input.childOut], timeoutMs: 600_000 }); s.unchanged();
  });
  it("merges, preserves and clears the policy knob; rejects malformed policy/receipts", () => {
    const s = setup(); const enabled = mergePolicy({}, decodePolicy({ distill: s.input.policy }));
    expect(mergePolicy(enabled, {}).distill).toEqual(s.input.policy);
    expect(mergePolicy(enabled, { distill: null }).distill).toBeNull();
    for (const distill of [{ command: [] }, { command: [""] }, { command: ["x"], minMb: -1 }, { command: ["x"], minCut: 1.1 }]) expect(() => decodePolicy({ distill })).toThrow();
    expect(() => decodeRestartDistillReceipt({ pivotAllowed: true })).toThrow();
    expect(existsSync(s.input.childOut)).toBe(false);
  });
});

describe("fleet distill file", () => {
  it("is off without a file, defaults minMb to 500, keeps an explicit one, and names a bad file", () => {
    const h = harness();
    expect(fleetDistill(h.home, {})).toEqual({ policy: null });
    const path = join(h.root, "distill.json");
    writeFileSync(path, JSON.stringify({ command: ["/bin/distill"] }));
    expect(fleetDistill(h.home, { MUSTER_DISTILL_CONFIG: path }).policy).toEqual({ command: ["/bin/distill"], minMb: 500 });
    writeFileSync(path, JSON.stringify({ command: ["/bin/distill"], minMb: 64, extensions: ["/srv/ref.ts"] }));
    expect(fleetDistill(h.home, { MUSTER_DISTILL_CONFIG: path }).policy).toEqual({ command: ["/bin/distill"], minMb: 64, extensions: ["/srv/ref.ts"] });
    writeFileSync(path, JSON.stringify({ command: ["/bin/distill"], extensions: ["ref.ts"] }));
    expect(fleetDistill(h.home, { MUSTER_DISTILL_CONFIG: path })).toMatchObject({ policy: null, note: expect.stringContaining("does not decode") });
  });
  it("lets a project's own distill, null included, win over the fleet file", () => {
    const fleet = { command: ["/bin/distill"], minMb: 500 };
    expect(effectiveDistill(undefined, fleet)).toBe(fleet);
    expect(effectiveDistill(decodePolicy({}), fleet)).toBe(fleet);
    expect(effectiveDistill(decodePolicy({ distill: null }), fleet)).toBeNull();
    expect(effectiveDistill(decodePolicy({ distill: { command: ["/own"] } }), fleet)).toEqual({ command: ["/own"] });
  });
});

describe("distilled child session id", () => {
  // MacLeod, 2026-11-11: front-desk's first pivot came up under a fork name, because the child's header had a fresh id.
  it("refuses a child whose header id differs from the snapshot's, and forks the snapshot", async () => {
    const s = setup("newid");
    const result = await s.run({});
    expect(result.parentSessionFile).toBe(s.input.snapshot);
    expect(result.note).toContain("child session id differs");
    s.unchanged();
  });
  it("reads the id from the first line only", () => {
    const h = harness();
    const file = join(h.root, "header.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "abc" })}\n${"x".repeat(3 * 1024 * 1024)}`);
    expect(sessionHeaderId(file)).toBe("abc");
    writeFileSync(file, `${JSON.stringify({ type: "message", id: "abc" })}\n`);
    expect(sessionHeaderId(file)).toBeNull();
  });
});

describe("distilled child tool loadout", () => {
  // Front-desk, 2026-11-11: the child kept 0 of 280 system messages, and the next restart came up without bash.
  it("refuses a child that keeps a different number of system messages than the parent", async () => {
    const s = setup("nosystem");
    const result = await s.run({});
    expect(result.parentSessionFile).toBe(s.input.snapshot);
    expect(result.note).toContain("child keeps 0 of 1 system messages");
    s.unchanged();
  });
  it("counts system messages across chunk boundaries, and ignores the marker inside other text", async () => {
    const h = harness();
    const file = join(h.root, "journal.jsonl");
    const system = JSON.stringify({ type: "message", message: { role: "system", toolsAdded: [] } });
    const quoted = JSON.stringify({ type: "message", message: { role: "user", content: 'see "role":"system" here' } });
    writeFileSync(file, [system, "y".repeat(200_000), quoted, system, "{broken \"role\":\"system\""].join("\n"));
    const digest = await Effect.runPromise(digestJournal(file));
    expect(digest.systemMessages).toBe(2);
    expect(digest.sha256).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
  });
});
