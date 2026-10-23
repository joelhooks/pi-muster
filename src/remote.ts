import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { createHerdrClient, type HerdrClient } from "@joelhooks/pi-bellwether/herdr-client";
import { AgentName, Slug, SessionId, decodeAgentRow, decodeOwnerItem, decodeAgentName, decodeMachines, type MachineConfig, type OwnerItem, type AgentRow, type Project } from "./domain.ts";
import { ProcError, InputError } from "./errors.ts";
import { Herdr, MusterEnv, Proc, type ProcShape } from "./runtime.ts";
import { NAME_SHIM, shellQuote } from "./argv.ts";

const decodeNoteEnvelope = Schema.decodeUnknownSync(Schema.Struct({ project: Slug, machine: AgentName, agent: AgentName, lane: Slug, owner: SessionId, item: Schema.Unknown, sendFailed: Schema.optionalKey(Schema.String) }));
export function decodeRemoteNote(value: unknown) {
  const envelope = decodeNoteEnvelope(value);
  return { ...envelope, item: decodeOwnerItem(envelope.item) };
}
/** A worker whose Rat King send failed leaves the note here; the owner pass ingests it. Publishing is temp file then rename. */
export function writeRemoteNoteSidecar(env: Readonly<Record<string, string | undefined>>, input: { project: string; owner: string; item: OwnerItem; sendFailed: string }): string | undefined {
  if (!env.MUSTER_MACHINE || env.MUSTER_MACHINE === "local") return undefined;
  try {
    const row = decodeAgentRow(JSON.parse(env.MUSTER_REMOTE_ROW ?? "null"));
    if (row.machine !== env.MUSTER_MACHINE || input.item.author !== row.sessionId) return undefined;
    const sidecar = decodeRemoteNote({ project: input.project, machine: row.machine, agent: row.name, lane: row.lane, owner: input.owner, item: input.item, sendFailed: input.sendFailed });
    const root = join(sidecarRoots(row.cwd)[0]!, "notes"); mkdirSync(root, { recursive: true });
    const path = join(root, `${input.item.uri.split("/").at(-1)}.json`), temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(sidecar), { mode: 0o600 }); renameSync(temporary, path);
    return path;
  } catch { return undefined; }
}
/** Use the worktree's own git directory, never the shared common directory. Outside git only `.pi/muster` exists.
 * Zeno, 2026-10-12: without stdio, git's "fatal: not a git repository" went to the Pi TUI on every owner pass. */
