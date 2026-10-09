import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeMachines } from "./domain.ts";
import { agentClose, agentLaunchForeground, laneOpen, packetLand, packetReport, packetVerify, projectOpen } from "./ops.ts";
import { MusterEnv, Proc, liveProc } from "./runtime.ts";
import { load, mutate } from "./store.ts";
import { forkHarness, harness, makeRepo, runWith, sh } from "./test-support.ts";

let template: ReturnType<typeof harness>;
let templateDir: string;
beforeAll(async () => {
  vi.stubEnv("MUSTER_PROJECT", "");
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  template = harness();
  templateDir = makeRepo(join(template.root, "repo"));
  await runWith(template, projectOpen({ dir: templateDir, slug: "preserve", outcome: "preserve work", nextAction: "test", reviewTrigger: "weekly", space: "w1", ephemeral: true, cadenceMinutes: null, musterExtension: "/muster", deskExtension: null }));
  await runWith(template, laneOpen(templateDir, { slug: "preserve", label: "🛟 preserve", goal: "preserve work" }));
  const brief = join(template.root, "brief.md");
  writeFileSync(brief, "preserve current work\n");
  await runWith(template, agentLaunchForeground(templateDir, { action: "launch", name: "worker", lane: "preserve", role: "worker", label: "🛟 worker", clone: true, brief }));
});
afterEach(() => vi.unstubAllEnvs());

async function fixture(remote: boolean) {
  vi.stubEnv("MUSTER_PROJECT", "");
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  const { h, dir } = forkHarness(template, templateDir);
  if (remote) await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, machine: "remote" })) }, undefined] as const)));
  const row = (await runWith(h, load(dir))).agents[0]!;
  const machines = decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/muster", workerWorktree: h.workerWorktree, env: { HOME: join(h.home, "remote") }, wrap: [] } });
  const ssh: string[] = [];
  let failFetch = false;
  let wrongReadback = false;
  let advanceOnFetch = false;
  let failTranscriptCopy = false;
  let changeTranscript = false;
  let corruptRescue = false;
  const commit = (cwd: string, file = "work.txt", text = "current work") => {
    writeFileSync(join(cwd, file), text);
    sh(cwd, "add", file); sh(cwd, "commit", "-q", "-m", text);
    return sh(cwd, "rev-parse", "HEAD").trim();
  };
  const close = (force = false) => runWith(h, Effect.gen(function* () {
    const env = yield* MusterEnv;
    return yield* agentClose(dir, { name: row.name, force }).pipe(
      Effect.provideService(MusterEnv, { ...env, machines, remoteHerdr: () => Effect.succeed(h.herdr.client()) }),
      Effect.provideService(Proc, { run: (command, args, options) => {
        const script = command === "ssh" ? args.at(-1)! : args.join(" ");
        if (command === "ssh") ssh.push(script);
        const transcriptCopy = script.includes("transcript rescue mismatch") && script.includes(command === "ssh" ? "'rescue'" : " rescue ");
        if (failTranscriptCopy && transcriptCopy) return Effect.succeed({ code: 1, stdout: "", stderr: "injected transcript copy failure" });
        const rescue = script.includes("refs/muster/rescue/");
        const rescueFetch = script.includes("fetch") && script.includes("--no-tags");
        if (failFetch && rescueFetch) return Effect.succeed({ code: 1, stdout: "", stderr: "injected rescue fetch failure" });
        if (wrongReadback && rescue && script.includes("rev-parse")) return Effect.succeed({ code: 0, stdout: `${"0".repeat(40)}\n`, stderr: "" });
        const result = command === "ssh" ? liveProc.run("sh", ["-c", script], { cwd: h.home, timeoutMs: options.timeoutMs }) : h.proc.run(command, args, options);
        return result.pipe(Effect.tap(output => Effect.sync(() => {
          if (corruptRescue && transcriptCopy && output.code === 0) {
            corruptRescue = false;
            const receipt = JSON.parse(output.stdout);
            writeFileSync(join(receipt.dir, receipt.files[0].path), "corrupted rescue");
          }
          if (advanceOnFetch && rescueFetch) { advanceOnFetch = false; commit(row.cwd, "late.txt", "late commit"); }
          if (changeTranscript && transcriptCopy) { changeTranscript = false; writeFileSync(join(row.cwd, ".pi-subagents/artifacts/x_transcript.jsonl"), "changed"); }
        })));
      } }),
    );
  }));
  const report = async (id: string) => {
    await runWith(h, packetReport({ dir, agent: row.name, owner: h.sessionId, cwd: row.cwd, commit: id, summary: "work", checks: [] }));
    // Verify the local fixture's real objects before enabling the remote row.
    if (remote) await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: p.agents.map(r => ({ ...r, machine: "local" })) }, undefined] as const)));
    await runWith(h, packetVerify(dir, id));
    if (remote) await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: p.agents.map(r => ({ ...r, machine: "remote" })) }, undefined] as const)));
  };
  const retained = (head: string) => expect(sh(dir, "rev-parse", `refs/muster/rescue/worker-${head}^{commit}`).trim()).toBe(head);
  return { h, dir, row, commit, close, report, retained, ssh, failTranscriptCopy: () => { failTranscriptCopy = true; }, changeTranscript: () => { changeTranscript = true; }, corruptRescue: () => { corruptRescue = true; }, failFetch: () => { failFetch = true; }, wrongReadback: () => { wrongReadback = true; }, advanceOnFetch: () => { advanceOnFetch = true; } };
}

