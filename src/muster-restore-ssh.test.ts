import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { parseRestoreArgs, validateOriginalCommand, WAKE_MODEL_ERROR } from "../bin/muster-restore-args.mjs";
import { profileFor } from "./argv.ts";
import { decodeAgentRow, decodeMachines } from "./domain.ts";
import { paneList } from "./herdr.ts";
import { laneOpen, projectOpen } from "./ops.ts";
import { registryPath } from "./registry.ts";
import { machinesPath, onRemote } from "./remote.ts";
import { projectPath, mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { wakeReceiptDir } from "./wake-restore.ts";

const prefix = "muster-restore --name my-project/desk_1 --message-id msg_42";
it.each([";echo-no", "$(id)", "`id`", "\n", "\t", "'quotes'", '"quotes"', "*", "\\x"])("rejects forbidden SSH command characters: %j", fragment => {
  expect(validateOriginalCommand(`${prefix} --reason safe${fragment}`)).toMatchObject({ ok: false, receipt: { result: "refused" } });
});
it.each([
  `${prefix} --name other/desk`, `${prefix} --reason ${"a".repeat(121)}`,
  `${prefix} --exit-when-drained 0`, `${prefix} --exit-when-drained 1441`, `${prefix} --exit-when-drained 1.5`,
  `${prefix} --exit-when-drained`, `${prefix} --dry-run --dry-run`, `${prefix} --test`,
  "muster-restore --name x/y", "muster-restore --message-id id", "muster-restore --name x/y/z --dry-run",
  "muster-restore --name x/Y --dry-run", "muster-restore --name x/y --message-id a.b", `echo ${prefix}`,
])("refuses invalid argv: %j", command => {
  expect(validateOriginalCommand(command)).toMatchObject({ ok: false, receipt: { result: "refused" } });
});
it("parses the original command without interpreting safe token characters", () => {
  expect(validateOriginalCommand(`  ${prefix}   --reason pending:mail@inbox=1 --exit-when-drained 1440  `)).toEqual({
    ok: true,
    request: { name: "my-project/desk_1", messageId: "msg_42", reason: "pending:mail@inbox=1", minutes: 1440, dryRun: false },
    argv: ["--name", "my-project/desk_1", "--message-id", "msg_42", "--reason", "pending:mail@inbox=1", "--exit-when-drained", "1440"],
  });
});
it("both entry points allow a no-ID dry run and use the same defaults", () => {
  const args = ["--dry-run", "--name", "project/desk"];
  const request = { name: "project/desk", messageId: null, reason: null, minutes: 15, dryRun: true };
  expect(parseRestoreArgs(args)).toEqual({ ok: true, request });
  expect(validateOriginalCommand(`muster-restore ${args.join(" ")}`)).toEqual({ ok: true, request, argv: args });
  expect(parseRestoreArgs(args.slice(1))).toMatchObject({ ok: false, receipt: { reason: "missing --message-id" } });
  expect(parseRestoreArgs(["--name", "9project/desk", "--dry-run"])).toMatchObject({ ok: false });
  expect(validateOriginalCommand("muster-restore --name 9project/desk --dry-run")).toMatchObject({ ok: false });
});

const executable = (name: string) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
const wrapper = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [executable("muster-restore-ssh.mjs")], { env, encoding: "utf8", timeout: 8_000 });
const readOne = (run: ReturnType<typeof wrapper>, status: number) => {
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(status);
  expect(run.stdout.split("\n")).toHaveLength(2);
  return JSON.parse(run.stdout);
};
it("the forced-command executable emits exactly one receipt and delegates valid argv", () => {
  const { home } = harness();
  for (const original of ["muster-restore --name project/desk --dry-run", "muster-restore --name project/desk --reason x;echo"] ) {
    const result = readOne(wrapper({ ...process.env, HOME: home, PATH: "/nonexistent", SSH_ORIGINAL_COMMAND: original }), 2);
    expect(result).toMatchObject({ result: "refused", messageId: null,
      reason: original.endsWith("--dry-run") ? "unknown name" : "SSH command contains a forbidden character", ready: false, receiptSaved: false, permanent: false });
  }
});
it("the real bin reports a catalog read failure on one line with exit 1 and no raw diagnostic", () => {
  const { home, root } = harness();
  const registry = registryPath(home), path = projectPath(root);
  mkdirSync(dirname(registry), { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(registry, `${JSON.stringify({ slug: "project", dir: root })}\n`);
  writeFileSync(path, "malformed-private-content");
  const { status, stdout } = spawnSync(executable("muster-restore"), ["--name", "project/desk", "--dry-run"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  expect(status).toBe(1);
  expect(stdout.split("\n")).toHaveLength(2);
  expect(JSON.parse(stdout)).toMatchObject({ result: "failed", name: "project/desk", messageId: null });
  expect(stdout).not.toContain("malformed-private-content");
  expect(readOne(wrapper({ ...process.env, HOME: home, PATH: "/nonexistent", SSH_ORIGINAL_COMMAND: "muster-restore --name project/desk --dry-run" }), 1)).toMatchObject({ result: "failed" });
});

it("refuses an unset original command; replaces a silently dying child with one failed receipt", () => {
  const { root, home } = harness();
  const env = { ...process.env, HOME: home, PATH: "/nonexistent" };
  delete (env as NodeJS.ProcessEnv).SSH_ORIGINAL_COMMAND;
  expect(readOne(wrapper(env), 2)).toMatchObject({ result: "refused" });
  const preload = join(root, "silent.cjs");
  writeFileSync(preload, 'if (process.argv[1]?.endsWith("/muster-restore-main.mjs")) process.exit(17);\n');
  expect(readOne(wrapper({ ...env, NODE_OPTIONS: `--require=${preload}`, SSH_ORIGINAL_COMMAND: "muster-restore --name project/desk --dry-run" }), 1)).toMatchObject({
    result: "failed", reason: "muster-restore exited without a valid receipt", name: "project/desk",
  });
});

it("the wrapper backstop sends TERM to the launch process group and returns deadline", () => {
  const { root, home } = harness();
  const preload = join(root, "stuck.cjs"), marker = join(root, "group-term");
  const grandchild = `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'TERM'); process.exit(0); }); setInterval(() => {}, 500);`;
  writeFileSync(preload, `if (process.argv[1]?.endsWith('/muster-restore-main.mjs')) {
    const peer = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}]);
    const exit = process.exit;
    process.exit = () => {};
    process.on('SIGTERM', () => { peer.once('close', () => exit(3)); });
    setInterval(() => {}, 500);
  }`);
  const child = wrapper({ ...process.env, HOME: home, NODE_OPTIONS: `--require=${preload}`, MUSTER_WAKE_DEADLINE_MS: "1",
    SSH_ORIGINAL_COMMAND: "muster-restore --name project/desk --dry-run" });
  expect(readOne(child, 1)).toMatchObject({ result: "failed", reason: "deadline", ready: false, permanent: null });
  expect(readFileSync(marker, "utf8")).toBe("TERM");
}, 10_000);

it.each(["lost receipt", "model error", "deadline"])("the wrapper handles issued input followed by %s", outcome => {
  const { root, home } = harness();
  const preload = join(root, "issued.cjs");
  const issued = { result: "restored", name: "project/desk", project: "project", row: "desk", machine: "other", session: "session", pane: "p1",
    reason: "wake test", messageId: "test", ready: false, receiptSaved: false, permanent: null };
  const failure = { ...issued, result: "failed", reason: outcome === "model error" ? WAKE_MODEL_ERROR : "deadline" };
  writeFileSync(preload, `if (process.argv[1]?.endsWith('/muster-restore-main.mjs')) {
    const fs = require('node:fs');
    fs.writeSync(3, ${JSON.stringify(`${JSON.stringify(issued)}\n`)});
    ${outcome === "lost receipt" ? "process.exit(17);" : `fs.writeSync(1, ${JSON.stringify(`${JSON.stringify(failure)}\n`)}); process.exit(1);`}
  }`);
  expect(readOne(wrapper({ ...process.env, HOME: home, NODE_OPTIONS: `--require=${preload}`,
    SSH_ORIGINAL_COMMAND: "muster-restore --name project/desk --message-id test" }), outcome === "model error" ? 1 : 0)).toEqual(outcome === "model error" ? failure : issued);
});

it("the real bin exits and emits one line with captured-shaped Rat King and remote Herdr subprocesses", async () => {
  const h = harness(), dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "project", outcome: "wake", reviewTrigger: "manual", nextAction: "wake", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "Work", goal: "Wake" }));
  const stamp = h.now.toISOString();
  const sessionFile = join(dir, "desk-session.jsonl");
  const row = decodeAgentRow({ machine: "remote1", name: "desk", role: "desk", lane: "work", cwd: dir, clone: null,
    profile: profileFor("desk", { label: "Desk", model: "sol" }), owner: "owner-session", sessionId: "desk-session", sessionFile,
    parentSessionFile: null, pane: null, brief: null, state: "interrupted", delivery: "none", restarts: 0, restore: null, createdAt: stamp, updatedAt: stamp });
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: [row] }, null] as const)));
  const registry = registryPath(h.home), configs = machinesPath(h.home);
  mkdirSync(dirname(registry), { recursive: true });
  mkdirSync(dirname(configs), { recursive: true });
  writeFileSync(registry, `${JSON.stringify({ slug: "project", dir })}\n`);
  writeFileSync(configs, JSON.stringify({ remote1: { ssh: "remote1", herdr: "remote1", paths: {}, wake: true, musterExtension: "/package", workerWorktree: "/helpers/worker", env: {} } }));
  const bin = join(h.root, "bin"), rk = join(h.root, "ratking.cjs"), keep = join(h.root, "keep.cjs");
  mkdirSync(bin, { recursive: true });
  writeFileSync(keep, `if (process.argv[1]?.endsWith('/muster-restore-main.mjs')) {
    setInterval(() => {}, 500);
    const children = require('node:child_process');
    const original = children.execFile;
    children.execFile = (...args) => { console.log('fixture proc log'); return original(...args); };
    require('node:module').syncBuiltinESMExports();
  }\n`);
  writeFileSync(rk, `if (process.argv.slice(2).join(' ') !== 'whoami --json') process.exit(17);
console.log(JSON.stringify({ command:'whoami', ok:true, did:'did:example:row', name:process.env.RATKING_NAME, key:{held:false,source:'fixture'}, lease:null }));`);
  const panes = JSON.stringify({ id: "cli:pane:list", result: { panes: [{ agent: "pi", agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: sessionFile }, agent_status: "idle",
    cwd: dir, focused: false, foreground_cwd: dir, pane_id: "w9:p9", revision: 4, scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 29 }, tab_id: "w9:t9",
    terminal_id: "fixture-terminal", terminal_title: "Pi", terminal_title_stripped: "Pi", workspace_id: "w9" }] }, type: "response" });
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\ncase "$*" in *"'herdr' 'pane' 'list'"*) printf '%s\\n' '${panes}';; *) exit 30;; esac\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: h.home, PATH: `${bin}:${process.env.PATH}`, MUSTER_MACHINE: "", MUSTER_RATKING_CLI: rk, NODE_OPTIONS: `--require=${keep}` };
  const args = ["--dry-run", "--name", "project/desk"];
  const child = spawnSync(executable("muster-restore"), args, { env, encoding: "utf8", timeout: 8_000 });
  expect(readOne(child, 0)).toMatchObject({ result: "alreadyLive", messageId: null, pane: "w9:p9", ready: false, receiptSaved: false, permanent: null });
  expect(child.stderr).toContain("fixture proc log");
  expect(readOne(wrapper({ ...env, SSH_ORIGINAL_COMMAND: `muster-restore ${args.join(" ")}` }), 0)).toEqual(JSON.parse(child.stdout));
  const marker = join(h.root, "ssh-term"), childPid = join(h.root, "ssh-pid");
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const fs=require('node:fs');
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'TERM'); process.exit(0); });
fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));
setInterval(() => {}, 500);
`, { mode: 0o700 });
  const timed = wrapper({ ...env, SSH_ORIGINAL_COMMAND: `muster-restore ${args.join(" ")}`, MUSTER_WAKE_DEADLINE_MS: "1500" });
  expect(readOne(timed, 1)).toMatchObject({ result: "failed", reason: "deadline", permanent: null });
  expect(readFileSync(marker, "utf8")).toBe("TERM");
  expect(() => process.kill(Number(readFileSync(childPid, "utf8")), 0)).toThrow("ESRCH");
  expect(existsSync(wakeReceiptDir(h.home))).toBe(false);
}, 12_000);

it.each([true, false])("the scoped wake forward cleans its socket and reaps its SSH child (success:%s)", async success => {
  const h = harness(), marker = join(h.root, "forward.json"), ssh = join(h.root, "ssh");
  writeFileSync(ssh, `#!${process.execPath}