function resolveSidecarRoots(cwd: string, exec: typeof execFileSync, pathJoin: typeof join, pathResolve: typeof resolve): string[] {
  let gitDir: string;
  try { gitDir = exec("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return [pathJoin(cwd, ".pi/muster")]; }
  return [pathJoin(pathResolve(cwd, gitDir), "muster"), pathJoin(cwd, ".pi/muster")];
}
export const sidecarRoots = (cwd: string) => resolveSidecarRoots(cwd, execFileSync, join, resolve);
/** Same resolver for bounded remote Node probes. */
export const sidecarRootsScript = `import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
${NAME_SHIM}
const sidecarRoots = cwd => (${resolveSidecarRoots.toString()})(cwd,execFileSync,join,resolve);`;

export const remotePullReceipt = (_comms?: string): string[] => [];

/** Orchestration binding only. No identities or keys cross machines. */
export const remoteBindingPath = (cwd: string, name: string) => join(sidecarRoots(cwd)[0]!, "bindings", `${decodeAgentName(name)}.json`);
export function readRemoteBinding(env: Readonly<Record<string, string | undefined>>, name = env.MUSTER_AGENT): AgentRow | undefined {
  if (!env.MUSTER_MACHINE || env.MUSTER_MACHINE === "local" || !name) return undefined;
  try {
    const launch = decodeAgentRow(JSON.parse(env.MUSTER_REMOTE_ROW ?? "null"));
    const row = decodeAgentRow(JSON.parse(readFileSync(remoteBindingPath(launch.cwd, name), "utf8")));
    return row.name === name && row.machine === env.MUSTER_MACHINE && row.sessionId === launch.sessionId ? row : undefined;
  } catch { return undefined; }
}
/** The first stderr line up to any quote or bracket, which is where a parser would echo the row it carried. */
export const stderrClass = (stderr: string) =>
  (stderr.split(/\r?\n/).map(line => line.trim()).find(line => line !== "") ?? "no stderr")
    .replace(/["'`{[].*$/, "…").slice(0, 120);
export const pushRemoteBinding = (project: Project, row: AgentRow) => Effect.gen(function* () {
  const machine = yield* machineConfig(row.machine);
  const runner = yield* Proc;
  const env = yield* MusterEnv;
  const script = `${sidecarRootsScript}
import fs from 'node:fs';
const row=JSON.parse(fs.readFileSync(0,'utf8'));
const root=join(sidecarRoots(row.cwd)[0],'bindings'); fs.mkdirSync(root,{recursive:true,mode:0o700});
const path=join(root,row.name+'.json'),temp=path+'.'+process.pid+'.tmp';
fs.writeFileSync(temp,JSON.stringify(row),{mode:0o600}); fs.renameSync(temp,path);
process.stdout.write('binding pushed');`;
  const result = yield* sshProc(row.machine, machine, runner, env.home).run("node", ["--input-type=module", "-e", script], { cwd: "/", timeoutMs: 30_000, input: JSON.stringify(decodeAgentRow(row)) });
  if (result.code !== 0) return yield* new InputError({ message: `binding ${project.slug}/${row.name}: push failed (exit ${result.code}: ${stderrClass(result.stderr)})` });
});

/**
 * An owner pass re-sends every live remote row's binding, one process per machine, writing only what changed. A push
 * that failed during a restart (the caller had no route) heals on the new owner's next pass instead of leaving workers
 * naming a retired session.
 */
export const syncRemoteBindings = (project: Project, rows: readonly AgentRow[]) => Effect.gen(function* () {
  const runner = yield* Proc;
  const env = yield* MusterEnv;
  const notes: string[] = [];
  let written = 0;
  const script = `${sidecarRootsScript}
import fs from 'node:fs';
let written=0;
for (const row of JSON.parse(fs.readFileSync(0,'utf8'))) {
  const root=join(sidecarRoots(row.cwd)[0],'bindings'); const path=join(root,row.name+'.json'); const next=JSON.stringify(row);
  try { if (fs.readFileSync(path,'utf8')===next) continue; } catch {}
  fs.mkdirSync(root,{recursive:true,mode:0o700}); const temp=path+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,next,{mode:0o600}); fs.renameSync(temp,path); written++;
}
process.stdout.write(String(written));`;
  for (const name of [...new Set(rows.map(row => row.machine))]) {
    const result = yield* machineConfig(name).pipe(
      Effect.flatMap(machine => sshProc(name, machine, runner, env.home).run("node", ["--input-type=module", "-e", script], { cwd: "/", timeoutMs: 30_000, input: JSON.stringify(rows.filter(row => row.machine === name).map(row => decodeAgentRow(row))) })),
      Effect.result);
    if (result._tag === "Failure" || result.success.code !== 0) { notes.push(`bindings ${project.slug} on ${name}: sync failed (private output withheld)`); continue; }
    written += Number(result.success.stdout.trim()) || 0;
  }
  return { written, notes };
});

/** Serializes capacity reservations across registered projects on this owner machine. */
export const withMachineLaunchLock = <A, E, R>(name: string, operation: Effect.Effect<A, E, R>, note: (text: string) => void = () => {}, timeoutMs = 300_000) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const safeName = yield* Effect.try({ try: () => decodeAgentName(name), catch: error => new InputError({ message: `invalid machine name: ${String(error)}` }) });
  const parent = join(env.home, ".config/muster/launch-locks");
  const lock = join(parent, safeName);
  // Allocate monotonically increasing tickets under a short filesystem mutex.
  // Waiting state: allocating -> queued -> held -> released; timeout never steals a lock.
  const queue = `${lock}.queue`;
  const allocator = `${lock}.allocator`;
  const counter = `${lock}.counter`;
  const io = <T>(fn: () => T) => Effect.try({ try: fn, catch: error => new InputError({ message: `machine ${name}: launch queue at ${lock}: ${String(error)}` }) });
  const attempt = (path: string) => io(() => { try { mkdirSync(path, { mode: 0o700 }); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; } });
  yield* io(() => mkdirSync(queue, { recursive: true, mode: 0o700 }));
  // Switchboard, 2026-10-20: the timeout counted total wait, so a launch two deep behind slow launches failed by design.
  // It counts time since the queue last moved: a waiter gives up only when the head has been stuck for timeoutMs.
  let moved = env.now().getTime();
  let stuck = 0;
  let waited = 0;
  let head: string | undefined;
  const progress = (first: string | undefined) => { if (first !== head) { head = first; moved = env.now().getTime(); stuck = 0; } };
  const pause = Effect.gen(function* () {
    if (Math.max(stuck, env.now().getTime() - moved) >= timeoutMs) return yield* new InputError({ message: `machine ${name}: FIFO launch lock timed out: the queue head ${head ?? "(allocator)"} has not moved for ${timeoutMs} ms at ${lock}; inspect the holder and stale tickets before retrying` });
    yield* env.sleep(100);
    stuck += 100;
    waited += 100;
  });
  const ticket = yield* Effect.acquireUseRelease(Effect.gen(function* () {
    while (!(yield* attempt(allocator))) yield* pause;
  }), () => io(() => {
    const next = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("invalid launch queue counter");
    writeFileSync(counter, String(next), { mode: 0o600 });
    const ticket = String(next).padStart(16, "0");
    writeFileSync(join(queue, ticket), String(process.pid), { flag: "wx", mode: 0o600 });
    return ticket;
  }), () => Effect.sync(() => rmdirSync(allocator)));
  // Overthruster, 2026-10-20: a launcher killed in the queue left its ticket at the head, and every desk's launch on that
  // machine timed out behind it for 14 minutes. Tickets hold a local pid; a head whose process is gone is skipped, and the
  // lock it may hold goes with it, since only the head ticket's process ever holds the lock.
  // Switchboard, 2026-10-20: two waiters could both reap one dead head, and the slower one's rmdir took the next live
  // head's lock. A waiter claims the dead head by renaming it to <ticket>.reap-<pid>: one rename wins, and the claimed
  // name still sorts first, so no live ticket becomes head (and takes the lock) until the claimant has removed the dead
  // head's lock and then its ticket. A claim whose claimant died is claimed again the same way.
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
  const missing = (fn: () => void) => { try { fn(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
  return yield* Effect.acquireUseRelease(Effect.succeed(ticket), () => Effect.acquireUseRelease(Effect.gen(function* () {
    while (true) {
      const first = yield* io(() => readdirSync(queue).sort()[0]);
      progress(first);
      if (first === ticket && (yield* attempt(lock))) return;
      if (first !== undefined && first !== ticket) {
        const [base, claimant] = first.split(".reap-") as [string, string | undefined];
        const holder = claimant !== undefined ? Number(claimant)
          : yield* io(() => { try { return Number(readFileSync(join(queue, first), "utf8").trim()); } catch { return NaN; } });
        if (Number.isSafeInteger(holder) && holder > 0 && gone(holder)) {
          const claimed = join(queue, `${base}.reap-${process.pid}`);
          const won = yield* io(() => { try { renameSync(join(queue, first), claimed); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } });
          if (won) {
            yield* io(() => { missing(() => rmdirSync(lock)); missing(() => unlinkSync(claimed)); });
            note(`machine ${name}: FIFO launch lock skipped dead ticket ${base} (${claimant !== undefined ? "its claimant, " : ""}pid ${holder} is gone)`);
          }
          continue;
        }
      }
      yield* pause;
    }
  }), () => Effect.gen(function* () {
    note(`machine ${name}: FIFO launch lock acquired${waited ? ` after waiting ${waited} ms` : " without waiting"}`);
    return yield* operation;
  }), () => Effect.sync(() => missing(() => rmdirSync(lock)))), () => Effect.sync(() => missing(() => unlinkSync(join(queue, ticket)))));
});

/**
 * A launch past its maxPanes check holds a reservation until it ends, so the machine lock covers only the count, not the
 * clone and Pi start behind it (fleet burn, 2026-10-20: 30 launches queued behind one machine's clones and timed out).
 * The file name is the row key; the file holds the launcher's local pid, and a dead pid's reservation is dropped.
 */
export const launchReservationKey = (dir: string, row: string) => createHash("sha256").update(`${dir}\0${row}`).digest("hex").slice(0, 32);
const reservationsDir = (home: string, machine: string) => join(home, ".config/muster/launch-locks", `${machine}.reservations`);
const reservationIo = <T>(machine: string, fn: () => T) => Effect.try({ try: fn, catch: error => new InputError({ message: `machine ${machine}: launch reservations: ${String(error)}` }) });

/** Live reservation keys on a machine. Call it under withMachineLaunchLock. */
export const liveLaunchReservations = (machine: string) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const root = reservationsDir(env.home, yield* Effect.try({ try: () => decodeAgentName(machine), catch: error => new InputError({ message: `invalid machine name: ${String(error)}` }) }));
  return yield* reservationIo(machine, () => {
    if (!existsSync(root)) return new Set<string>();
    const live = new Set<string>();
    for (const key of readdirSync(root)) {
      const path = join(root, key);
      const pid = (() => { try { return Number(readFileSync(path, "utf8").trim()); } catch { return NaN; } })();
      const gone = !Number.isSafeInteger(pid) || pid <= 0 || (() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } })();
      if (gone) { try { unlinkSync(path); } catch {} continue; }
      live.add(key);
    }
    return live;
  });
});

/** Writes a reservation under withMachineLaunchLock; the returned effect releases it and never fails. */
export const reserveLaunch = (machine: string, key: string) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const root = reservationsDir(env.home, yield* Effect.try({ try: () => decodeAgentName(machine), catch: error => new InputError({ message: `invalid machine name: ${String(error)}` }) }));
  const path = join(root, key);
  yield* reservationIo(machine, () => { mkdirSync(root, { recursive: true, mode: 0o700 }); writeFileSync(path, String(process.pid), { mode: 0o600 }); });
  return Effect.sync(() => { try { unlinkSync(path); } catch {} });
});

