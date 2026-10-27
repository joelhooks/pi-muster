import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { agentClose, agentLaunchForeground, laneOpen, packetLand, packetReport, packetVerify, projectOpen, projectStatus } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { Effect } from "effect";
import { MusterEnv, Proc, liveProc } from "./runtime.ts";
import { decodeMachines } from "./domain.ts";
import { forkHarness, harness, makeRepo, runWith, sh } from "./test-support.ts";

// Build the project, lane and cloned worker once; each case copies it instead of repeating the launch.
let template: ReturnType<typeof harness>;
let templateDir: string;
beforeAll(async () => {
  vi.stubEnv("MUSTER_PROJECT", "");
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  template = harness();
  templateDir = makeRepo(join(template.root, "repo"));
  await runWith(template, projectOpen({ dir: templateDir, slug: "reap", outcome: "retire clones safely", nextAction: "test", reviewTrigger: "weekly", space: "w1", ephemeral: true, cadenceMinutes: null, musterExtension: "/muster", deskExtension: null }));
  await runWith(template, laneOpen(templateDir, { slug: "reap", label: "🧹 reap", goal: "retire clones safely" }));
  const brief = join(template.root, "brief.md");
  writeFileSync(brief, "retire clones\n");
  await runWith(template, agentLaunchForeground(templateDir, { action: "launch", name: "worker", lane: "reap", role: "worker", label: "🧹 worker", clone: true, brief }));
});
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  vi.stubEnv("MUSTER_PROJECT", "");
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const { h, dir } = forkHarness(template, templateDir);
  const row = (await runWith(h, load(dir))).agents[0]!;
  const commit = (path: string, file: string, text: string) => {
    writeFileSync(join(path, file), text);
    sh(path, "add", file); sh(path, "commit", "-q", "-m", text);
    return sh(path, "rev-parse", "HEAD").trim();
  };
  return { h, dir, row, commit, close: () => runWith(h, agentClose(dir, { name: row.name })), status: (act = false) => runWith(h, projectStatus(dir, { act })) };
}

it.each([".wzrrd/output.json", ".pi/notes-bridge/output.json", "worker.log", "worker.pid", ".rift", ".brain/data/reap-status.json"])("force-removes harness-only dirt %s after harvest proof", async path => {
  const f = await fixture();
  mkdirSync(join(f.row.cwd, path, ".."), { recursive: true });
  writeFileSync(join(f.row.cwd, path), "{}");
  expect((await f.close()).cloneError).toBeNull();
  expect(existsSync(f.row.cwd)).toBe(false);
});

it.each([".brain/clone-only.svx", "BRAIN.md", "AGENTS.md", "CLAUDE.md", ".claude/work.md", ".agents/work.md", ".pi/generated.json", ".brain/projects/x.svx"])("keeps clone-only or differing generated work %s and names it", async path => {
  const f = await fixture();
  mkdirSync(join(f.row.cwd, path, ".."), { recursive: true });
  writeFileSync(join(f.row.cwd, path), "clone work");
  mkdirSync(join(f.row.cwd, ".wzrrd"), { recursive: true });
  writeFileSync(join(f.row.cwd, ".wzrrd/output.json"), "{}");
  const result = await f.close();
  expect(result.cloneError).toContain(JSON.stringify(path));
  expect(existsSync(f.row.cwd)).toBe(true);
  const status = await f.status(true);
  expect([status.board, ...status.notes].join("\n").split("\n").filter(line => line.startsWith("clone kept: worker "))).toHaveLength(1);
  expect(existsSync(f.row.cwd)).toBe(true);
});

it.each(["missing", "identical", "different"])("removes identical Brain dirt and runtime logs with %s source logs", async kind => {
  const f = await fixture();
  for (const root of [f.dir, f.row.cwd]) {
    mkdirSync(join(root, ".brain"), { recursive: true });
    writeFileSync(join(root, ".brain/note.svx"), "same note");
  }
  const path = ".pi/notes-bridge/events.jsonl";
  mkdirSync(join(f.row.cwd, path, ".."), { recursive: true });
  writeFileSync(join(f.row.cwd, path), "clone runtime");
  if (kind !== "missing") {
    mkdirSync(join(f.dir, path, ".."), { recursive: true });
    writeFileSync(join(f.dir, path), kind === "identical" ? "clone runtime" : "source runtime");
  }
  expect((await f.close()).cloneError).toBeNull();
  expect(existsSync(f.row.cwd)).toBe(false);
});

