import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { Effect, Schema } from "effect";
import { GateReceipt, decodeSlug } from "./domain.ts";
import { InputError, ProcError } from "./errors.ts";
import { FleetStatus } from "./fleet.ts";
import { Proc, git, type ProcResult, type ProcShape } from "./runtime.ts";

const input = (message: string) => new InputError({ message });

/** Resolve at call time: installing the runner needs no extension restart. `MUSTER_FLEET_COMPUTE=off` turns it off. */
export const fleetRunner = (source: string) => Effect.gen(function* () {
  const proc = yield* Proc;
  const configured = process.env.MUSTER_FLEET_COMPUTE;
  if (configured === "off") return null;
  const explicit = configured && isAbsolute(configured) && existsSync(configured) ? configured : null;
  const onPath = explicit ? null : (yield* proc.run("sh", ["-c", "command -v fleet-compute"], { cwd: source, timeoutMs: 10_000 })).stdout.trim();
  return explicit ? { command: "node", prefix: [explicit] } : onPath ? { command: onPath, prefix: [] } : null;
});

export const fleetStatus = (source: string, runner: { command: string; prefix: string[] }) => Effect.gen(function* () {
  const proc = yield* Proc;
  const result = yield* proc.run(runner.command, [...runner.prefix, "status", "--json"], { cwd: source, timeoutMs: 10_000 });
  if (result.code !== 0) return yield* input(`fleet-compute status exited ${result.code}`);
  return yield* Effect.try({
    try: () => Schema.decodeUnknownSync(FleetStatus)(JSON.parse(result.stdout)),
    catch: (error) => input(`fleet-compute status invalid JSON/schema: ${String(error)}`),
  });
});

export interface FleetGateOptions {
  readonly cwd: string;
  readonly command: readonly string[];
  readonly wait: number;
  readonly tree?: string;
  readonly host: "auto" | "flagg" | "pennywise";
  readonly home: string;
}

export function parseHeavyGate(args: readonly string[]): Pick<FleetGateOptions, "command" | "wait" | "tree" | "host"> {
  const split = args.indexOf("--");
  if (split < 0 || !args[split + 1]) throw input("gate requires -- <command> [args...]");
  let wait = 0;
  let tree: string | undefined;
  let host: FleetGateOptions["host"] = "auto";
  const seen = new Set<string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || seen.has(key) || !value || i + 1 >= split) throw input("repeated or incomplete gate option");
    seen.add(key);
    if (key === "--wait" && Number.isFinite(Number(value)) && Number(value) >= 0) wait = Number(value);
    else if (key === "--tree" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) tree = value;
    else if (key === "--host" && (value === "auto" || value === "flagg" || value === "pennywise")) host = value;
    else throw input(`invalid gate option: ${key} ${value}`);
  }
  return { command: args.slice(split + 1), wait, host, ...(tree ? { tree } : {}) };
}

/** A clone directory is a lane name, not a registry key. Prefer its origin's repo name. */
/** Fleet repo key: the origin name made kebab-case (e.g. `codetv.dev` → `codetv-dev`), else the checkout name. */
export function gateRepoName(source: string, origin: string): string {
  const kebab = (value: string | undefined) => (value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/, "");
  return decodeSlug(kebab(origin.trim().split(/[/:]/).at(-1)?.replace(/\.git$/, "")) || kebab(basename(source)));
}

/** Fleet owns registration, host eligibility and queueing for every repo. No policy copy here. */
/** Paths where the checkout differs from `tree`: tracked changes plus untracked,
 * non-ignored files. Measured like fleet-compute's worktree drift, on a scratch index. */
export const checkoutDrift = (source: string, tree: string) => Effect.gen(function* () {
  const proc = yield* Proc;
  const dir = mkdtempSync(join(tmpdir(), "muster-drift-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  const run = (...args: string[]) => proc.run("git", args, { cwd: source, env });
  return yield* Effect.gen(function* () {
    const read = yield* run("read-tree", tree);
    if (read.code !== 0) return yield* input(`cannot read --tree ${tree}: ${read.stderr.trim()}`);
    yield* run("update-index", "-q", "--refresh", "--ignore-missing");
    const changed = yield* run("diff-files", "--name-only");
    const untracked = yield* run("ls-files", "--others", "--exclude-standard");
    if (changed.code !== 0 || untracked.code !== 0) return yield* input(`cannot compare the checkout with --tree ${tree}`);
    return [...new Set([...changed.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean))].sort();
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))));
});