export const machinesPath = (home: string) => join(home, ".config/muster/machines.json");
export const mapPath = (path: string, machine: MachineConfig): string => {
  const prefix = Object.keys(machine.paths).sort((a, b) => b.length - a.length).find(p => path === p || path.startsWith(`${p}/`));
  return prefix ? `${machine.paths[prefix]}${path.slice(prefix.length)}` : path;
};
/**
 * The owner-side source of a row-private brief copy (`<transferDir>/files/<sha256>/<mapped path>`), or null.
 * Close removes owned copies, so a restore re-copies the brief from its source instead of reading a gone copy.
 */
export const transferredBriefSource = (brief: string, transferDir: string, machine: MachineConfig): string | null => {
  const match = brief.startsWith(`${transferDir}/files/`) ? /^[0-9a-f]{64}(\/.+)$/.exec(brief.slice(transferDir.length + "/files/".length)) : null;
  if (!match) return null;
  const mapped = match[1]!;
  const entry = Object.entries(machine.paths).sort((a, b) => b[1].length - a[1].length).find(([, remote]) => mapped === remote || mapped.startsWith(`${remote}/`));
  return entry ? `${entry[0]}${mapped.slice(entry[1].length)}` : mapped;
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

/** The local runner under an ssh-wrapped one, so wrapping again never nests ssh inside ssh. */
const localRunner = new WeakMap<ProcShape, ProcShape>();

/** SSH has one quoted shell argument; remote user data never becomes local argv. Inside `onRemote` the ambient Proc is
 * already an sshProc; a nested call (a remote restart's binding push) wraps the local runner beneath it instead. */
export function sshProc(name: string, machine: MachineConfig, outer: ProcShape, localCwd: string): ProcShape {
  const runner = localRunner.get(outer) ?? outer;
  // A Pi already on that machine (a remote owner such as a remote1 lane boss) runs in place: a host cannot ssh to itself.
  const proc: ProcShape = process.env.MUSTER_MACHINE === name ? { run: (command, args, options) => runner.run(command, args, { ...options, env: { ...machine.env, ...options.env } }) } : { run: (command, args, options) => {
    const env = { ...machine.env, ...options.env };
    const script = `cd ${shellQuote(options.cwd)} && exec env ${Object.entries(env).map(([k,v]) => `${k}=${shellQuote(v)}`).join(" ")} ${[command, ...args].map(shellQuote).join(" ")}`;
    return runner.run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "--", machine.ssh, script], { cwd: localCwd, timeoutMs: Math.min(options.timeoutMs ?? 30_000, 300_000), ...(options.input === undefined ? {} : { input: options.input }) }).pipe(
      Effect.mapError(error => new ProcError({ ...error, command: `ssh ${name}`, message: `machine ${name}: ${error.message}` })),
      Effect.flatMap(result => result.code === 255 ? Effect.fail(new ProcError({ command: `ssh ${name}`, code: result.code, stderr: result.stderr, message: `machine ${name}: SSH failed: ${result.stderr.slice(-500)}` })) : Effect.succeed(result)),
    );
  } };
  localRunner.set(proc, runner);
  return proc;
}