it("keeps differing Brain dirt even with force", async () => {
  const f = await fixture();
  for (const root of [f.dir, f.row.cwd]) mkdirSync(join(root, ".brain"), { recursive: true });
  writeFileSync(join(f.dir, ".brain/note.svx"), "source");
  writeFileSync(join(f.row.cwd, ".brain/note.svx"), "clone");
  const result = await runWith(f.h, agentClose(f.dir, { name: f.row.name, force: true }));
  expect(result.cloneError).toContain('".brain/note.svx"');
  expect(existsSync(f.row.cwd)).toBe(true);
});

it("honours the lane's explicit generated paths despite differing source bytes", async () => {
  const f = await fixture();
  await runWith(f.h, mutate(f.dir, p => Effect.succeed([{ ...p, lanes: p.lanes.map(lane => ({ ...lane, generated: [...lane.generated, ".brain/output.svx"] })) }, undefined] as const)));
  for (const root of [f.dir, f.row.cwd]) {
    mkdirSync(join(root, ".brain"), { recursive: true });
    writeFileSync(join(root, ".brain/output.svx"), root);
  }
  expect((await f.close()).cloneError).toBeNull();
  expect(existsSync(f.row.cwd)).toBe(false);
});

it("keeps real unharvested commits, records one refusal, surfaces it and retries closed rows", async () => {
  const f = await fixture();
  f.commit(f.row.cwd, "work.txt", "unlanded");
  const first = await f.close();
  expect(first.cloneError).toContain("unreachable");
  // aih-support-sweep, 2026-10-26: "unreachable" read as a dead host; the note names what it means and the next call.
  expect(first.cloneError).toMatch(/HEAD is unreachable from base [0-9a-f]{12} .*agent_close force: true/);
  expect(first.row.state).toBe("closed");
  expect(existsSync(f.row.cwd)).toBe(true);
  expect((await f.status()).board).toContain("retry: agent_close name:worker");
  await f.close();
  expect((await runWith(f.h, load(f.dir))).agents[0]!.events!.filter(e => e.type === "CLONE_KEPT")).toHaveLength(1);
  sh(f.dir, "fetch", "-q", f.row.cwd, "HEAD"); sh(f.dir, "merge", "--ff-only", "FETCH_HEAD");
  expect((await f.close()).cloneError).toBeNull();
  expect(existsSync(f.row.cwd)).toBe(false);
  expect((await f.status()).board).not.toContain("clone kept:");
});

it.each([false, true])("names the exact landing call for kept work (reported: %s)", async reported => {
  const f = await fixture();
  const id = f.commit(f.row.cwd, "work.txt", "unlanded");
  if (reported) await runWith(f.h, packetReport({ dir: f.dir, agent: f.row.name, owner: f.row.owner, cwd: f.row.cwd, commit: id, summary: "work", checks: [] }));
  expect((await f.close()).cloneError).toContain(`packet_land id:${reported ? id : "<packet>"} outcome:committed landedAs:<sha>`);
});

it.each(["cherry", "squash", "landedAs"])("removes harvested %s work", async kind => {
  const f = await fixture();
  const id = f.commit(f.row.cwd, "work.txt", "first");
  if (kind === "cherry") {
    f.commit(f.dir, "other.txt", "different parent");
    sh(f.dir, "fetch", "-q", f.row.cwd, id); sh(f.dir, "cherry-pick", "FETCH_HEAD");
  } else {
    f.commit(f.row.cwd, "work.txt", "second");
    f.commit(f.dir, "work.txt", "second");
    if (kind === "landedAs") {
      const head = sh(f.row.cwd, "rev-parse", "HEAD").trim();
      await runWith(f.h, packetReport({ dir: f.dir, agent: f.row.name, owner: f.h.sessionId, cwd: f.row.cwd, commit: head, summary: "squash landed", checks: [] }));
      await runWith(f.h, packetVerify(f.dir, head));
      const landedAs = sh(f.dir, "rev-parse", "HEAD").trim();
      await runWith(f.h, packetLand(f.dir, { id: head, outcome: "committed", landedAs }));
      // Further base changes don't invalidate a proven landing.
      f.commit(f.dir, "work.txt", "later source edit");
    }
  }
  expect((await f.close()).cloneError).toBeNull();
  expect(existsSync(f.row.cwd)).toBe(false);
});

