import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentClose, agentLaunchForeground, laneOpen, packetLand, packetReport, packetVerify, projectOpen, projectStatus } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { Effect } from "effect";
import { MusterEnv, Proc, liveProc } from "./runtime.ts";
import { decodeMachines } from "./domain.ts";
import { harness, makeRepo, runWith, sh } from "./test-support.ts";

afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  vi.stubEnv("MUSTER_PROJECT", "");
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "reap", outcome: "retire clones safely", nextAction: "test", reviewTrigger: "weekly", space: "w1", ephemeral: true, cadenceMinutes: null, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "reap", label: "🧹 reap", goal: "retire clones safely" }));
  const brief = join(h.root, "brief.md");
  writeFileSync(brief, "retire clones\n");
  const { row } = await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "worker", lane: "reap", role: "worker", label: "🧹 worker", clone: true, brief }));
  const commit = (path: string, file: string, text: string) => {
    writeFileSync(join(path, file), text);
    sh(path, "add", file); sh(path, "commit", "-q", "-m", text);
    return sh(path, "rev-parse", "HEAD").trim();
  };
  return { h, dir, row, commit, close: () => runWith(h, agentClose(dir, { name: row.name })), status: (act = false) => runWith(h, projectStatus(dir, { act })) };
}

it.each([".wzrrd/output.json", ".brain/data/reap-status.json", ".pi/generated.json"])("force-removes harness-only dirt %s after harvest proof", async path => {
  const f = await fixture();
  mkdirSync(join(f.row.cwd, path, ".."), { recursive: true });
  writeFileSync(join(f.row.cwd, path), "{}");
  expect((await f.close()).cloneError).toBeNull();
  expect(existsSync(f.row.cwd)).toBe(false);
});

it("keeps real unharvested commits, records one refusal, surfaces it and retries closed rows", async () => {
  const f = await fixture();
  f.commit(f.row.cwd, "work.txt", "unlanded");
  const first = await f.close();
  expect(first.cloneError).toContain("unreachable");
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

it("records SSH removal failures and retries an already-closed remote row through the same path", async () => {
  const f = await fixture();
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
        return liveProc.run("sh", ["-c", script], { cwd: f.h.home, timeoutMs: options.timeoutMs });
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
