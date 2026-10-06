#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { homedir, hostname, platform } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finishJob, heavyReport, heavySnapshot, heavyStatus, registerJob, refreshJob, jobsPath, type HeavyOptions } from "../src/heavy-lock.ts";

const usage = "usage: muster-heavy [legacy flags] -- <command> [args...] | status [--json] | report [--since 24h] [--json] | gate [--wait seconds] [--tree sha] [--host auto|flagg|pennywise] -- <command>";
const legacyValueFlags = new Set(["--wait", "--grant", "--slots", "--min-free-gb", "--load-limit", "--window", "--priority", "--ttl", "--revoke"]);
const legacyFlags = new Set(["--exclusive", "--reap", "--list"]);
function ignoredLine(args: readonly string[], options: HeavyOptions) {
  const names = new Set(args.filter(arg => legacyValueFlags.has(arg) || legacyFlags.has(arg) || arg === "grant"));
  for (const key of Object.keys(process.env)) if ((key.startsWith("MUSTER_HEAVY_") || ["MUSTER_DEPLOY_WINDOW", "MUSTER_DEPLOY_CAP_MIN", "MUSTER_EXCLUSIVE_CAP_MIN"].includes(key)) && key !== "MUSTER_HEAVY_GATE_TMP" && process.env[key] !== undefined) names.add(key);
  if (options.window !== undefined) names.add("MUSTER_DEPLOY_WINDOW");
  if (options.grant !== undefined) names.add("MUSTER_HEAVY_GRANT");
  if (names.size) console.error(`muster-heavy: ignored legacy admission settings: ${[...names].join(", ")}`);
}

/** Only Flagg macOS jobs use RAM. An explicit ensure executable supports probes;
 * failure warns and falls back to the inherited TMPDIR. */
