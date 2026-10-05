import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { agentLaunch, laneOpen, packetLand, packetReport, packetVerify, projectOpen } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { machinesPath } from "./remote.ts";
import { liveProc } from "./runtime.ts";
import { failWith, harness, makeRepo, runWith, sh } from "./test-support.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "g" }));
  const brief = join(dir, "brief.md"); writeFileSync(brief, "work\n");
  const { row } = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "probe", label: "worker", clone: true, brief }));
  writeFileSync(join(row.cwd, "work.txt"), "one\n");
  sh(row.cwd, "add", "work.txt"); sh(row.cwd, "commit", "-qm", "one");
  writeFileSync(join(row.cwd, "work.txt"), "two\n");
  sh(row.cwd, "add", "work.txt"); sh(row.cwd, "commit", "-qm", "two");
  const commit = sh(row.cwd, "rev-parse", "HEAD").trim();
  await runWith(h, packetReport({ dir, agent: row.name, owner: "o", cwd: row.cwd, commit, summary: "work", checks: [] }));
  const gone = () => { mkdirSync(join(h.root, "retired")); renameSync(row.cwd, join(h.root, "retired", "clone")); };
  return { h, dir, row, commit, gone };
}

describe("missing clone verification", () => {
  it("verifies a source-main commit and lands with landedAs without rewriting the clone branch", async () => {
    const s = await setup();
    sh(s.dir, "fetch", "-q", s.row.cwd, s.commit); sh(s.dir, "merge", "--ff-only", s.commit); s.gone();
    const result = await runWith(s.h, packetVerify(s.dir, s.commit));
    expect(result.packet.verification?.checks).toContainEqual({ name: "on lane branch", outcome: "pass", detail: "clone gone; found on main in source" });
    expect(result.packet.verification?.checks).toContainEqual({ name: "dirty paths", outcome: "pass", detail: "clone gone; nothing to compare" });
    expect((await runWith(s.h, load(s.dir))).agents[0]?.clone?.branch).toBe(s.row.clone?.branch);
    expect((await runWith(s.h, packetLand(s.dir, { id: s.commit, outcome: "committed", landedAs: s.commit }))).packet.state).toBe("committed");
  });

  it("verifies a multi-commit squash landing by patch-id even after main advances", async () => {
    const s = await setup();
    sh(s.dir, "fetch", "-q", s.row.cwd, s.commit); sh(s.dir, "merge", "--squash", s.commit); sh(s.dir, "commit", "-qm", "squash");
    const squash = sh(s.dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(s.dir, "later.txt"), "later\n"); sh(s.dir, "add", "later.txt"); sh(s.dir, "commit", "-qm", "later"); s.gone();
    const result = await runWith(s.h, packetVerify(s.dir, s.commit));
    expect(result.packet.verification?.checks).toContainEqual({ name: "on lane branch", outcome: "pass", detail: `clone gone; landed by squash as ${squash}` });
    expect((await runWith(s.h, packetLand(s.dir, { id: s.commit, outcome: "committed", landedAs: squash }))).packet.state).toBe("committed");
  });

  it("fails plainly when the source has no packet commit", async () => {
    const s = await setup(); s.gone();
    const error = await failWith(s.h, packetVerify(s.dir, s.commit));
    expect(error._tag).toBe("PacketCheckFailed");
    expect(JSON.stringify(error.failures)).toContain(`clone ${s.row.cwd} is gone and ${s.commit} is not in ${s.dir}; land with outcome rejected or no_changes and evidence`);
    expect((await runWith(s.h, packetLand(s.dir, { id: s.commit, outcome: "rejected", evidence: "commit is absent" }))).packet.state).toBe("rejected");
  });

  it.each(["main", "squash", "absent"])("uses the mapped remote source for a missing remote clone (%s)", async landing => {
    const s = await setup();
    const remoteSource = join(s.h.root, "remote-source");
    sh(s.h.root, "clone", "-q", s.dir, remoteSource);
    if (landing !== "absent") {
      sh(remoteSource, "fetch", "-q", s.row.cwd, s.commit);
      if (landing === "main") sh(remoteSource, "merge", "--ff-only", s.commit);
      else { sh(remoteSource, "merge", "--squash", s.commit); sh(remoteSource, "commit", "-qm", "squash"); }
    }
    const landingSha = sh(remoteSource, "rev-parse", "HEAD").trim();
    mkdirSync(join(s.h.home, ".config", "muster"), { recursive: true });
    writeFileSync(machinesPath(s.h.home), JSON.stringify({ remote: { herdr: "remote", ssh: "remote", paths: { [s.dir]: remoteSource }, musterExtension: "/remote/muster", workerWorktree: "/remote/worker", env: {}, wrap: [] } }));
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, machine: "remote" })) }, undefined] as const)));
    const base = s.h.proc;
    const sshScripts: string[] = [];
    s.h.proc = { run: (command, args, options) => {
      if (command !== "ssh") return base.run(command, args, options);
      const script = args.at(-1)!; sshScripts.push(script);
      return liveProc.run("sh", ["-c", script], { cwd: s.h.home, timeoutMs: options.timeoutMs });
    } };
    s.gone();
    if (landing === "absent") {
      const error = await failWith(s.h, packetVerify(s.dir, s.commit));
      expect(error._tag).toBe("PacketCheckFailed");
      expect(JSON.stringify(error.failures)).toContain(`is not in ${remoteSource}`);
    } else {
      const result = await runWith(s.h, packetVerify(s.dir, s.commit));
      const detail = landing === "main" ? "clone gone; found on main in source" : `clone gone; landed by squash as ${landingSha}`;
      expect(result.packet.verification?.checks).toContainEqual({ name: "on lane branch", outcome: "pass", detail });
      const error = await failWith(s.h, packetLand(s.dir, { id: s.commit, outcome: "committed" }));
      expect(error.message).toContain("clone gone; pass landedAs");
    }
    expect(sshScripts.some(script => script.startsWith(`cd '${s.row.cwd}'`))).toBe(false);
  });

  it("requires landedAs instead of trying rift-merge on a missing clone", async () => {
    const s = await setup(); s.gone();
    await runWith(s.h, mutate(s.dir, project => Effect.succeed([{ ...project, packets: project.packets.map(packet => ({ ...packet, state: "verified" as const })) }, undefined] as const)));
    const error = await failWith(s.h, packetLand(s.dir, { id: s.commit, outcome: "committed" }));
    expect(error.message).toContain("clone gone; pass landedAs");
  });
});
