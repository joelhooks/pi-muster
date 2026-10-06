import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mode } from "./domain.ts";
import { MusterEnv } from "./runtime.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { shellQuote } from "./argv.ts";
import { runWith, harness, makeRepo, sh } from "./test-support.ts";

afterEach(() => vi.unstubAllEnvs());

async function fixture(mode: Mode = "rift-merge", base?: string, remote = false) {
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const h = harness();
  const origin = makeRepo(join(h.root, "origin"));
  const dir = join(h.root, "source");
  sh(h.root, "clone", "-q", origin, dir);
  const initial = sh(dir, "rev-parse", "HEAD").trim();
  // Match the real script's fetch/default behavior, not test-support's source-HEAD default.
  writeFileSync(h.workerWorktree, `#!/bin/sh
set -eu
source="$2"
target=${shellQuote(join(h.root, "clone"))}
git -C "$source" fetch -q origin
base="origin/main"
if [ "\${4:-}" = --base ]; then base="$5"; fi
sha=$(git -C "$source" rev-parse "$base^{commit}")
git clone -q "$source" "$target"
git -C "$target" checkout -q -b "worker/$3" "$sha"
printf 'worktree: %s\\nbranch: worker/%s\\nbase: %s %s\\n' "$target" "$3" "$base" "$sha"
`);
  chmodSync(h.workerWorktree, 0o755);
  const calls: Array<readonly string[]> = [];
  const proc = h.proc;
  h.proc = { run: (command, args, options) => {
    if (command === h.workerWorktree) calls.push(args);
    // SSH is simulated by executing its quoted command against separate source paths.
    if (command === "ssh") {
      const script = args.at(-1)!;
      if (script.includes("muster-prerequisites")) return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      return proc.run("sh", ["-c", script], { ...options, cwd: h.home });
    }
    return proc.run(command, args, options);
  } };
  const remoteSource = remote ? join(h.root, "remote-source") : dir;
  if (remote) {
    sh(h.root, "clone", "-q", origin, remoteSource);
    // Remote launches start Pi via pane.run instead of agent.start.
    const handle = h.herdr.handle.bind(h.herdr);
    h.herdr.handle = (method, params) => {
      const result = handle(method, params);
      if (method === "pane.send_input" && String(params.text).includes(" && exec ")) {
        const args = [...String(params.text).matchAll(/'([^']*)'/g)].map(match => match[1]!);
        handle("agent.start", { name: "pi", pane_id: params.pane_id, args: args.slice(args.lastIndexOf("pi") + 1) });
      }
      return result;
    };
  }
  const run = <A, E>(program: Parameters<typeof runWith<A, E>>[1]) => runWith(h, remote ? program.pipe(Effect.provideService(MusterEnv, {
    home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: h.workerWorktree,
    createId: () => "remote-id", sleep: () => Effect.void, emitPaneClose: h.emitPaneClose,
    machines: { remote: { herdr: "remote", ssh: "remote", paths: { [dir]: remoteSource }, musterExtension: "/muster", workerWorktree: h.workerWorktree, env: {}, wrap: [] } },
    remoteHerdr: () => Effect.succeed(h.herdr.client()),
  })) : program);
  await run(projectOpen({ dir, slug: "probe", outcome: "test", reviewTrigger: "weekly", nextAction: "test", criticalPath: [], space: "w1", ephemeral: true, mode }));
  await run(laneOpen(dir, { slug: "work", label: "work", goal: "test", ...(base ? { base } : {}) }));
  const launch = () => run(agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", clone: true, noSkills: true, ...(remote ? { machine: "remote" } : {}) }));
  const commit = (repo: string) => {
    writeFileSync(join(repo, "landed"), "landed locally\n");
    sh(repo, "add", "landed"); sh(repo, "commit", "-qm", "owner lands locally");
    return sh(repo, "rev-parse", "HEAD").trim();
  };
  return { dir, source: remoteSource, origin, initial, calls, launch, commit };
}

describe.each([false, true])("clone local base (remote=%s)", remote => {
  it("starts at local main ahead of origin and names its proven base", async () => {
    const s = await fixture("rift-merge", undefined, remote);
    const head = s.commit(s.source);
    const result = await s.launch();
    expect(sh(result.row.cwd, "rev-parse", "HEAD").trim()).toBe(head);
    expect(result.row.clone?.base).toEqual({ ref: "main", sha: head });
    expect(result.notes).toContain(`base: main ${head.slice(0, 7)} (local, rift-merge)`);
  });
  it("lets an explicit lane base win", async () => {
    const s = await fixture("rift-merge", "origin/main", remote);
    s.commit(s.source);
    const result = await s.launch();
    expect(result.row.clone?.base).toEqual({ ref: "origin/main", sha: s.initial });
    expect(result.notes).toContain(`base: origin/main ${s.initial.slice(0, 7)} (explicit)`);
  });
  it.each(["pr-merge", "herdr-workflow"] as const)("leaves %s on the script default", async mode => {
    const s = await fixture(mode, undefined, remote);
    s.commit(s.source);
    const result = await s.launch();
    expect(result.row.clone?.base).toEqual({ ref: "origin/main", sha: s.initial });
  });
  it("falls back with a note on detached HEAD", async () => {
    const s = await fixture("rift-merge", undefined, remote);
    sh(s.source, "checkout", "-q", "--detach");
    s.commit(s.source);
    const result = await s.launch();
    expect(result.row.clone?.base).toEqual({ ref: "origin/main", sha: s.initial });
    expect(result.notes).toContain("source HEAD is detached; using worker-worktree.sh default base");
  });
  it("keeps local main when origin moves ahead, with the freshly fetched count", async () => {
    const s = await fixture("rift-merge", undefined, remote);
    s.commit(s.origin);
    const result = await s.launch();
    expect(result.row.clone?.base).toEqual({ ref: "main", sha: s.initial });
    expect(result.notes).toContain("source main is 1 behind origin/main");
  });
});