it("refuses mixed dirt with named paths and status retries only after harness-only dirt", async () => {
  const f = await fixture();
  mkdirSync(join(f.row.cwd, ".wzrrd"));
  writeFileSync(join(f.row.cwd, ".wzrrd", "output.json"), "{}");
  writeFileSync(join(f.row.cwd, "user.txt"), "keep me");
  expect((await f.close()).cloneError).toContain('non-harness paths "user.txt"');
  const before = (await runWith(f.h, load(f.dir))).agents[0]!.events!.length;
  await f.status(true);
  expect((await runWith(f.h, load(f.dir))).agents[0]!.events).toHaveLength(before);
  // Save the user work on the base, then commit it in the clone.
  f.commit(f.dir, "user.txt", "keep me");
  sh(f.row.cwd, "add", "user.txt"); sh(f.row.cwd, "commit", "-q", "-m", "keep me");
  await f.status(true);
  expect(existsSync(f.row.cwd)).toBe(false);
  expect((await f.status()).board).not.toContain("clone kept:");
});

it("refuses a tracked user path renamed into a harness directory", async () => {
  const f = await fixture();
  f.commit(f.dir, "user.txt", "user work");
  sh(f.row.cwd, "fetch", "-q", f.dir, "main"); sh(f.row.cwd, "merge", "--ff-only", "FETCH_HEAD");
  mkdirSync(join(f.row.cwd, ".wzrrd"));
  sh(f.row.cwd, "mv", "user.txt", ".wzrrd/user.txt");
  expect((await f.close()).cloneError).toContain('non-harness paths "user.txt"');
  expect(existsSync(f.row.cwd)).toBe(true);
});

it("surfaces legacy closed rows with unknown cause without auto-removing them", async () => {
  const f = await fixture();
  await runWith(f.h, mutate(f.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, state: "closed" as const, pane: null })) }, undefined] as const)));
  f.h.herdr.panes.delete(f.row.pane!.paneId);
  expect((await f.status(true)).board).toContain("cause unknown; retry to classify");
  expect(existsSync(f.row.cwd)).toBe(true);
  await f.close();
  expect(existsSync(f.row.cwd)).toBe(false);
});

it("status retries unreachable closed work after a new landedAs is recorded on base", async () => {
  const f = await fixture();
  const id = f.commit(f.row.cwd, "work.txt", "first");
  const head = f.commit(f.row.cwd, "work.txt", "second");
  expect(head).not.toBe(id);
  await runWith(f.h, packetReport({ dir: f.dir, agent: f.row.name, owner: f.h.sessionId, cwd: f.row.cwd, commit: head, summary: "land later", checks: [] }));
  await runWith(f.h, packetVerify(f.dir, head));
  expect((await f.close()).cloneError).toContain("unreachable");
  const landedAs = f.commit(f.dir, "work.txt", "second");
  await runWith(f.h, packetLand(f.dir, { id: head, outcome: "committed", landedAs }));
  f.commit(f.dir, "work.txt", "later base edit");
  expect((await f.status(true)).board).not.toContain("clone kept:");
  expect(existsSync(f.row.cwd)).toBe(false);
});

it("does not use an older landed packet as proof for newer unharvested work", async () => {
  const f = await fixture();
  const id = f.commit(f.row.cwd, "work.txt", "landed");
  f.commit(f.dir, "work.txt", "landed");
  await runWith(f.h, packetReport({ dir: f.dir, agent: f.row.name, owner: f.h.sessionId, cwd: f.row.cwd, commit: id, summary: "landed", checks: [] }));
  await runWith(f.h, packetVerify(f.dir, id));
  await runWith(f.h, packetLand(f.dir, { id, outcome: "committed", landedAs: sh(f.dir, "rev-parse", "HEAD").trim() }));
  f.commit(f.row.cwd, "new.txt", "not landed");
  expect((await f.close()).cloneError).toContain("unreachable");
  expect(existsSync(f.row.cwd)).toBe(true);
});

