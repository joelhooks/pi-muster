import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateRepoName, parseHeavyGate, runFleetGate, fleetRunner, fleetStatus, type FleetGateOptions } from "./fleet-gate.ts";
import { liveProc, Proc, type ProcShape } from "./runtime.ts";

const cli = fileURLToPath(new URL("../bin/muster-heavy.ts", import.meta.url));
const sha = "a".repeat(40);
afterEach(() => vi.unstubAllEnvs());

function fixture(origin = "git@github.com:joelhooks/pi-muster.git") {
  const cwd = join(mkdtempSync(join(tmpdir(), "muster-fleet-gate-")), "worker-clone");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(cwd, "file"), "initial\n");
  git("add", "file");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  if (origin) git("remote", "add", "origin", origin);
  const options: FleetGateOptions = { cwd, home: cwd, wait: 1200, host: "auto", command: ["sh", "-c", "npm run check && npm test"] };
  return { cwd, git, options };
}

function fakeRunner(exit = 0, receipt = true, fields: Record<string, unknown> = {}) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const proc: ProcShape = { run: (command, args, options) => {
    if (command === "sh" && args[1] === "command -v fleet-compute") return Effect.succeed({ code: 0, stdout: "/fake/fleet-compute\n", stderr: "" });
    if (command !== "/fake/fleet-compute") return liveProc.run(command, args, options);
    calls.push({ command, args });
    if (receipt) {
      const value = (flag: string) => args[args.indexOf(flag) + 1]!;
      writeFileSync(value("--receipt"), JSON.stringify({ host: "pennywise", runId: "fake-run", tree: value("--tree"), slot: 1, durationMs: 38_000, exit, ...fields }));
    }
    return Effect.succeed({ code: exit, stdout: "", stderr: "" });
  } };
  return { calls, proc };
}
const run = (options: FleetGateOptions, proc: ProcShape) => Effect.runPromise(runFleetGate(options).pipe(Effect.provideService(Proc, proc)));

describe("fleet gate routing", () => {
  it("routes a registered repo using its origin, committed tree and immutable parents", async () => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { options, git } = fixture();
    const { calls, proc } = fakeRunner();
    const result = await run(options, proc);
    expect(result.kind).toBe("fleet");
    expect(calls).toHaveLength(1);
    if (result.kind !== "fleet") throw new Error("expected fleet");
    expect(calls[0]!.args).toEqual([
      "gate", "--project", "pi-muster", "--repo", "pi-muster", "--source", git("rev-parse", "--show-toplevel"),
      "--tree", git("rev-parse", "HEAD^{tree}"), "--head", git("rev-parse", "HEAD"), "--branch", git("rev-parse", "HEAD"),
      "--host", "auto", "--wait", "1200", "--receipt", result.receiptPath,
      "--", ...options.command,
    ]);
    expect(result.note).toContain("host pennywise; run fake-run; exit 0; duration 38000ms");
  });

  it.each(["unregistered-repo", "remote-never"])("routes %s through fleet too; eligibility belongs to fleet", async repo => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { options } = fixture(`https://example.invalid/owner/${repo}.git`);
    const { calls, proc } = fakeRunner();
    expect((await run(options, proc)).kind).toBe("fleet");
    expect(calls[0]!.args).toContain(repo);
  });

  it.each(["off", "missing"])("falls back with a note when runner is %s", async mode => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", mode === "off" ? "off" : "");
    const { options } = fixture();
    const proc: ProcShape = { run: (command, args, o) => command === "sh"
      ? Effect.succeed({ code: 1, stdout: "", stderr: "" }) : liveProc.run(command, args, o) };
    expect(await run(options, proc)).toMatchObject({ kind: "local", note: expect.stringContaining(mode === "off" ? "MUSTER_FLEET_COMPUTE=off" : "fleet-compute missing") });
  });

  it.each(["tracked", "staged", "untracked"])("refuses %s dirt without --tree before runner admission", async dirt => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { cwd, options, git } = fixture();
    writeFileSync(join(cwd, dirt === "untracked" ? "new-file" : "file"), "changed\n");
    if (dirt === "staged") git("add", "file");
    const { calls, proc } = fakeRunner();
    await expect(run(options, proc)).rejects.toThrow(/dirty working tree.*--tree/);
    expect(calls).toEqual([]);
  });

  it("passes an explicit staged tree and --host flagg through unchanged", async () => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { cwd, options, git } = fixture();
    writeFileSync(join(cwd, "file"), "changed\n");
    git("add", "file");
    const tree = git("write-tree");
    const { calls, proc } = fakeRunner();
    expect((await run({ ...options, tree, host: "flagg" }, proc)).kind).toBe("fleet");
    const args = calls[0]!.args;
    expect(args[args.indexOf("--tree") + 1]).toBe(tree);
    expect(args[args.indexOf("--host") + 1]).toBe("flagg");
  });

  it.each([0, 1, 75])("propagates exit %s", async exit => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { options } = fixture();
    const { proc } = fakeRunner(exit, exit !== 75);
    expect(await run(options, proc)).toMatchObject({ kind: "fleet", code: exit });
  });

  it("does not call a receipt-less zero exit proven", async () => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { options } = fixture();
    expect(await run(options, fakeRunner(0, false).proc)).toMatchObject({ kind: "fleet", code: 1, note: expect.stringContaining("not proven") });
  });

  it.each([{ tree: sha }, { exit: 1 }, { durationMs: "invalid" }])("fails closed for inconsistent or malformed receipt %j", async fields => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { options } = fixture();
    await expect(run(options, fakeRunner(0, true, fields).proc)).rejects.toThrow(/receipt/);
  });

  it("fails closed for a lost run even when the runner exits zero", async () => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { options } = fixture();
    expect(await run(options, fakeRunner(0, true, { exit: null }).proc)).toMatchObject({ code: 1, note: expect.stringContaining("exit lost") });
  });

  it("refuses dirt even with the kill switch off", async () => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
    const { cwd, options } = fixture();
    writeFileSync(join(cwd, "file"), "changed");
    await expect(run(options, liveProc)).rejects.toThrow(/dirty working tree/);
  });

  it("uses the checkout name if there is no origin", async () => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", "");
    const { options } = fixture("");
    const { calls, proc } = fakeRunner();
    await run(options, proc);
    expect(calls[0]!.args[2]).toBe(options.cwd.split("/").at(-1));
  });

  it("shares explicit runner lookup and status decoding", async () => {
    vi.stubEnv("MUSTER_FLEET_COMPUTE", cli);
    const runner = await Effect.runPromise(fleetRunner(process.cwd()).pipe(Effect.provideService(Proc, liveProc)));
    expect(runner).toEqual({ command: "node", prefix: [cli] });
    const proc: ProcShape = { run: () => Effect.succeed({ code: 0, stdout: '{"machines":[],"queue":[]}', stderr: "" }) };
    expect(await Effect.runPromise(fleetStatus(process.cwd(), runner!).pipe(Effect.provideService(Proc, proc)))).toEqual({ machines: [], queue: [] });
  });
});