/** Herdr's default socket under a remote HOME. A machine config's `socket` overrides it. */
export const herdrSocketFor = (home: string): string => home ? join(home, ".config/herdr/herdr.sock") : "";

/** SSH owns the forward's lifecycle. Reuse a live control master; without one, the hashed local socket is a leftover
 * from a master that outlived ControlPersist, so StreamLocalBindUnlink replaces it. */
export const remoteClient = (name: string, machine: MachineConfig) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  if (env.remoteHerdr) return yield* env.remoteHerdr(name, machine);
  const proc = yield* Proc;
  const remoteSocket = machine.socket ?? herdrSocketFor((machine.env.HOME ?? (yield* remoteNode(name, machine, "process.stdout.write(process.env.HOME ?? '')"))).trim());
  if (!isAbsolute(remoteSocket)) return yield* new InputError({ message: `machine ${name}: remote HOME is not absolute; set socket` });
  const hash = createHash("sha256").update(JSON.stringify([machine.ssh, remoteSocket])).digest("hex").slice(0, 12);
  const root = join(env.home, ".config/muster/fwd");
  const socket = join(root, `${hash}.sock`);
  const control = join(root, `${hash}.ctl`);
  yield* Effect.try({ try: () => mkdirSync(root, { recursive: true, mode: 0o700 }), catch: error => new InputError({ message: `machine ${name}: forward directory: ${String(error)}` }) });
  const check = yield* proc.run("ssh", ["-S", control, "-O", "check", machine.ssh], { cwd: env.home, timeoutMs: 10_000 });
  if (check.code !== 0) {
    const result = yield* proc.run("ssh", ["-f", "-N", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes", "-o", "ControlMaster=yes", "-o", "ControlPersist=600", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-S", control, "-L", `${socket}:${remoteSocket}`, machine.ssh], { cwd: env.home, timeoutMs: 15_000 });
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
export const remoteNode = (name: string, machine: MachineConfig, script: string, args: readonly string[] = [], timeoutMs = 30_000) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const runner = yield* Proc;
  const result = yield* sshProc(name, machine, runner, env.home).run("node", ["--input-type=module", "-e", script, ...args], { cwd: "/", timeoutMs });
  if (result.code !== 0) return yield* new ProcError({ command: `node on ${name}`, code: result.code, stderr: result.stderr, message: `machine ${name}: ${result.stderr.slice(-1000)}` });
  return result.stdout;
});

