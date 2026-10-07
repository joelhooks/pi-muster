import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { createHerdrClient, type HerdrClient } from "@joelhooks/pi-bellwether/herdr-client";
import { AgentName, Slug, SessionId, decodeAgentRow, decodeOwnerItem, decodeAgentName, decodeMachines, type MachineConfig, type OwnerItem } from "./domain.ts";
import { ProcError, InputError } from "./errors.ts";
import { Herdr, MusterEnv, Proc, type ProcShape } from "./runtime.ts";
import { shellQuote } from "./argv.ts";

const decodeNoteEnvelope = Schema.decodeUnknownSync(Schema.Struct({ project: Slug, machine: AgentName, agent: AgentName, lane: Slug, owner: SessionId, item: Schema.Unknown }));
export function decodeRemoteNote(value: unknown) {
  const envelope = decodeNoteEnvelope(value);
  return { ...envelope, item: decodeOwnerItem(envelope.item) };
}
/** Remote workers retain the exact queue record; publish last so interrupted writes stay invisible. */
export function writeRemoteOwnerItem(owner: string, item: OwnerItem, session: string) {
  const row = decodeAgentRow(JSON.parse(process.env.MUSTER_REMOTE_ROW ?? "null"));
  if (row.machine !== process.env.MUSTER_MACHINE || row.sessionId !== session || item.author !== session || item.lane !== row.lane) throw new Error("remote note identity differs from the launch row");
  const sidecar = decodeRemoteNote({ project: process.env.MUSTER_PROJECT_SLUG, machine: row.machine, agent: row.name, lane: row.lane, owner, item });
  const root = join(row.cwd, ".pi/muster/notes");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${createHash("sha256").update(item.cid).digest("hex")}.json`);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(sidecar), { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

/** Serializes capacity reservations across registered projects on this owner machine. */
export const withMachineLaunchLock = <A, E, R>(name: string, operation: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const safeName = yield* Effect.try({ try: () => decodeAgentName(name), catch: error => new InputError({ message: `invalid machine name: ${String(error)}` }) });
  const parent = join(env.home, ".config/muster/launch-locks");
  const lock = join(parent, safeName);
  const acquire = Effect.try({ try: () => { mkdirSync(parent, { recursive: true, mode: 0o700 }); mkdirSync(lock, { mode: 0o700 }); }, catch: error => new InputError({ message: `machine ${name}: launch lock unavailable at ${lock}; another launch may be in progress. Inspect a stale lock before removing it. ${String(error)}` }) });
  return yield* Effect.acquireUseRelease(acquire, () => operation, () => Effect.sync(() => rmdirSync(lock)));
});

export const machinesPath = (home: string) => join(home, ".config/muster/machines.json");
export const mapPath = (path: string, machine: MachineConfig): string => {
  const prefix = Object.keys(machine.paths).sort((a, b) => b.length - a.length).find(p => path === p || path.startsWith(`${p}/`));
  return prefix ? `${machine.paths[prefix]}${path.slice(prefix.length)}` : path;
};
/** The remote package owns its bundled skills and extensions, regardless of the owner's install directory. */
export const mapWorkerPath = (path: string, machine: MachineConfig) => mapPath(path, { ...machine, paths: { ...machine.paths, [fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")]: machine.musterExtension } });

export const machineConfig = (name: string) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const path = machinesPath(env.home);
  const configs = yield* Effect.try({
    try: () => decodeMachines(env.machines ?? (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {})),
    catch: error => new InputError({ message: `machine ${name}: invalid ${path}: ${String(error)}` }),
  });
  const config = configs[name];
  if (!config) return yield* new InputError({ message: `machine ${name}: not configured in ${path}; absent config means local only` });
  return config;
});

/** The configured clone machine, if any. More than one is a config error, never a guess. */
export const defaultCloneMachine = Effect.gen(function* () {
  const env = yield* MusterEnv;
  const path = machinesPath(env.home);
  const configs = yield* Effect.try({
    try: () => decodeMachines(env.machines ?? (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {})),
    catch: error => new InputError({ message: `invalid ${path}: ${String(error)}` }),
  });
  const names = Object.entries(configs).filter(([, config]) => config.cloneDefault === true).map(([name]) => name);
  if (names.length > 1) return yield* new InputError({ message: `${path}: cloneDefault is set on ${names.join(", ")}; set it on one machine` });
  return names[0];
});

/** SSH has one quoted shell argument; remote user data never becomes local argv. */
export function sshProc(name: string, machine: MachineConfig, runner: ProcShape, localCwd: string): ProcShape {
  return { run: (command, args, options) => {
    const env = { ...machine.env, ...options.env };
    const script = `cd ${shellQuote(options.cwd)} && exec env ${Object.entries(env).map(([k,v]) => `${k}=${shellQuote(v)}`).join(" ")} ${[command, ...args].map(shellQuote).join(" ")}`;
    return runner.run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "--", machine.ssh, script], { cwd: localCwd, timeoutMs: Math.min(options.timeoutMs ?? 30_000, 300_000) }).pipe(
      Effect.mapError(error => new ProcError({ ...error, command: `ssh ${name}`, message: `machine ${name}: ${error.message}` })),
      Effect.flatMap(result => result.code === 255 ? Effect.fail(new ProcError({ command: `ssh ${name}`, code: result.code, stderr: result.stderr, message: `machine ${name}: SSH failed: ${result.stderr.slice(-500)}` })) : Effect.succeed(result)),
    );
  } };
}

/** SSH owns the forward's lifecycle. Reuse a live control master; without one, the hashed local socket is a leftover
 * from a master that outlived ControlPersist, so StreamLocalBindUnlink replaces it. */
export const remoteClient = (name: string, machine: MachineConfig) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  if (env.remoteHerdr) return yield* env.remoteHerdr(name, machine);
  const proc = yield* Proc;
  const hash = createHash("sha256").update(JSON.stringify([machine.ssh, machine.socket])).digest("hex").slice(0, 12);
  const root = join(env.home, ".config/muster/fwd");
  const socket = join(root, `${hash}.sock`);
  const control = join(root, `${hash}.ctl`);
  yield* Effect.try({ try: () => mkdirSync(root, { recursive: true, mode: 0o700 }), catch: error => new InputError({ message: `machine ${name}: forward directory: ${String(error)}` }) });
  const check = yield* proc.run("ssh", ["-S", control, "-O", "check", machine.ssh], { cwd: env.home, timeoutMs: 10_000 });
  if (check.code !== 0) {
    const result = yield* proc.run("ssh", ["-f", "-N", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes", "-o", "ControlMaster=yes", "-o", "ControlPersist=600", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-S", control, "-L", `${socket}:${machine.socket}`, machine.ssh], { cwd: env.home, timeoutMs: 15_000 });
    if (result.code !== 0) return yield* new ProcError({ command: `ssh forward ${name}`, code: result.code, stderr: result.stderr, message: `machine ${name}: socket forward failed: ${result.stderr.slice(-500)}` });
  }
  return createHerdrClient({ socketPath: socket });
}).pipe(Effect.mapError(error => new ProcError({ command: `ssh forward ${name}`, code: error._tag === "ProcError" ? error.code : null, stderr: error._tag === "ProcError" ? error.stderr : "", message: `machine ${name}: ${error.message}` })));

export const onRemote = <A, E, R>(name: string, machine: MachineConfig, effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const runner = yield* Proc;
  const client: HerdrClient = yield* remoteClient(name, machine);
  return yield* effect.pipe(Effect.provideService(Herdr, client), Effect.provideService(Proc, sshProc(name, machine, runner, env.home)), Effect.mapError(error => new ProcError({ command: `remote ${name}`, code: null, stderr: "", message: `machine ${name}: ${String(error)}` })));
});

/** Small read-only probes run in one bounded SSH process. JSON is decoded by the caller's domain schema. */
export const remoteNode = (name: string, machine: MachineConfig, script: string, args: readonly string[] = []) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const runner = yield* Proc;
  const result = yield* sshProc(name, machine, runner, env.home).run("node", ["--input-type=module", "-e", script, ...args], { cwd: "/", timeoutMs: 30_000 });
  if (result.code !== 0) return yield* new ProcError({ command: `node on ${name}`, code: result.code, stderr: result.stderr, message: `machine ${name}: ${result.stderr.slice(-1000)}` });
  return result.stdout;
});

export const prerequisites = (name: string, machine: MachineConfig, source: string) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const proc = yield* Proc;
  const result = yield* sshProc(name, machine, proc, env.home).run("sh", ["-c", 'command -v pi && command -v node && command -v git && command -v rift && test -r "$1/extensions/pi-muster.ts" && test -d "$1/node_modules" && test -x "$2" && test -d "$3" && { test -z "$4" || command -v "$4"; }', "muster-prerequisites", machine.musterExtension, machine.workerWorktree, source, machine.wrap[0] ?? ""], { cwd: "/", timeoutMs: 15_000 });
  if (result.code !== 0) return yield* new InputError({ message: `machine ${name}: missing prerequisites: pi, node, git, rift on PATH; readable ${machine.musterExtension}/extensions/pi-muster.ts (with dependencies); executable ${machine.workerWorktree}; source repository ${source}; wrapper ${machine.wrap[0] ?? "(none)"}. ${result.stderr.slice(-500)}` });
});

export const cloneUrl = (machine: MachineConfig, path: string) => `ssh://${machine.ssh}/${path.replace(/^\//, "")}`;