for (const remote of [false, true]) describe(remote ? "SSH preservation" : "local preservation", () => {
  it.each(["ignored", "untracked", "tracked", "git metadata"])("rescues %s transcripts before retiring, with byte proof and a durable receipt", async kind => {
    const f = await fixture(remote);
    const path = kind === "git metadata" ? ".git/muster/session_transcript.jsonl" : ".pi-subagents/artifacts/x_transcript.jsonl";
    const bytes = Buffer.from(' {"private":"session"}\n\u0000');
    mkdirSync(join(f.row.cwd, path, ".."), { recursive: true });
    writeFileSync(join(f.row.cwd, path), bytes);
    if (kind === "ignored") writeFileSync(join(f.row.cwd, ".git/info/exclude"), ".pi-subagents/\n");
    if (kind === "tracked") {
      sh(f.row.cwd, "add", path); sh(f.row.cwd, "commit", "-qm", "session fixture");
      sh(f.dir, "fetch", "-q", f.row.cwd, "HEAD"); sh(f.dir, "merge", "--ff-only", "FETCH_HEAD");
    }
    const result = await f.close();
    expect(result.cloneError).toBeNull();
    expect(existsSync(f.row.cwd)).toBe(false);
    const detail = result.row.events?.at(-1)?.detail ?? "";
    const rescueDir = /transcripts rescued: ([^;]+);/.exec(detail)?.[1];
    expect(rescueDir).toBeTruthy();
    expect(rescueDir).toContain(join(f.h.home, ...(remote ? ["remote"] : []), ".local/state/transcript-rescue/preserve-worker-"));
    expect(readFileSync(join(rescueDir!, path))).toEqual(bytes);
    expect(detail).toContain(`1 files; ${bytes.length} bytes; sha256 verified`);
    if (remote) expect(f.ssh.some(script => script.includes("transcript rescue mismatch"))).toBe(true);
  });

  it.each(["copy", "changed", "mismatch"])("keeps transcript sources on %s failure, even with force", async kind => {
    const f = await fixture(remote);
    const path = ".pi-subagents/artifacts/x_transcript.jsonl";
    mkdirSync(join(f.row.cwd, path, ".."), { recursive: true });
    writeFileSync(join(f.row.cwd, path), "original");
    if (kind === "copy") f.failTranscriptCopy(); else if (kind === "changed") f.changeTranscript(); else f.corruptRescue();
    const result = await f.close(true);
    expect(result.cloneError).toContain(kind === "copy" ? "injected transcript copy failure" : kind === "changed" ? "transcripts changed during preservation" : "transcript rescue mismatch");
    expect(existsSync(join(f.row.cwd, path))).toBe(true);
    expect(result.row.events?.at(-1)?.type).toBe("CLONE_KEPT");
  });

  it("keeps a clone with a transcript symlink instead of trusting or following it", async () => {
    const f = await fixture(remote);
    const target = join(f.h.home, "external_transcript.jsonl");
    writeFileSync(target, "external session");
    symlinkSync(target, join(f.row.cwd, "session_transcript.jsonl"));
    expect((await f.close(true)).cloneError).toContain("transcript symlink refuses retirement");
    expect(existsSync(f.row.cwd)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("external session");
  });

  it.each(["verified", "rejected", "newer", "no packet"])("force preserves exact current HEAD: %s", async kind => {
    const f = await fixture(remote);
    let head = f.commit(f.row.cwd);
    if (kind !== "no packet") await f.report(head);
    if (kind === "rejected") await runWith(f.h, packetLand(f.dir, { id: head, outcome: "rejected", evidence: "superseded" }));
    if (kind === "newer") {
      const landed = f.commit(f.dir);
      await runWith(f.h, packetLand(f.dir, { id: head, outcome: "committed", landedAs: landed }));
      head = f.commit(f.row.cwd, "new.txt", "newer work");
    }
    expect((await f.close()).cloneError).toContain("unreachable");
    expect(existsSync(f.row.cwd)).toBe(true);
    expect((await f.close(true)).cloneError).toBeNull();
    f.retained(head);
    expect(existsSync(f.row.cwd)).toBe(false);
    if (remote) expect(f.ssh.some(s => s.includes("'update-ref'") && s.includes("refs/muster/rescue/"))).toBe(true);
  });

  it("ordinary close accepts exact legacy rescue, without moving it", async () => {
    const f = await fixture(remote);
    const head = f.commit(f.row.cwd);
    sh(f.dir, "fetch", "--no-write-fetch-head", f.row.cwd, `${head}:refs/muster/rescue/worker`);
    expect((await f.close()).cloneError).toBeNull();
    expect(sh(f.dir, "rev-parse", "refs/muster/rescue/worker").trim()).toBe(head);
    expect(existsSync(f.row.cwd)).toBe(false);
  });

  it("force keeps mixed dirt even with verified work and an external rescue", async () => {
    const f = await fixture(remote);
    const head = f.commit(f.row.cwd);
    await f.report(head);
    sh(f.dir, "fetch", "--no-write-fetch-head", f.row.cwd, `${head}:refs/muster/rescue/worker`);
    mkdirSync(join(f.row.cwd, ".wzrrd"));
    writeFileSync(join(f.row.cwd, ".wzrrd/output.json"), "{}");
    writeFileSync(join(f.row.cwd, "user.txt"), "keep me");
    expect((await f.close(true)).cloneError).toContain('non-harness paths "user.txt"');
    expect(existsSync(join(f.row.cwd, "user.txt"))).toBe(true);
  });

  it.each(["fetch", "readback", "changed"])("keeps clone on rescue %s failure", async kind => {
    const f = await fixture(remote);
    f.commit(f.row.cwd);
    if (kind === "fetch") f.failFetch();
    if (kind === "readback") f.wrongReadback();
    if (kind === "changed") f.advanceOnFetch();
    const result = await f.close(true);
    expect(result.cloneError).toContain(kind === "fetch" ? "injected rescue fetch failure" : kind === "readback" ? "rescue verification failed" : "clone changed during preservation");
    expect(existsSync(f.row.cwd)).toBe(true);
    expect(result.row.events?.at(-1)?.type).toBe("CLONE_KEPT");
  });

  it("refuses a conflicting immutable rescue ref without changing it", async () => {
    const f = await fixture(remote);
    const old = sh(f.dir, "rev-parse", "HEAD").trim();
    const head = f.commit(f.row.cwd);
    const ref = `refs/muster/rescue/worker-${head}`;
    sh(f.dir, "update-ref", ref, old);
    expect((await f.close(true)).cloneError).not.toBeNull();
    expect(sh(f.dir, "rev-parse", ref).trim()).toBe(old);
    expect(existsSync(f.row.cwd)).toBe(true);
  });

  it("refuses a rescue repository inside the disposable clone", async () => {
    const f = await fixture(remote);
    f.commit(f.row.cwd);
    await runWith(f.h, mutate(f.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(r => ({ ...r, clone: r.clone ? { ...r.clone, source: r.cwd } : null })) }, undefined] as const)));
    expect((await f.close(true)).cloneError).toContain("rescue repository is inside clone");
    expect(existsSync(f.row.cwd)).toBe(true);
  });

  it("force preserves HEAD with harness-only dirt and leaves FETCH_HEAD alone", async () => {
    const f = await fixture(remote);
    const head = f.commit(f.row.cwd);
    mkdirSync(join(f.row.cwd, ".wzrrd"));
    writeFileSync(join(f.row.cwd, ".wzrrd/output.json"), "{}");
    const fetchHead = join(f.dir, ".git/FETCH_HEAD");
    writeFileSync(fetchHead, "unrelated fetch receipt\n");
    expect((await f.close(true)).cloneError).toBeNull();
    f.retained(head);
    expect(existsSync(f.row.cwd)).toBe(false);
    expect(readFileSync(fetchHead, "utf8")).toBe("unrelated fetch receipt\n");
  });

  it("preserves earlier rescue refs when current HEAD advances", async () => {
    const f = await fixture(remote);
    const old = f.commit(f.row.cwd);
    sh(f.dir, "fetch", "--no-write-fetch-head", f.row.cwd, `${old}:refs/muster/rescue/worker-${old}`);
    const head = f.commit(f.row.cwd, "new.txt", "next work");
    expect((await f.close()).cloneError).toContain("unreachable");
    expect(existsSync(f.row.cwd)).toBe(true);
    expect((await f.close(true)).cloneError).toBeNull();
    f.retained(old); f.retained(head);
  });

  it("retires fully harvested HEAD without creating a rescue", async () => {
    const f = await fixture(remote);
    f.commit(f.row.cwd);
    sh(f.dir, "fetch", "--no-write-fetch-head", f.row.cwd, "HEAD");
    const head = sh(f.row.cwd, "rev-parse", "HEAD").trim();
    sh(f.dir, "merge", "--ff-only", head);
    expect((await f.close()).cloneError).toBeNull();
    expect(existsSync(f.row.cwd)).toBe(false);
    expect(sh(f.dir, "for-each-ref", "refs/muster/rescue/").trim()).toBe("");
  });
});