export const prerequisites = (name: string, machine: MachineConfig, source: string, hydrate = false, launchEnv: Readonly<Record<string, string>> = {}) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const proc = yield* Proc;
  const probe = `set -e
fail() { printf '%s\\n' "$*" >&2; exit 69; }
for cmd in pi node git rift muster-heavy; do command -v "$cmd" >/dev/null || fail "install $cmd on the remote non-interactive PATH"; done
test -r "$1/extensions/pi-muster.ts" && test -d "$1/node_modules" || fail "install Muster with dependencies at $1"
test -x "$2" || fail "install executable dark-wizard worker helper at $2"
test -d "$3" || fail "provide the mapped source checkout $3"
{ test -z "$4" || command -v "$4" >/dev/null; } || fail "install launch wrapper $4"
if test "$5" = hydrate; then grep -q -- --hydrate "$2" || fail "update dark-wizard worker-worktree.sh for --hydrate"; fi
if test "\${MUSTER_FLEET_COMPUTE:-}" != off; then command -v fleet-compute >/dev/null || fail "install fleet-compute or set machine.env.MUSTER_FLEET_COMPUTE=off"; fi
pi --version`;
  const result = yield* sshProc(name, machine, proc, env.home).run("sh", ["-c", probe, "muster-prerequisites", machine.musterExtension, machine.workerWorktree, source, machine.wrap[0] ?? "", hydrate ? "hydrate" : "plain"], { cwd: "/", timeoutMs: 15_000, env: launchEnv });
  if (result.code !== 0) return yield* new InputError({ message: `machine ${name}: missing prerequisites: ${result.stderr.slice(-1000) || "remote probe failed; verify pi, node, git, rift, muster-heavy, Muster dependencies, dark-wizard and the source checkout"}` });
  const local = yield* proc.run("pi", ["--version"], { cwd: env.home, timeoutMs: 10_000 });
  const remoteVersion = result.stdout.trim();
  return [`machine ${name}: remote Pi ${remoteVersion || "unknown"}; owner Pi ${local.stdout.trim() || "unknown"}${remoteVersion !== local.stdout.trim() ? "; warning: Pi version skew" : ""}`];
});