const {createServer}=require('node:net');
const {writeFileSync}=require('node:fs');
const socket=process.argv[process.argv.indexOf('-L')+1].split(':')[0];
createServer(client => client.once('data', data => {
  const {id}=JSON.parse(String(data));
  client.end(JSON.stringify({id,result:{type:'pane_list',panes:[]}})+'\\n');
})).listen(socket,()=>writeFileSync(${JSON.stringify(marker)},JSON.stringify({socket,pid:process.pid})));
`, { mode: 0o700 });
  vi.stubEnv("PATH", `${h.root}:${process.env.PATH}`);
  try {
    const machine = decodeMachines({ remote1: { ssh: "remote1", herdr: "remote1", paths: {}, socket: "/remote/herdr.sock",
      wake: true, musterExtension: "/package", workerWorktree: "/helpers/worker", env: {} } }).remote1!;
    const probe = paneList().pipe(Effect.flatMap(panes => success ? Effect.succeed(panes) : Effect.fail("fixture-error")));
    const result = await runWith(h, onRemote("remote1", machine, probe, true).pipe(Effect.result));
    expect(result._tag).toBe(success ? "Success" : "Failure");
    const { socket, pid } = JSON.parse(readFileSync(marker, "utf8"));
    expect(existsSync(dirname(socket))).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow("ESRCH");
  } finally { vi.unstubAllEnvs(); }
});