export function claimGateTmp(setting = process.env.MUSTER_HEAVY_GATE_TMP, host = { platform: process.platform, name: hostname() }): { dir: string; release: () => void } | undefined {
  if (setting === "off" || host.platform !== "darwin" || host.name.split(".")[0]?.toLowerCase() !== "flagg") return undefined;
  const ensure = setting || join(dirname(fileURLToPath(import.meta.url)), "gate-tmp");
  try {
    const root = execFileSync(ensure, ["ensure"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!root.startsWith("/") || root.includes("\n")) throw new Error("ensure did not return one absolute root");
    const dir = mkdtempSync(join(root, `run-${process.pid}-`));
    let released = false;
    return { dir, release: () => { if (!released) { rmSync(dir, { recursive: true, force: true }); released = true; } } };
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
    const reason = (stderr || (error instanceof Error ? error.message : String(error))).replace(/\s+/g, " ");
    console.error(`muster-heavy: WARNING gate RAM disk unavailable (${reason}); running with inherited TMPDIR=${process.env.TMPDIR ?? "unset"}`);
    return undefined;
  }
}

export async function runHeavy(args: string[], options: HeavyOptions) {
  if (args[0] === "gate") {
    try {
      const [{ Effect }, { Proc, liveProc }, { parseHeavyGate, runFleetGate, streamingGateProc }] = await Promise.all([
        import("effect"), import("../src/runtime.ts"), import("../src/fleet-gate.ts"),
      ]);
      const gate = parseHeavyGate(args.slice(1));
      if (options.window !== undefined || options.grant !== undefined) throw new Error("gate cannot use deploy windows or local grants; unset MUSTER_DEPLOY_WINDOW and MUSTER_HEAVY_GRANT");
      const result = await Effect.runPromise(runFleetGate({ ...gate, cwd: process.cwd(), home: options.home }).pipe(Effect.provideService(Proc, streamingGateProc(liveProc))));
      console.error(result.note);
      if (result.kind === "fleet") process.exit(result.code);
      return runHeavy(["--wait", String(gate.wait), "--", ...gate.command], options);
    } catch (error) {
      console.error(`muster-heavy gate: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  }
  const split = args.indexOf("--");
  const prefix = split < 0 ? args : args.slice(0, split);
  ignoredLine(prefix, options);
  if (args[0] === "grant" && split < 0) return; // Legacy grant management is an inert successful command.
  if (args[0] === "status" && args.slice(1).every(arg => arg === "--json" || arg === "--reap")) {
    console.log(args.includes("--json") ? JSON.stringify(heavySnapshot(options)) : heavyStatus(options));
    return;
  }
  if (args[0] === "report") {
    let since = "24h";
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--json") continue;
      if (args[i] === "--since" && args[i + 1]) since = args[++i]!;
      else throw new Error(usage);
    }
    const report = heavyReport(options, since);
    console.log(args.includes("--json") ? JSON.stringify(report) : [...report.repos, ...report.commands].map(row => JSON.stringify(row)).join("\n"));
    return;
  }
  let valid = split >= 0 && split < args.length - 1;
  for (let i = 0; i < prefix.length; i++) {
    const arg = prefix[i]!;
    if (legacyFlags.has(arg) || arg === "grant") continue;
    if (legacyValueFlags.has(arg) && i + 1 < prefix.length) { i++; continue; }
    // The label following the old `grant` form carries no authority.
    if (i === 1 && prefix[0] === "grant") continue;
    valid = false;
  }
  if (!valid) { console.error(usage); process.exit(2); }
  const command = args.slice(split + 1);
  // The wrapper pid is the job tree root. Registration precedes spawn, so a status
  // pass cannot call an initializing command lost or miss its descendants.
  const gateTmp = claimGateTmp();
  const cleanup = () => gateTmp?.release();
  let job: ReturnType<typeof registerJob>;
  try { job = registerJob(options, command.join(" "), process.cwd(), process.pid, gateTmp?.dir); }
  catch (error) { cleanup(); throw error; }
  process.once("exit", cleanup);
  let child: ReturnType<typeof spawn>;
  let timer: ReturnType<typeof setInterval> | undefined;
  const telemetry = (fn: () => unknown) => {
    try { fn(); } catch (error) { console.error(`muster-heavy telemetry: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
  };
  const listeners = signals.map(signal => { const listener = () => signalChild(signal); process.on(signal, listener); return { signal, listener }; });
  let finished = false;
  const finish = (code: number, cpuSeconds?: number) => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    for (const { signal, listener } of listeners) process.off(signal, listener);
    telemetry(() => finishJob(options, job, code, Date.now(), cpuSeconds));
    telemetry(cleanup);
    process.off("exit", cleanup);
    process.exit(code);
  };
  // time's wait4 accounting preserves CPU for short jobs and exited children
  // between ps samples. -o keeps command stderr streaming and unchanged.
  // GNU -p suppresses signal diagnostics and returns 128 + signal, indistinguishable
  // from an intentional exit 143. Its %x is the child exit field (zero on signal).
  const accountingPath = join(jobsPath(options.home), `${job.id}.time`);
  const format = platform() === "linux" ? ["-f", "real %e\nuser %U\nsys %S\nexit %x"] : ["-p"];
  try {
    child = spawn("/usr/bin/time", [...format, "-o", accountingPath, "--", ...command], {
      stdio: "inherit", detached: true,
      ...(gateTmp && { env: { ...process.env, TMPDIR: `${gateTmp.dir}/` } }),
    });
  } catch (error) {
    console.error(`muster-heavy: ${error instanceof Error ? error.message : String(error)}`);
    finish(127);
    return;
  }
  telemetry(() => refreshJob(options, job));
  timer = setInterval(() => telemetry(() => refreshJob(options, job)), 5000);
  child.on("close", (code, signal) => {
    let accounting = "";
    telemetry(() => { accounting = readFileSync(accountingPath, "utf8"); rmSync(accountingPath, { force: true }); });
    const match = /real\s+([\d.]+)\nuser\s+([\d.]+)\nsys\s+([\d.]+)(?:\nexit (\d+))?\n?$/.exec(accounting);
    const commandSignaled = /(?:Command terminated by signal \d+|time: command terminated abnormally)/.test(accounting)
      || (match?.[4] !== undefined && code !== null && code !== Number(match[4]));
    finish(signal || commandSignaled ? 128 : code ?? 1, match ? Number(match[2]) + Number(match[3]) : undefined);
  });
  child.on("error", error => { console.error(`muster-heavy: ${error.message}`); finish(127); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runHeavy(process.argv.slice(2), { home: homedir(), window: process.env.MUSTER_DEPLOY_WINDOW, grant: process.env.MUSTER_HEAVY_GRANT }); }
  catch (error) { console.error(`muster-heavy: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
}