/** Fleet-compute owns capability/auth checks. Explicit off keeps the legacy prerequisite fallback. */
/** The last bounded line of a failed probe's output, so its own verdict reaches the operator. */
const receiptTail = (text: string, label: string) => {
  const line = text.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 400);
  return line ? `; ${label}: ${line}` : "";
};
export const readyForRemoteLaunch = (name: string, machine: MachineConfig, source: string, model: string, timeoutMs = 300_000, launchEnv: Readonly<Record<string, string>> = {}) => Effect.gen(function* () {
  if (machine.env.MUSTER_FLEET_COMPUTE === "off") return [`machine ${name}: fleet capability check disabled by machine.env.MUSTER_FLEET_COMPUTE=off; prerequisite fallback only`];
  const env = yield* MusterEnv;
  const runner = yield* Proc;
  const proc = sshProc(name, machine, runner, env.home);
  const started = env.now().getTime();
  let waited = 0;
  let lastBusy = "";
  const decode = Schema.decodeUnknownSync(Schema.Struct({ machine: Schema.String, verdict: Schema.Literals(["ready", "busy", "not-ready"]), checks: Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean, detail: Schema.String })), busy: Schema.Array(Schema.String) }));
  while (true) {
    const elapsed = Math.max(waited, env.now().getTime() - started);
    if (lastBusy && elapsed >= timeoutMs) return yield* new InputError({ message: `machine ${name}: fleet capability busy after ${elapsed} ms: ${lastBusy}` });
    const result = yield* proc.run("fleet-compute", ["ready", "--machine", name, "--repo", source, "--model", model, "--json"], { cwd: "/", timeoutMs: Math.max(1, Math.min(30_000, timeoutMs - elapsed)), env: launchEnv });
    const receipt = yield* Effect.try({ try: () => decode(JSON.parse(result.stdout)), catch: error => new InputError({ message: `machine ${name}: fleet-compute ready exited ${result.code} without a receipt (${String(error)})${receiptTail(result.stderr, "stderr")}${receiptTail(result.stdout, "stdout")}` }) });
    if (receipt.machine !== name || result.code !== ({ ready: 0, busy: 75, "not-ready": 69 })[receipt.verdict]) return yield* new InputError({ message: `machine ${name}: fleet capability receipt identity or exit code disagrees` });
    if (receipt.verdict === "ready") return [`machine ${name}: fleet capability ready${waited ? ` after waiting ${Math.max(waited, env.now().getTime() - started)} ms` : ""}`];
    const reason = receipt.verdict === "busy" ? receipt.busy.join("; ") : receipt.checks.filter(check => !check.ok).map(check => `${check.name}: ${check.detail}`).join("; ");
    const spent = Math.max(waited, env.now().getTime() - started);
    if (receipt.verdict === "not-ready" || spent >= timeoutMs) return yield* new InputError({ message: `machine ${name}: fleet capability ${receipt.verdict}${spent ? ` after ${spent} ms` : ""}: ${reason}` });
    lastBusy = reason || "target reports busy";
    const delay = Math.min(1000, timeoutMs - spent);
    yield* env.sleep(delay);
    waited += delay;
  }
});