describe("heavy gate CLI", () => {
  it.each([0, 1, 75])("streams a fake runner and exits %s", exit => {
    const { cwd, git } = fixture();
    const runner = join(cwd, "runner.ts");
    writeFileSync(runner, `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag)+1];
writeFileSync(${JSON.stringify(join(cwd, "args.json"))}, JSON.stringify(args));
${exit === 75 ? "" : `writeFileSync(value('--receipt'), JSON.stringify({host:'pennywise',runId:'cli-run',tree:value('--tree'),slot:0,durationMs:5,exit:${exit}}));`}
console.log('streamed output'); process.exit(${exit});\n`);
    const result = spawnSync(process.execPath, [cli, "gate", "--tree", git("rev-parse", "HEAD^{tree}"), "--host", "flagg", "--wait", "3", "--", "sh", "-c", "echo arbitrary command"], {
      cwd, encoding: "utf8", timeout: 20_000, env: { ...process.env, MUSTER_FLEET_COMPUTE: runner, MUSTER_DEPLOY_WINDOW: undefined, MUSTER_HEAVY_GRANT: undefined, HOME: cwd },
    });
    expect(result.status, result.stderr).toBe(exit);
    expect(result.stdout).toContain("streamed output");
    expect(JSON.parse(readFileSync(join(cwd, "args.json"), "utf8"))).toEqual(expect.arrayContaining(["--host", "flagg", "--", "sh", "-c", "echo arbitrary command"]));
    expect(result.stderr).toContain(exit === 75 ? "no receipt" : "host pennywise; run cli-run");
  }, 30_000);

  it("keeps legacy heavy argv parsing separate", () => {
    expect(parseHeavyGate(["--wait", "3", "--tree", sha, "--host", "pennywise", "--", "echo", "--tree"])).toEqual({ wait: 3, tree: sha, host: "pennywise", command: ["echo", "--tree"] });
    for (const args of [["--exclusive", "--", "true"], ["--wait", "-1", "--", "true"], ["--wait", "1", "--wait", "2", "--", "true"], ["--tree", "HEAD", "--", "true"], ["--host", "elsewhere", "--", "true"], ["--"]]) expect(() => parseHeavyGate(args)).toThrow();
    expect(gateRepoName("/clone/lane", "ssh://git@example.invalid/owner/drovr.git")).toBe("drovr");
  });
});