it.each(["unharvested", "harvested", "offline"])("refreshes each source once per status pass (%s), including retirement reassessment", async kind => {
  const f = await fixture();
  const origin = makeRepo(join(f.h.root, "origin"));
  sh(f.dir, "remote", "add", "origin", origin);
  const { row: second } = await runWith(f.h, agentLaunchForeground(f.dir, { action: "launch", name: "second", lane: "reap", role: "worker", label: "second", clone: true, prompt: "test" }));
  for (const row of [f.row, second]) {
    f.commit(row.cwd, `${row.name}.txt`, row.name);
    expect((await runWith(f.h, agentClose(f.dir, { name: row.name }))).cloneError).toContain("unreachable");
    if (kind === "harvested") {
      sh(origin, "fetch", "-q", row.cwd, "HEAD"); sh(origin, "cherry-pick", "FETCH_HEAD");
    }
  }
  const proc = f.h.proc;
  let fetches = 0;
  f.h.proc = { run: (command, args, options) => {
    if (command === "git" && args[0] === "fetch" && args.includes("origin")) {
      fetches++;
      if (kind === "offline") return Effect.succeed({ code: 1, stdout: "", stderr: "offline" });
    }
    return proc.run(command, args, options);
  } };
  await f.status(true);
  expect(fetches).toBe(1);
  expect(existsSync(f.row.cwd)).toBe(kind !== "harvested");
  expect(existsSync(second.cwd)).toBe(kind !== "harvested");
  if (kind !== "harvested") {
    await f.status(true);
    expect(fetches).toBe(2); // Cache never survives the pass.
  }
});