/** Copy private launch inputs without replacing an existing remote file. Close removes only unchanged owned copies. */
export const syncRemoteBrief = (name: string, machine: MachineConfig, brief: string, transferDir: string) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const runner = yield* Proc;
  const payload = yield* Effect.try({ try: () => {
    if (!lstatSync(brief).isFile()) throw new Error(`brief ${brief} must be a regular file`);
    const bytes = readFileSync(brief);
    const refs = [...bytes.toString("utf8").matchAll(/(?:`(\/[^`\r\n]+)`|"(\/[^"\r\n]+)"|'(\/[^'\r\n]+)'|(\/[A-Za-z0-9_.@/+~-]+))/g)].map(match => (match[1] ?? match[2] ?? match[3] ?? match[4]!).replace(/[.,;:]+$/, ""));
    const referenced = refs.filter(path => Object.keys(machine.paths).some(root => path === root || path.startsWith(`${root}/`))).filter(path => {
      // Overthruster, 2026-10-20: a brief names the report its worker will write; it can't exist yet. Report paths are
      // outputs, not inputs. Any other missing mapped input still refuses before allocation.
      if (!existsSync(path) && /\/reports\//.test(path)) return false;
      if (!existsSync(path)) throw new Error(`referenced input ${path} does not exist; create it, or name a report under a reports/ directory`);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`referenced input ${path} is a symlink; name its regular-file source`);
      return stat.isFile();
    });
    const files = [...new Set([brief, ...referenced])];
    return files.map(path => {
      const target = mapPath(path, machine);
      const content = readFileSync(path), hash = createHash("sha256").update(content).digest("hex");
      // Row-private, content-addressed copies avoid shared-close races and never overwrite an earlier brief.
      return { path: join(transferDir, "files", hash, target.slice(1)), source: path, mapped: target, content: content.toString("base64"), hash };
    });
  }, catch: error => new InputError({ message: `machine ${name}: brief sync: ${String(error)}` }) });
  const script = `const fs=require('node:fs'),p=require('node:path'),crypto=require('node:crypto');
const dir=process.argv[1], files=JSON.parse(fs.readFileSync(0,'utf8')); fs.mkdirSync(dir,{recursive:true,mode:0o700});
if(fs.lstatSync(dir).isSymbolicLink())throw Error('private transfer directory is a symlink');
const manifest=p.join(dir,'transfers.json');
if(fs.existsSync(manifest) && !fs.lstatSync(manifest).isFile())throw Error('private transfer manifest is not a regular file');
const owned=fs.existsSync(manifest)?JSON.parse(fs.readFileSync(manifest,'utf8')):[];
if(!Array.isArray(owned) || owned.some(f=>typeof f.path!=='string'||!f.path.startsWith(dir+'/files/')||typeof f.hash!=='string'||!/^[a-f0-9]{64}$/.test(f.hash)))throw Error('invalid private transfer manifest');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
for(const file of files){
  const bytes=Buffer.from(file.content,'base64'); if(hash(bytes)!==file.hash) throw Error('input hash differs');
  fs.mkdirSync(p.dirname(file.path),{recursive:true,mode:0o700});
  for(let current=p.dirname(file.path);current.startsWith(dir);current=p.dirname(current)){if(fs.lstatSync(current).isSymbolicLink())throw Error('private transfer parent is a symlink');if(current===dir)break;}
  try { fs.writeFileSync(file.path,bytes,{flag:'wx',mode:0o600}); owned.push({path:file.path,hash:file.hash}); fs.writeFileSync(manifest,JSON.stringify(owned),{mode:0o600}); }
  catch(e){if(e.code!=='EEXIST')throw e;}
  if(!fs.lstatSync(file.path).isFile() || hash(fs.readFileSync(file.path))!==file.hash) throw Error('existing remote input differs: '+file.path);
  if((fs.statSync(file.path).mode&0o777)!==0o600) throw Error('private remote input needs mode 0600: '+file.path);
}
process.stdout.write(String(files.length));`;
  const result = yield* sshProc(name, machine, runner, env.home).run("node", ["-e", script, transferDir], { cwd: "/", timeoutMs: 30_000, input: JSON.stringify(payload) });
  if (result.code !== 0) return yield* new InputError({ message: `machine ${name}: brief sync refused: ${result.stderr.slice(-1000)}` });
  return { brief: payload[0]!.path, note: `machine ${name}: brief and ${payload.length - 1} mapped referenced file(s) copied into row-private storage with mode 0600 and verified sha256; owned copies removed on close. Resolve absolute paths named in the brief with this input map: ${JSON.stringify(payload.map(file => ({ source: file.source, mapped: file.mapped, copy: file.path })))}` };
});

export const cleanupRemoteBrief = (name: string, machine: MachineConfig, transferDir: string) => Effect.gen(function* () {
  const output = yield* remoteNode(name, machine, `import fs from 'node:fs'; import {join} from 'node:path'; import {createHash} from 'node:crypto';
const dir=process.argv[1],manifest=join(dir,'transfers.json'); const notes=[], kept=[];
if(fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())throw Error('private transfer directory is a symlink');
if(fs.existsSync(manifest) && !fs.lstatSync(manifest).isFile())throw Error('private transfer manifest is not a regular file');
if(fs.existsSync(manifest)) { const files=JSON.parse(fs.readFileSync(manifest,'utf8')); for(const file of files){
 if(typeof file.path!=='string' || !file.path.startsWith(process.argv[1]+'/files/') || file.path.split('/').includes('..')){notes.push('invalid private input manifest; kept');kept.push(file);continue;}
 if(!fs.existsSync(file.path))continue;
 const real=fs.realpathSync(file.path), root=fs.realpathSync(dir);
 if(!real.startsWith(root+'/files/')){kept.push(file);notes.push('private input kept (symlink parent): '+file.path);continue;}
 if(!fs.lstatSync(file.path).isFile() || createHash('sha256').update(fs.readFileSync(file.path)).digest('hex')!==file.hash){kept.push(file);notes.push('private input kept (changed): '+file.path);continue;}
 fs.unlinkSync(file.path); notes.push('private input removed: '+file.path);
} if(kept.length)fs.writeFileSync(manifest,JSON.stringify(kept),{mode:0o600});else fs.unlinkSync(manifest); }
process.stdout.write(JSON.stringify(notes));`, [transferDir]);
  return yield* Effect.try({ try: () => Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(output)), catch: error => new InputError({ message: `machine ${name}: brief cleanup receipt invalid: ${String(error)}` }) });
});

export const cloneUrl = (machine: MachineConfig, path: string) => `ssh://${machine.ssh}/${path.replace(/^\//, "")}`;
