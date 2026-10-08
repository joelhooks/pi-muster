import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
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
/** Use the worktree's own git directory, never the shared common directory. */
function resolveSidecarRoots(cwd: string, exec: typeof execFileSync, pathJoin: typeof join, pathResolve: typeof resolve): string[] {
  const gitDir = exec("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8", timeout: 2000 }).trim();
  return [pathJoin(pathResolve(cwd, gitDir), "muster"), pathJoin(cwd, ".pi/muster")];
}
export const sidecarRoots = (cwd: string) => resolveSidecarRoots(cwd, execFileSync, join, resolve);
/** Same resolver for bounded remote Node probes. */
export const sidecarRootsScript = `import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const sidecarRoots = cwd => (${resolveSidecarRoots.toString()})(cwd,execFileSync,join,resolve);`;

export const remotePullReceipt = (comms?: string): string[] => comms === "network" ? [] : ["remote notes reach the owner only when it runs owner_inbox or project_status; for push, set policy comms network only after the owner and its desk run pi-muster 6ec5d32 or later (older owners publish no consumer fence, so launch brief sends fail with LeaseMismatch)"];

/** Remote workers retain the exact queue record; publish last so interrupted writes stay invisible. */
export function writeRemoteOwnerItem(owner: string, item: OwnerItem, session: string) {
  const row = decodeAgentRow(JSON.parse(process.env.MUSTER_REMOTE_ROW ?? "null"));
  if (row.machine !== process.env.MUSTER_MACHINE || row.sessionId !== session || item.author !== session || item.lane !== row.lane) throw new Error("remote note identity differs from the launch row");
  const sidecar = decodeRemoteNote({ project: process.env.MUSTER_PROJECT_SLUG, machine: row.machine, agent: row.name, lane: row.lane, owner, item });
  const root = join(sidecarRoots(row.cwd)[0]!, "notes");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${createHash("sha256").update(item.cid).digest("hex")}.json`);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(sidecar), { mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

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
  const started = env.now().getTime();
  let waited = 0;
  const pause = Effect.gen(function* () {
    if (Math.max(waited, env.now().getTime() - started) >= timeoutMs) return yield* new InputError({ message: `machine ${name}: FIFO launch lock timed out after ${timeoutMs} ms at ${lock}; inspect the holder and stale tickets before retrying` });
    yield* env.sleep(100);
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
  return yield* Effect.acquireUseRelease(Effect.succeed(ticket), () => Effect.acquireUseRelease(Effect.gen(function* () {
    while (true) {
      const first = yield* io(() => readdirSync(queue).sort()[0]);
      if (first === ticket && (yield* attempt(lock))) return;
      yield* pause;
    }
  }), () => Effect.gen(function* () {
    note(`machine ${name}: FIFO launch lock acquired${waited ? ` after waiting ${waited} ms` : " without waiting"}`);
    return yield* operation;
  }), () => Effect.sync(() => rmdirSync(lock))), () => Effect.sync(() => unlinkSync(join(queue, ticket))));
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
    return runner.run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "--", machine.ssh, script], { cwd: localCwd, timeoutMs: Math.min(options.timeoutMs ?? 30_000, 300_000), ...(options.input === undefined ? {} : { input: options.input }) }).pipe(
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
    const receipt = yield* Effect.try({ try: () => decode(JSON.parse(result.stdout)), catch: error => new InputError({ message: `machine ${name}: invalid fleet capability receipt (${result.code}): ${String(error)}` }) });
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
      const stat = lstatSync(path); // Missing mapped inputs refuse before allocation, rather than disappearing from the brief.
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