// rats-nest, 2026-10-26: the close's origin refresh used an explicit refspec, so rat-king's negative fetch refspec
// (^refs/heads/alchemy-nest-dist/*) was ignored and the excluded branch came back on every close.
it("refreshes origin with the repo's configured fetch refspecs, negative entries included", async () => {
  const f = await fixture();
  const origin = makeRepo(join(f.h.root, "origin"));
  sh(origin, "branch", "dist/pin");
  sh(f.dir, "remote", "add", "origin", origin);
  sh(f.dir, "config", "--add", "remote.origin.fetch", "^refs/heads/dist/*");
  f.commit(f.row.cwd, "work.txt", "unlanded");
  expect((await f.close()).cloneError).toContain("unreachable");
  expect(sh(f.dir, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/").trim().split("\n")).not.toContain("refs/remotes/origin/dist/pin");
  expect(sh(f.dir, "rev-parse", "--verify", "refs/remotes/origin/main").trim()).toBe(sh(origin, "rev-parse", "main").trim());
});

// Tin-Tin, #43 review: --prune on a configured refspec whose destination is outside refs/remotes/origin/ would delete
// local refs on every close.
it("keeps local refs when a configured refspec writes outside refs/remotes/origin/, still honouring negatives", async () => {
  const f = await fixture();
  const origin = makeRepo(join(f.h.root, "origin"));
  sh(origin, "branch", "dist/pin");
  sh(f.dir, "remote", "add", "origin", origin);
  sh(f.dir, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/mirror/*");
  sh(f.dir, "config", "--add", "remote.origin.fetch", "^refs/heads/dist/*");
  sh(f.dir, "update-ref", "refs/mirror/keep", "HEAD");
  f.commit(f.row.cwd, "work.txt", "unlanded");
  expect((await f.close()).cloneError).toContain("unreachable");
  expect(sh(f.dir, "rev-parse", "--verify", "refs/mirror/keep").trim()).toBe(sh(f.dir, "rev-parse", "HEAD").trim());
  expect(sh(f.dir, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/").trim().split("\n")).not.toContain("refs/remotes/origin/dist/pin");
  expect(sh(f.dir, "rev-parse", "--verify", "refs/remotes/origin/main").trim()).toBe(sh(origin, "rev-parse", "main").trim());
});

it("records SSH removal failures and retries an already-closed remote row through the same path", async () => {
  const f = await fixture();
  for (const root of [f.dir, f.row.cwd]) {
    mkdirSync(join(root, ".brain"), { recursive: true });
    writeFileSync(join(root, ".brain/note.svx"), "same remote note");
  }
  const machines = decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/muster", workerWorktree: f.h.workerWorktree, env: {}, wrap: [] } });
  await runWith(f.h, mutate(f.dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, machine: "remote" })) }, undefined] as const)));
  let refuse = true;
  const ssh: string[] = [];
  const remoteClose = () => runWith(f.h, Effect.gen(function* () {
    const env = yield* MusterEnv;
    return yield* agentClose(f.dir, { name: f.row.name }).pipe(
      Effect.provideService(MusterEnv, { ...env, machines, remoteHerdr: () => Effect.succeed(f.h.herdr.client()) }),
      Effect.provideService(Proc, { run: (command, args, options) => {
        if (command !== "ssh") return f.h.proc.run(command, args, options);
        const script = args.at(-1)!;
        ssh.push(script);
        if (refuse && script.includes("'remove'")) return Effect.succeed({ code: 1, stdout: "", stderr: "remote remove refused" });
        return liveProc.run("sh", ["-c", script], { cwd: f.h.home, timeoutMs: options.timeoutMs, input: options.input });
      } }),
    );
  }));
  const first = await remoteClose();
  expect(first.row.state).toBe("closed");
  expect(first.cloneError).toContain("remote remove refused");
  expect(first.row.events?.at(-1)?.type).toBe("CLONE_KEPT");
  expect(existsSync(f.row.cwd)).toBe(true);
  refuse = false;
  const second = await remoteClose();
  expect(second.cloneError).toBeNull();
  expect(second.row.events?.at(-1)?.type).toBe("CLONE_REMOVED");
  expect(existsSync(f.row.cwd)).toBe(false);
  expect(ssh.some(script => script.includes("'--force'"))).toBe(true);
});

// Nicodemus, 2026-10-13: a killed pane leaves its reader heartbeat behind, which the crash sweep reads as a crash.
it("drops the closed row's reader heartbeat on its machine", async () => {
  const f = await fixture();
  const readers = join(f.h.home, ".local/state/rat-king/pi/readers");
  mkdirSync(readers, { recursive: true });
  const beat = join(readers, `reap.${f.row.name}.json`);
  writeFileSync(beat, "{}");
  const other = join(readers, "reap.someone-else.json");
  writeFileSync(other, "{}");
  const previous = process.env.HOME;
  process.env.HOME = f.h.home;
  try {
    const closed = await f.close();
    expect(existsSync(beat)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(closed.notes).toContain(`reader heartbeat reap.${f.row.name}.json removed, so the crash sweep does not read this close as a crash`);
  } finally { process.env.HOME = previous; }
});

// Nicodemus, 2026-10-11: mail to a closed row's name was accepted and never read. Close retires the name.
it("retires the closed row's Rat King name through the fleet mailbox shim, and only notes a failure", async () => {
  const f = await fixture();
  const shim = join(f.h.home, ".config/muster/fleet-mailbox.sh");
  mkdirSync(join(shim, ".."), { recursive: true });
  writeFileSync(shim, `printf '%s ' "$@" > "${f.h.root}/retire-args"; exit 0\n`);
  const closed = await f.close();
  expect(readFileSync(join(f.h.root, "retire-args"), "utf8").trim()).toBe(`retire --name reap/${f.row.name}`);
  expect(closed.notes).toContain(`Rat King name reap/${f.row.name} retired: sends to it now fail Retired`);
  writeFileSync(shim, "echo 'Error: reserved name' >&2; exit 3\n");
  const again = await f.close();
  expect(again.notes).toContain(`Rat King name reap/${f.row.name} not retired (exit 3: Error: reserved name)`);
  // Tin-Tin, 2026-10-13: the real CLI logs to stdout; a never-issued name is nothing to retire.
  writeFileSync(shim, "echo '[19:22:42.010] ERROR (#2): CliError: Issuer refused sh.mschf.ratking.identity.retireName (NameNotFound)'; echo '    at operatorCall (retire.ts:54:21)'; exit 1\n");
  expect((await f.close()).notes).toContain(`Rat King name reap/${f.row.name} was never issued (a launch that failed before its Pi started); nothing to retire`);
  writeFileSync(shim, "echo '[19:22:42.010] ERROR (#2): CliError: Issuer refused sh.mschf.ratking.identity.retireName (Forbidden)'; exit 1\n");
  expect((await f.close()).notes).toContain(`Rat King name reap/${f.row.name} not retired (exit 1: ERROR (#2): CliError: Issuer refused sh.mschf.ratking.identity.retireName (Forbidden))`);
});

// Tin-Tin, #36 review: a rowless Switchboard owner with no recorded name is found through its subscription, as owner mail does.
it("names a subscribed Switchboard owner as the retired name's successor", async () => {
  const f = await fixture();
  expect(f.row.ownerName).toBeUndefined();
  const shim = join(f.h.home, ".config/muster/fleet-mailbox.sh");
  mkdirSync(join(shim, ".."), { recursive: true });
  writeFileSync(shim, `printf '%s ' "$@" > "${f.h.root}/retire-args"; exit 0\n`);
  const switchboards = join(f.h.home, ".local/state/muster/switchboards");
  mkdirSync(switchboards, { recursive: true });
  writeFileSync(join(switchboards, encodeURIComponent(f.row.owner)), "switchboard\n");
  const closed = await f.close();
  expect(readFileSync(join(f.h.root, "retire-args"), "utf8").trim()).toBe(`retire --name reap/${f.row.name} --successor switchboard`);
  expect(closed.notes).toContain(`Rat King name reap/${f.row.name} retired: sends to it now fail Retired, naming switchboard`);
});

// Ernestine, 2026-10-11: worker-worktree.sh remove refuses while a process has its cwd in the clone (dark-wizard 22c7f59).
it("retries removal while a just-closed session is still exiting, and keeps the clone with a plain note if it never does", async () => {
  const f = await fixture();
  const real = readFileSync(f.h.workerWorktree, "utf8");
  const counter = join(f.h.root, "holder-count");
  const refuse = (times: number) => real.replace(/^(#!.*\n)/, shebang => shebang + `if [ "$1" = remove ]; then n=$(cat "${counter}" 2>/dev/null || echo 0); if [ "$n" -lt ${times} ]; then echo $((n+1)) > "${counter}"; echo "worker-worktree: refusing: process 42 (pi) still runs inside $2; close its session first" >&2; exit 1; fi; fi\n`);
  writeFileSync(f.h.workerWorktree, refuse(2));
  expect((await f.close()).cloneError).toBeNull();
  expect(readFileSync(counter, "utf8").trim()).toBe("2");
  expect(existsSync(f.row.cwd)).toBe(false);
});

it("keeps the clone and says why when a process never leaves it", async () => {
  const f = await fixture();
  const real = readFileSync(f.h.workerWorktree, "utf8");
  writeFileSync(f.h.workerWorktree, real.replace(/^(#!.*\n)/, shebang => shebang + `if [ "$1" = remove ]; then echo "worker-worktree: refusing: process 42 (zsh) still runs inside $2; close its session first" >&2; exit 1; fi\n`));
  const closed = await f.close();
  expect(closed.cloneError).toContain("clone kept: a process still runs inside it (a pane shell Muster did not open, or a session still exiting)");
  expect(existsSync(f.row.cwd)).toBe(true);
});

// Nicodemus, 2026-10-11: the source already held a stale copy of the worker branch; the quiet fetch was rejected as a
// non-fast-forward with exit 1 and an empty stderr, three times.
it("lands over a stale, diverged copy of the worker branch in the source", async () => {
  const f = await fixture();
  const branch = f.row.clone!.branch;
  const tree = sh(f.dir, "rev-parse", "HEAD^{tree}").trim();
  const stale = sh(f.dir, "commit-tree", tree, "-m", "stale worker copy").trim();
  sh(f.dir, "branch", "-f", branch, stale);
  const head = f.commit(f.row.cwd, "work.txt", "rebased work");
  await runWith(f.h, packetReport({ dir: f.dir, agent: f.row.name, owner: f.h.sessionId, cwd: f.row.cwd, commit: head, summary: "land over stale", checks: [] }));
  await runWith(f.h, packetVerify(f.dir, head));
  const landed = await runWith(f.h, packetLand(f.dir, { id: head, outcome: "committed" }));
  expect(sh(f.dir, "rev-parse", branch).trim()).toBe(head);
  expect(sh(f.dir, "merge-base", "--is-ancestor", head, "HEAD")).toBe("");
  expect(JSON.stringify(landed)).toContain(head.slice(0, 7));
});