export const runFleetGate = (options: FleetGateOptions) => Effect.gen(function* () {
  const proc = yield* Proc;
  // Refuse even in local fallback mode: a gate without --tree must describe the committed checkout.
  const source = (yield* git(options.cwd, "rev-parse", "--show-toplevel")).trim();
  if (!options.tree && (yield* git(source, "status", "--porcelain=v1", "--untracked-files=normal")).trim()) {
    return yield* input("dirty working tree: commit it or pass --tree <git write-tree SHA>; no gate was run");
  }
  const off = process.env.MUSTER_FLEET_COMPUTE === "off";
  const runner = yield* fleetRunner(source);
  // A missing runner is never a quiet unlocked run: callers believe they hold the lock.
  if (!runner && !off) return yield* input("fleet-compute not found (not on PATH, and MUSTER_FLEET_COMPUTE names no file); set MUSTER_FLEET_COMPUTE to its absolute path, or MUSTER_FLEET_COMPUTE=off for an explicit unlocked local run; no gate was run");
  const head = (yield* git(source, "rev-parse", "HEAD")).trim();
  const tree = (yield* git(source, "rev-parse", "--verify", "--end-of-options", `${options.tree ?? head}^{tree}`)).trim();
  // Flagg and local runs execute this checkout, so --tree must describe it. Only pinned pennywise ships the tree itself.
  if (options.tree && (!runner || options.host !== "pennywise")) {
    const drift = yield* checkoutDrift(source, tree);
    if (drift.length) return yield* input(`checkout differs from --tree ${tree} in ${drift.length} path(s): ${drift.slice(0, 5).join(", ")}${drift.length > 5 ? ", ..." : ""}; this run would execute the checkout, not the tree. Check out or stage exactly that tree, or pin --host pennywise; no gate was run`);
  }
  if (!runner) return { kind: "local" as const, note: "muster-heavy gate: local admission (MUSTER_FLEET_COMPUTE=off)" };
  const origin = yield* proc.run("git", ["remote", "get-url", "origin"], { cwd: source });
  const repo = yield* Effect.try({ try: () => gateRepoName(source, origin.code === 0 ? origin.stdout : ""), catch: error => input(`cannot resolve gate repo: ${String(error)}`) });
  const receiptPath = join(options.home, ".local/state/muster/gates", `${randomUUID()}.json`);
  yield* Effect.try({ try: () => mkdirSync(join(options.home, ".local/state/muster/gates"), { recursive: true, mode: 0o700 }), catch: error => input(`cannot create gate receipt directory: ${String(error)}`) });
  const result = yield* proc.run(runner.command, [
    ...runner.prefix, "gate", "--project", repo, "--repo", repo,
    "--source", source, "--tree", tree, "--head", head, "--branch", head,
    "--host", options.host, "--wait", String(options.wait), "--receipt", receiptPath,
    "--", ...options.command,
  ], { cwd: source, timeoutMs: (options.wait + 45 * 60 + 60) * 1000 });
  const receipt = !existsSync(receiptPath) ? null : yield* Effect.try({
    try: () => Schema.decodeUnknownSync(GateReceipt)(JSON.parse(readFileSync(receiptPath, "utf8"))),
    catch: error => input(`invalid fleet gate receipt: ${String(error)}`),
  });
  if (receipt && receipt.tree !== tree) return yield* input(`fleet gate receipt tree ${receipt.tree} differs from ${tree}`);
  if (receipt && receipt.exit !== null && receipt.exit !== result.code) return yield* input(`fleet gate receipt exit ${receipt.exit} differs from runner exit ${result.code}`);
  // The checkout can move while a gate queues; fleet-compute records the drift it started on.
  if (receipt?.host === "flagg" && receipt.exactTree === false) return yield* input(`fleet gate ran on flagg in a checkout that differed from tree ${tree} (${receipt.dirtyCount ?? "?"} path(s)); not proven. Receipt ${receiptPath}`);
  // Admission timeout has no external receipt; never invent host/run/duration proof for it.
  const note = receipt
    ? `muster-heavy gate: host ${receipt.machine ?? receipt.host}; run ${receipt.runId}; exit ${receipt.exit ?? "lost"}; duration ${receipt.durationMs}ms; receipt ${receiptPath}`
    : `muster-heavy gate: runner exit ${result.code ?? "lost"}; no receipt (not proven)`;
  return { kind: "fleet" as const, code: !receipt || receipt.exit === null ? result.code || 1 : result.code ?? 1, note, receipt, receiptPath };
});

/** CLI gate output streams live; short discovery/git calls retain the shared Proc implementation. */
export function streamingGateProc(base: ProcShape): ProcShape {
  return { run: (command, args, options) => {
    if (!args.includes("gate") || !args.includes("--receipt")) return base.run(command, args, options);
    return Effect.callback<ProcResult, ProcError>((resume) => {
      const child = spawn(command, [...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
      const handlers = signals.map(signal => () => forward(signal));
      signals.forEach((signal, i) => process.on(signal, handlers[i]!));
      const cleanup = () => signals.forEach((signal, i) => process.off(signal, handlers[i]!));
      child.once("error", error => {
        cleanup();
        resume(Effect.fail(new ProcError({ command, code: null, stderr: "", message: error.message })));
      });
      child.once("close", (code, signal) => {
        cleanup();
        resume(Effect.succeed({ code: code ?? (signal ? 128 : 1), stdout: "", stderr: "" }));
      });
      return Effect.sync(() => { cleanup(); child.kill("SIGTERM"); });
    });
  } };
}

