import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer, Option, Schema, Semaphore, Stream } from "effect";
import { createActor } from "xstate";
import { networkLeaseMachine } from "./machines.ts";
import { FetchHttpClient } from "effect/http";
import { decodeProject, decodeOwnerSession, decodeNetworkSendFence, decodeNetworkFenceLock, decodeNetworkIdentityName, decodeCommsIdentityCache, decodeNetworkIdentityCache, decodeNetworkDeskIdentityCache, decodeNetworkDeskCursors, decodeNetworkDeskPeers, decodeNetworkPeers, decodeNetworkPeerReferences, decodeCommsIdentityReference, decodeNetworkCommsConfig, decodeNetworkPayload, decodeNetworkCursors, type AgentRow, type CommsIdentityReference, type Project } from "./domain.ts";
import { reportedNetworkSend } from "./comms-fallback.ts";
import { CommsError, Herdr, MusterEnv, Proc, Unsupported, type CommsDelivery, type CommsShape, type CommsTarget } from "./runtime.ts";
import type { Batch, LeaseFence } from "./vendor/rat-king-mailbox-client/index.ts";

/** Wait without touching the mailbox or acquiring the old DID's lease.
 * Cancellation is harmless; missing and foreign markers fail closed.
 */
export const awaitRestartActivation = (session: string, gate = process.env.MUSTER_RESTART_GATE) => Effect.gen(function* () {
  if (!gate) return;
  while (true) {
    const ready = yield* Effect.try({
      try: () => {
        try { return decodeOwnerSession(privateJson(gate)) === session; }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
      }, catch: () => new CommsError("NetworkComms restart activation invalid; consumer has not acquired a lease"),
    });
    if (ready) return;
    yield* Effect.sleep(100);
  }
});

/** One private, atomic snapshot per DID. Detached senders borrow it, never acquire. */
export const networkFencePath = (home: string, did: string) => join(home, ".local/state/muster/network-fences", `${createHash("sha256").update(did).digest("hex")}.json`);

export function readConsumerFence(home: string, did: string): LeaseFence | undefined {
  try {
    const fence = decodeNetworkSendFence(privateJson(networkFencePath(home, did)));
    if (fence.did !== did) throw new Error("fence belongs to another DID");
    return fence;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new CommsError("NetworkComms invalid consumer fence (private output withheld)");
  }
}

/** Cache-file lock shared by identity, peer and seed writers: records its holder, recovers a
 * dead holder or an empty legacy lock older than 30 s, waits boundedly for a live one, and only
 * ever removes its own token. A crash mid-provision must never block an identity for good. */
export function acquireCacheLock(path: string, busy: string, waitMs = 10_000): { path: string; token: string } {
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); return { path, token }; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new CommsError(`${busy} (unsafe lock file)`);
    let stale = false;
    try {
      const holder = decodeNetworkFenceLock(privateJson(path));
      try { process.kill(holder.pid, 0); } catch (error) { stale = error instanceof Error && "code" in error && error.code === "ESRCH"; }
    } catch { stale = Date.now() - stat.mtimeMs > 30_000; } // Legacy empty lock: recovered by age only.
    if (stale) {
      try { const current = lstatSync(path); if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) unlinkSync(path); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      continue;
    }
    if (Date.now() >= deadline) throw new CommsError(busy);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

export function releaseCacheLock(lock: { path: string; token: string }) {
  try { if (decodeNetworkFenceLock(privateJson(lock.path)).token === lock.token) unlinkSync(lock.path); } catch { /* gone or superseded */ }
}

/** acquire → inspect stale holder → bounded wait → held → release.
 * No live holder can release a successor's token. Legacy empty locks expire in 30s.
 */
const acquireFenceLock = (path: string) => Effect.gen(function* () {
  const token = randomUUID();
  for (let attempt = 0; attempt < 40; attempt++) {
    const acquired = yield* Effect.try({ try: () => {
      try { writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); return true; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      let stat;
      try { stat = lstatSync(path); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error("unsafe lock");
      let dead = false;
      try {
        const holder = decodeNetworkFenceLock(privateJson(path));
        try { process.kill(holder.pid, 0); } catch (error) { dead = error instanceof Error && "code" in error && error.code === "ESRCH"; }
      } catch { /* Legacy empty locks are recovered only by age. */ }
      if (dead || Date.now() - stat.mtimeMs > 30_000) {
        const current = lstatSync(path);
        if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) unlinkSync(path);
      }
      return false;
    }, catch: () => new CommsError("NetworkComms consumer fence lock invalid") });
    if (acquired) return { path, token };
    yield* Effect.sleep("25 millis");
  }
  return yield* Effect.fail(new CommsError("NetworkComms consumer fence lock busy; bounded wait expired"));
});
const ownsFenceLock = (lock: { path: string; token: string }) => {
  try { return decodeNetworkFenceLock(privateJson(lock.path)).token === lock.token; } catch { return false; }
};
const releaseFenceLock = (lock: { path: string; token: string }) => Effect.sync(() => { if (ownsFenceLock(lock)) unlinkSync(lock.path); });

const publishConsumerFence = (home: string, fence: LeaseFence) => Effect.gen(function* () {
  const path = networkFencePath(home, fence.did);
  yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }), catch: () => new CommsError("NetworkComms could not create fence directory") });
  return yield* Effect.acquireUseRelease(acquireFenceLock(`${path}.lock`), lock => Effect.tryPromise({
  try: async () => {
    const path = networkFencePath(home, fence.did);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ did: fence.did, leaseId: fence.leaseId, generation: fence.generation }), { flag: "wx", mode: 0o600 });
      if (!ownsFenceLock(lock)) throw new Error("fence lock superseded");
      await rename(temp, path);
    } finally { await unlink(temp).catch(() => {}); }
  }, catch: () => new CommsError("NetworkComms could not publish consumer fence"),
  }), releaseFenceLock);
});

/** Only a protocol lease mismatch permits one fresh read and one retry. */
export function sendWithConsumerFence(options: {
  home: string; did: string;
  send: (opts?: import("./vendor/rat-king-mailbox-client/index.ts").SendOptions) => ReturnType<Effect.Success<ReturnType<typeof openNetworkMailbox>>["send"]>;
}) {
  return Effect.gen(function* () {
    const { MailboxClientError } = yield* Effect.promise(() => import("./vendor/rat-king-mailbox-client/error.ts"));
    let unpublished = false;
    let previous: LeaseFence | undefined;
    const read = () => Effect.try({ try: () => readConsumerFence(options.home, options.did), catch: () => new CommsError("NetworkComms invalid consumer fence (private output withheld)") });
    const awaitPublish = () => Effect.gen(function* () {
      for (let attempt = 0; attempt < 40; attempt++) {
        const fresh = yield* read();
        if (fresh && (!previous || fresh.leaseId !== previous.leaseId || fresh.generation !== previous.generation)) return;
        yield* Effect.sleep("25 millis");
      }
    });
    const attempt = () => Effect.try({ try: () => readConsumerFence(options.home, options.did), catch: () => new CommsError("NetworkComms invalid consumer fence (private output withheld)") }).pipe(
      Effect.flatMap(fence => { previous = fence; unpublished = fence === undefined; return options.send(fence ? { fence } : undefined); }),
    );
    return yield* attempt().pipe(
      Effect.catch(error => error instanceof MailboxClientError && error.error === "LeaseMismatch" ? awaitPublish().pipe(Effect.flatMap(attempt)) : Effect.fail(error)),
      Effect.catch(error => error instanceof MailboxClientError && error.error === "LeaseMismatch" && unpublished
        ? Effect.fail(new CommsError("NetworkComms send failed: LeaseMismatch; sender lease held elsewhere (another process with this identity); boss consumer has no published fence; restart the boss onto current code"))
        : Effect.fail(error)),
    );
  });
}

export const networkConfigPath = (home: string) => join(home, ".config/muster/network.json");
export const networkIdentityPath = (home: string) => join(home, ".local/state/muster/network-identities.json");
export const networkDeskIdentityPath = (home: string) => join(home, ".local/state/muster/network-desk-identities.json");
export const networkPeersPath = (home: string) => join(home, ".local/state/muster/network-peers.json");
export const networkDeskPeersPath = (home: string) => join(home, ".local/state/muster/network-desk-peers.json");
export const networkProvisionLockPath = (home: string) => join(home, ".local/state/muster/network-provision.lock");
const identityPath = (home: string, agent: string) => agent.includes("/") ? networkDeskIdentityPath(home) : networkIdentityPath(home);
export const networkCursorPath = (home: string, agent: string) => join(home, ".local/state/muster", agent.includes("/") ? "network-desk-cursors" : "network-cursors", `${networkProvisionName(agent)}.json`);

/** Wrapper names stay valid and collision-free; Switchboard retains its fleet DID. */
export function networkProvisionName(identity: string): string {
  const name = decodeNetworkIdentityName(identity);
  if (!name.includes("/")) return name;
  if (name === "switchboard/switchboard" || name === "switchboard/desk") return "switchboard";
  return `desk-${createHash("sha256").update(name).digest("hex").slice(0, 26)}`;
}

function privateJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new CommsError(`NetworkComms requires an owned 0600 regular file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}
/** A Pi that cached older sibling modules can lazy-load this file from a newer checkout; a missing
 * import then reads as undefined. Fail typed instead of crashing the process with a TypeError. */
export const NETWORK_SKEW = "NetworkComms unavailable: this Pi loaded an older pi-muster than the one on disk; restart it onto current code";
export const networkModuleSkew = (imports: readonly unknown[] = [networkLeaseMachine, decodeOwnerSession, decodeNetworkSendFence, decodeNetworkFenceLock, decodeNetworkIdentityName, decodeCommsIdentityCache, decodeNetworkIdentityCache, decodeNetworkDeskIdentityCache, decodeNetworkDeskCursors, decodeNetworkDeskPeers, decodeNetworkPeers, decodeNetworkPeerReferences, decodeCommsIdentityReference, decodeNetworkCommsConfig, decodeNetworkPayload, decodeNetworkCursors, CommsError, MusterEnv, Proc, Unsupported]) =>
  imports.some(value => value === undefined);

export function readNetworkConfig(home: string, path = networkConfigPath(home)) {
  // Old callers wrap this in Effect.try, so throwing here keeps network comms from starting at all.
  if (networkModuleSkew()) throw CommsError ? new CommsError(NETWORK_SKEW) : new Error(NETWORK_SKEW);
  try {
    const config = decodeNetworkCommsConfig(privateJson(path));
    const url = new URL(config.endpoint);
    if (url.username || url.password || url.hash || url.search || config.didTemplate.split("{agent}").length !== 2) throw new Error("invalid configuration");
    return config;
  }
  catch (error) { if (error instanceof CommsError) throw error; throw new CommsError(`NetworkComms missing or invalid config: ${path}`); }
}
function readIdentityCache(path: string, desk: boolean) {
  try {
    const raw = privateJson(path);
    const cache = (desk ? decodeNetworkDeskIdentityCache : decodeCommsIdentityCache)(raw);
    if (raw === null || typeof raw !== "object" || Object.keys(raw).length !== Object.keys(cache).length) throw new Error("identity namespace mismatch");
    if (Object.values(cache).some(entry => entry.did !== entry.document.id)) throw new Error("document mismatch");
    return cache;
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    if (error instanceof CommsError) throw error;
    throw new CommsError(`NetworkComms invalid identity cache: ${path}`);
  }
}

/** Bare references remain in the old file; only new code opens desk sidecars. */
export function readNetworkIdentities(home: string) {
  return { ...readIdentityCache(networkIdentityPath(home), false), ...readIdentityCache(networkDeskIdentityPath(home), true) };
}

function readPeerCache(path: string, desk: boolean) {
  try { return (desk ? decodeNetworkDeskPeers : decodeNetworkPeers)(privateJson(path)); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new CommsError("NetworkComms invalid peer cache");
  }
}
export function readNetworkPeers(home: string) {
  return { ...readPeerCache(networkPeersPath(home), false), ...readPeerCache(networkDeskPeersPath(home), true) };
}

/** Partition before writing: old readers never see qualified values or keys. */
export function seedNetworkPeers(home: string, value: unknown) {
  const peers = decodeNetworkPeerReferences(value);
  for (const desk of [false, true]) {
    const entries = Object.fromEntries(Object.entries(peers).filter(([, agent]) => agent.includes("/") === desk));
    if (!Object.keys(entries).length) continue;
    const path = desk ? networkDeskPeersPath(home) : networkPeersPath(home);
    const current = readPeerCache(path, desk);
    if (Object.entries(entries).every(([session, agent]) => current[session] === agent)) continue;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = acquireCacheLock(`${path}.lock`, "NetworkComms peer cache busy; retry");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const merged = { ...readPeerCache(path, desk), ...entries };
      writeFileSync(temp, JSON.stringify((desk ? decodeNetworkDeskPeers : decodeNetworkPeers)(merged)), { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
    } finally { try { unlinkSync(temp); } catch { /* renamed */ } releaseCacheLock(lock); }
  }
}

/** Captured stdout is private. Neither child stderr nor parse errors cross this boundary. */
export type PrivateCommand = (file: string, args: readonly string[]) => Promise<string>;
export const privateCommand: PrivateCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout) => {
    if (error) reject(new CommsError("NetworkComms private command failed (output withheld)"));
    else resolve(stdout);
  });
});

/** Idempotent provisioning is serialized across processes; cache stores entry names, never keys. */
export function provisionNetworkAgent(options: { home: string; agent: string; configPath?: string; run?: PrivateCommand; lockWaitMs?: number }): Effect.Effect<CommsIdentityReference, CommsError> {
  return Effect.tryPromise({
    try: async () => {
      const agent = decodeNetworkIdentityName(options.agent);
      const provisionName = networkProvisionName(agent);
      const config = readNetworkConfig(options.home, options.configPath);
      const path = identityPath(options.home, agent);
      const did = Object.hasOwn(config.didOverrides ?? {}, provisionName) ? config.didOverrides![provisionName]! : config.didTemplate.replace("{agent}", provisionName);
      const cached = readNetworkIdentities(options.home)[agent];
      if (cached) {
        if (cached.did !== did) throw new CommsError(`NetworkComms cached identity differs from config: ${agent}`);
        return cached;
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const lock = acquireCacheLock(`${path}.lock`, `NetworkComms identity cache busy: ${agent}; retry provisioning`, options.lockWaitMs);
      try {
        const identities = readIdentityCache(path, agent.includes("/"));
        if (identities[agent]) {
          if (identities[agent].did !== did) throw new CommsError(`NetworkComms cached identity differs from config: ${agent}`);
          return identities[agent];
        }
        let reference: CommsIdentityReference;
        // Worker and desk caches lock separately; the wrapper's documents.json has one writer across both.
        const minting = acquireCacheLock(networkProvisionLockPath(options.home), `NetworkComms provisioning busy: ${agent}; retry`, options.lockWaitMs ?? 60_000);
        try {
          reference = decodeCommsIdentityReference(JSON.parse(await (options.run ?? privateCommand)(config.provisionWrapper, ["provision", "--agent", provisionName, "--did", did])));
        } catch { throw new CommsError(`NetworkComms provisioning failed: ${agent} (output withheld)`); }
        finally { releaseCacheLock(minting); }
        if (reference.did !== did || reference.document.id !== did) throw new CommsError(`NetworkComms provision identity mismatch: ${agent}`);
        const temp = `${path}.${process.pid}.tmp`;
        try {
          writeFileSync(temp, JSON.stringify({ ...identities, [agent]: reference }), { flag: "wx", mode: 0o600 });
          renameSync(temp, path);
        } finally { try { unlinkSync(temp); } catch { /* already renamed */ } }
        return reference;
      } finally { releaseCacheLock(lock); }
    },
    catch: error => error instanceof CommsError ? error : new CommsError(`NetworkComms provisioning failed: ${options.agent} (output withheld)`),
  });
}

/** Finds the remote secrets CLI, then copies (stdin) or deletes one named entry. Output is a status word only. */
const REMOTE_KEY_SCRIPT = 'S="$HOME/.local/bin/secrets"; [ -x "$S" ] || S="$(command -v secrets)" || exit 127; if "$S" --no-update-check list 2>/dev/null | grep -Fq "\\"name\\": \\"$2\\""; then present=1; else present=0; fi; case "$1" in copy) if [ $present = 1 ]; then "$S" --no-update-check update "$2" >/dev/null 2>&1 || exit 1; echo updated; else "$S" --no-update-check add "$2" >/dev/null 2>&1 || exit 1; echo added; fi ;; delete) if [ $present = 1 ]; then "$S" --no-update-check delete "$2" --force >/dev/null 2>&1 || exit 1; echo deleted; else echo absent; fi ;; *) exit 2 ;; esac';

/**
 * Fleet custody (Rat King, 2026-10-07): the operator key never leaves this machine. Provision here, copy only this
 * agent's identity entry to the remote secrets store over ssh stdin, and seed public references for its peers only.
 */
export function prepareRemoteNetworkAgent(options: { home: string; agent: string; machineName: string; machine: import("./domain.ts").MachineConfig; peers?: readonly string[]; sessions?: Readonly<Record<string, string>>; run?: PrivateCommand;
  /** The row's session there: its reader rechecks its join at once instead of on its next tick. */
  kick?: string }) {
  return Effect.gen(function* () {
    const configPath = options.machine.comms?.config;
    if (!configPath) return yield* Effect.fail(new CommsError(`machine ${options.machineName}: network project requires a comms config block; launch refused`));
    const { remoteNode, sshProc } = yield* Effect.promise(() => import("./remote.ts"));
    const env = yield* MusterEnv;
    const runner = yield* Proc;
    const reference = yield* provisionNetworkAgent({ home: options.home, agent: options.agent, ...(options.run ? { run: options.run } : {}) });
    const config = yield* Effect.try({ try: () => readNetworkConfig(options.home), catch: error => error instanceof CommsError ? error : new CommsError("NetworkComms config invalid") });
    const key = yield* Effect.tryPromise({
      try: () => (options.run ?? privateCommand)(config.secretsCommand ?? join(options.home, ".local/bin/secrets"), ["lease", reference.secret, "--ttl", "5m", "--client-id", "muster-remote-custody", "--no-update-check"]),
      catch: () => new CommsError(`NetworkComms identity lease failed: ${options.agent}; launch refused (output withheld)`),
    });
    const copied = yield* sshProc(options.machineName, options.machine, runner, env.home).run("sh", ["-c", REMOTE_KEY_SCRIPT, "muster-key", "copy", reference.secret], { cwd: "/", timeoutMs: 30_000, input: key }).pipe(
      Effect.mapError(() => new CommsError(`machine ${options.machineName}: identity copy failed for ${options.agent}; launch refused`)));
    if (copied.code !== 0 || !/^(added|updated)$/mu.test(copied.stdout.trim())) return yield* Effect.fail(new CommsError(`machine ${options.machineName}: identity copy failed for ${options.agent}; launch refused`));
    const known = yield* Effect.try({ try: () => readNetworkIdentities(options.home), catch: () => new CommsError("NetworkComms peer references unavailable") });
    const wanted = new Set([options.agent, ...(options.peers ?? [])]);
    const peers = Object.fromEntries(Object.entries(known).filter(([name]) => wanted.has(name)));
    const helper = join(options.machine.musterExtension, "src/comms-network.ts");
    // A row launched before the flip has no peer env: its reader learns sessions from this cache, or refuses its owner's mail.
    const sessions = Object.fromEntries(Object.entries(options.sessions ?? {}).filter(([, agent]) => wanted.has(agent)));
    const kick = options.kick === undefined ? "" : decodeOwnerSession(options.kick);
    // The kick path is spelled out, not imported: an older pi-muster there must still seed.
    yield* remoteNode(options.machineName, options.machine,
      `import {homedir} from 'node:os'; import {mkdirSync, writeFileSync} from 'node:fs'; import {join} from 'node:path'; import {seedNetworkIdentities, seedNetworkPeers} from ${JSON.stringify(helper)}; const home=process.env.HOME??homedir(); seedNetworkIdentities(home,JSON.parse(process.argv[1])); const sessions=JSON.parse(process.argv[2]); if (Object.keys(sessions).length) seedNetworkPeers(home,sessions); if (process.argv[3]) { const dir=join(home,'.local/state/muster/owner-queue'); mkdirSync(dir,{recursive:true,mode:0o700}); writeFileSync(join(dir,process.argv[3]+'.comms-kick'),new Date().toISOString(),{mode:0o600}); }`, [JSON.stringify(peers), JSON.stringify(sessions), kick]).pipe(Effect.mapError(() => new CommsError(`machine ${options.machineName}: public peer cache probe failed; launch refused`)));
    return `${options.machineName} holds ${reference.secret} (${copied.stdout.trim()})`;
  });
}

/** Close deletes the remote copy only; this machine's entry is the custody record. Never fails a close. */
export function retireRemoteNetworkKey(options: { home: string; agent: string; machineName: string; machine: import("./domain.ts").MachineConfig }) {
  return Effect.gen(function* () {
    const reference = (() => { try { return readNetworkIdentities(options.home)[options.agent]; } catch { return undefined; } })();
    if (!reference) return `no network identity for ${options.agent}; nothing to delete on ${options.machineName}`;
    const { sshProc } = yield* Effect.promise(() => import("./remote.ts"));
    const env = yield* MusterEnv;
    const runner = yield* Proc;
    const result = yield* sshProc(options.machineName, options.machine, runner, env.home).run("sh", ["-c", REMOTE_KEY_SCRIPT, "muster-key", "delete", reference.secret], { cwd: "/", timeoutMs: 30_000 }).pipe(Effect.option);
    const status = result._tag === "Some" && result.value.code === 0 ? result.value.stdout.trim() : "";
    if (status === "deleted") return `deleted ${reference.secret} from ${options.machineName} secrets`;
    if (status === "absent") return `${reference.secret} was not in ${options.machineName} secrets`;
    return `KEY NOT DELETED: ${reference.secret} on ${options.machineName}; delete it by hand`;
  });
}

/** A live catalog row a network send addresses. Built by desk-route's `networkTargetRow`. */
export interface NetworkTarget { readonly project: Project; readonly row: AgentRow; readonly identity: string; readonly peers: readonly string[] }

/** Whether the local secrets store lists one entry. Only names are read; a failed listing counts as absent. */
export const localSecretPresent = (home: string, secret: string, secretsCommand?: string, run: PrivateCommand = privateCommand) =>
  run(secretsCommand ?? join(home, ".local/bin/secrets"), ["--no-update-check", "list"])
    .then(listed => listed.split(/"name":\s*/u).slice(1).some(part => part.startsWith(JSON.stringify(secret))), () => false);

/** What this machine knows about one identity joining the mailbox. Keys and fences stay private: only booleans leave. */
export interface JoinFacts {
  readonly agent: string;
  readonly config: string | null;
  readonly identity: boolean;
  readonly did: string | null;
  /** Remote only: the key sits in this machine's secrets, and Flagg bound this session to the agent. */
  readonly key: boolean | null;
  readonly session: boolean | null;
  readonly fence: "published" | "absent" | "invalid";
  readonly joined: boolean;
  readonly reason: string | null;
}

/** A process is joined when its own identity is usable here. On Flagg that is the cached identity and a readable
 * config. A remote machine also needs the key Flagg pushed and the session binding Flagg seeded with it. */
export async function localJoinFacts(options: { home: string; agent: string; session?: string; configPath?: string; remote: boolean; run?: PrivateCommand }): Promise<JoinFacts> {
  let config: ReturnType<typeof readNetworkConfig> | undefined;
  let configError: string | null = null;
  try { config = readNetworkConfig(options.home, options.configPath); }
  catch (error) { configError = error instanceof Error ? error.message : "NetworkComms config invalid"; }
  let reference: CommsIdentityReference | undefined;
  let identityError: string | undefined;
  try { reference = readNetworkIdentities(options.home)[options.agent]; }
  catch (error) { identityError = error instanceof Error ? error.message : "NetworkComms identity cache invalid"; }
  let fence: JoinFacts["fence"] = "absent";
  if (reference) { try { fence = readConsumerFence(options.home, reference.did) ? "published" : "absent"; } catch { fence = "invalid"; } }
  let key: boolean | null = null;
  let session: boolean | null = null;
  if (options.remote) {
    try { session = options.session !== undefined && readNetworkPeers(options.home)[options.session] === options.agent; } catch { session = false; }
    if (reference && config) key = await localSecretPresent(options.home, reference.secret, config.secretsCommand, options.run);
  }
  const reason = configError ?? identityError ?? (!reference ? `no identity for ${options.agent} on this machine`
    : key === false ? `key ${reference.secret} is not in this machine's secrets`
    : session === false ? `session ${options.session ?? "unknown"} is not bound to ${options.agent} here; the owner pushes the binding with the key`
    : null);
  return { agent: options.agent, config: configError, identity: reference !== undefined, did: reference?.did ?? null, key, session, fence, joined: reason === null, reason };
}

/** The row's reader state, read from its fence file on the row's machine. Unknown when that machine cannot be read. */
export const rowReaderFence = (home: string, target: Pick<NetworkTarget, "row" | "identity">) => Effect.gen(function* () {
  const did = (() => { try { return readNetworkIdentities(home)[target.identity]?.did; } catch { return undefined; } })();
  if (!did) return "absent" as const;
  if (target.row.machine === "local") return yield* Effect.sync(() => { try { return readConsumerFence(home, did) ? "published" as const : "absent" as const; } catch { return "unknown" as const; } });
  const { run, remote, machine } = yield* remoteMachine(target.row.machine);
  const helper = join(machine.musterExtension, "src/comms-network.ts");
  const stdout = yield* run(remote.remoteNode(target.row.machine, machine,
    `import {homedir} from 'node:os'; import {readConsumerFence} from ${JSON.stringify(helper)}; console.log(readConsumerFence(process.env.HOME??homedir(),process.argv[1])?'published':'absent');`, [did], 15_000));
  const state = stdout.trim().split("\n").at(-1);
  return state === "published" || state === "absent" ? state : "unknown" as const;
}).pipe(Effect.catch(() => Effect.succeed("unknown" as const)));

/** A row with no identity, or launched with the intercom hint, has no reader until it joins.
 * Herdr carries its sends only until the row's reader publishes its fence. */
export const preflipRow = (home: string, target: Pick<NetworkTarget, "row" | "identity">) => Effect.gen(function* () {
  const minted = (() => { try { return readNetworkIdentities(home)[target.identity] !== undefined; } catch { return false; } })();
  if (!minted) return true;
  if (target.row.restore?.env.MUSTER_COMMS !== "intercom") return false;
  return (yield* rowReaderFence(home, target)) !== "published";
});
export const preflipNotice = (row: string, outcome: string) => `${row} has no mailbox reader yet (launched before comms: network); ${outcome}; on current pi-muster it joins its mailbox within about a minute, otherwise restart the row`;

const musterRuntime = Effect.gen(function* () {
  const env = yield* Effect.serviceOption(MusterEnv);
  const proc = yield* Effect.serviceOption(Proc);
  if (Option.isNone(env) || Option.isNone(proc)) return yield* Effect.fail(new CommsError("Muster runtime unavailable for a remote row"));
  return <A, E>(effect: Effect.Effect<A, E, MusterEnv | Proc>) => effect.pipe(Effect.provideService(MusterEnv, env.value), Effect.provideService(Proc, proc.value));
});
const remoteMachine = (name: string) => Effect.gen(function* () {
  const run = yield* musterRuntime;
  const remote = yield* Effect.promise(() => import("./remote.ts"));
  return { run, remote, machine: yield* run(remote.machineConfig(name)).pipe(Effect.mapError(error => new CommsError(error.message))) };
});

/** The cache lock waits synchronously; a second fiber in this process would freeze the loop the first one awaits on. */
const preflipProvisioning = Semaphore.makeUnsafe(1);
/** Launch's custody, on demand: a local mint, or a remote mint plus key copy. It finishes before any send. */
export const provisionPreflipRow = (options: { home: string; target: NetworkTarget; run?: PrivateCommand }) => preflipProvisioning.withPermit(Effect.gen(function* () {
  const { project, row, identity, peers } = options.target;
  if (row.machine === "local") {
    yield* provisionNetworkAgent({ home: options.home, agent: identity, ...(options.run ? { run: options.run } : {}) });
    // A kick is a hint: a row without a reader yet ignores it, and a failed write only waits for the next tick.
    const { kickComms } = yield* Effect.promise(() => import("./owner-queue.ts"));
    yield* Effect.sync(() => { try { kickComms(row.sessionId, options.home); } catch { /* next tick */ } });
    return;
  }
  const { run, machine } = yield* remoteMachine(row.machine);
  const { networkRowIdentity } = yield* Effect.promise(() => import("./desk-route.ts"));
  const sessions = Object.fromEntries(project.agents.filter(other => other.state !== "closed").map(other => [other.sessionId, networkRowIdentity(project, other)]));
  yield* run(prepareRemoteNetworkAgent({ home: options.home, agent: identity, machineName: row.machine, machine, peers, sessions, kick: row.sessionId, ...(options.run ? { run: options.run } : {}) }));
}));

const LIVE_EXCLUDED = new Set(["planned", "closed", "interrupted", "failed"]);
export const liveRows = (project: Project) => project.agents.filter(row => !LIVE_EXCLUDED.has(row.state));

/** Owner custody for a whole project: mint each row's identity here and push remote keys. One note per row; never fails. */
export const provisionLiveRows = (options: { home: string; project: Project; rows: readonly AgentRow[]; run?: PrivateCommand }) => Effect.gen(function* () {
  const { networkRowIdentity } = yield* Effect.promise(() => import("./desk-route.ts"));
  const notes: string[] = [];
  for (const row of options.rows) {
    const identity = networkRowIdentity(options.project, row);
    const peers = options.project.agents.filter(other => other.state !== "closed" && other.name !== row.name).map(other => networkRowIdentity(options.project, other));
    const result = yield* provisionPreflipRow({ home: options.home, target: { project: options.project, row, identity, peers }, ...(options.run ? { run: options.run } : {}) }).pipe(Effect.result);
    notes.push(result._tag === "Success" ? `${row.name}: identity ready${row.machine === "local" ? "" : `, key pushed to ${row.machine}`}` : `${row.name}: NOT provisioned: ${result.failure.message}`);
  }
  return notes;
});

export interface DoctorCheck { readonly name: string; readonly ok: boolean | null; readonly detail: string }
export interface CommsDoctorReport {
  readonly row: string; readonly machine: string; readonly identity: string;
  readonly joined: boolean; readonly verdict: string;
  readonly checks: readonly DoctorCheck[]; readonly fixes: readonly string[];
}

const probedFacts = (value: unknown): JoinFacts => {
  const facts = value as JoinFacts;
  if (facts === null || typeof facts !== "object" || typeof facts.joined !== "boolean" || typeof facts.identity !== "boolean" || !["published", "absent", "invalid"].includes(facts.fence)) throw new Error("probe shape");
  return facts;
};

/** Why a row is or is not on the mailbox. Only the row's owner on Flagg fixes, and only by minting and pushing its key. */
export const commsDoctor = (options: {
  home: string; dir: string; session: string; row?: string;
  /** This process runs on a remote machine: it reports itself only. */
  remote: boolean;
  self?: { agent: string; session: string }; launchHint?: string; configPath?: string; fix?: boolean; run?: PrivateCommand;
}) => Effect.gen(function* () {
  const { explicitPolicyComms } = yield* Effect.promise(() => import("./comms.ts"));
  const { networkRowIdentity } = yield* Effect.promise(() => import("./desk-route.ts"));
  const { projectPath } = yield* Effect.promise(() => import("./store.ts"));
  const project = options.remote ? undefined : (() => { try { return decodeProject(JSON.parse(readFileSync(projectPath(options.dir), "utf8"))); } catch { return undefined; } })();
  if (options.remote && options.row && options.row !== options.self?.agent) return yield* Effect.fail(new CommsError(`comms_doctor on a remote machine reports this process only; run comms_doctor row:${options.row} from its owner on Flagg`));
  if (options.row && !project) return yield* Effect.fail(new CommsError(`comms_doctor: no readable catalog at ${options.dir}`));
  const row = options.row ? project?.agents.find(row => row.name === options.row) : project?.agents.find(row => row.sessionId === options.session && row.state !== "closed");
  if (options.row && !row) return yield* Effect.fail(new CommsError(`comms_doctor: no row ${options.row} in ${project!.slug}`));
  if (!row) {
    const self = options.self;
    if (!self) return yield* Effect.fail(new CommsError("comms_doctor: this session has no row and no Muster agent; nothing to report"));
    const facts = yield* Effect.promise(() => localJoinFacts({ home: options.home, agent: self.agent, session: self.session, remote: options.remote, ...(options.configPath ? { configPath: options.configPath } : {}), ...(options.run ? { run: options.run } : {}) }));
    return report({ row: self.agent, machine: options.remote ? "this remote machine" : "local", identity: self.agent, facts, policy: undefined, hint: options.launchHint, remote: options.remote,
      fixes: ["report only: identities are minted on Flagg and pushed by the row's owner (comms_doctor row:<name> from the owner)"] });
  }
  const identity = networkRowIdentity(project!, row);
  const policy = explicitPolicyComms(options.dir);
  const remoteRow = row.machine !== "local";
  const probe = Effect.gen(function* () {
    if (!remoteRow) return yield* Effect.promise(() => localJoinFacts({ home: options.home, agent: identity, session: row.sessionId, remote: false, ...(options.run ? { run: options.run } : {}) }));
    const { run, remote, machine } = yield* remoteMachine(row.machine);
    const helper = join(machine.musterExtension, "src/comms-network.ts");
    const configPath = row.restore?.env.MUSTER_NETWORK_CONFIG ?? "";
    const stdout = yield* run(remote.remoteNode(row.machine, machine,
      `import {homedir} from 'node:os'; import {localJoinFacts} from ${JSON.stringify(helper)}; console.log(JSON.stringify(await localJoinFacts({home:process.env.HOME??homedir(),agent:process.argv[1],session:process.argv[2],remote:true,...(process.argv[3]?{configPath:process.argv[3]}:{})})));`,
      [identity, row.sessionId, configPath], 30_000)).pipe(Effect.mapError(error => new CommsError(`probe of ${row.machine} failed: ${error.message.split("\n")[0]}`)));
    return yield* Effect.try({ try: () => probedFacts(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")), catch: () => new CommsError(`probe of ${row.machine} returned no join facts; its pi-muster predates comms_doctor`) });
  });
  const cached = () => { try { return readNetworkIdentities(options.home)[identity] !== undefined; } catch { return false; } };
  let facts = yield* probe.pipe(Effect.result);
  const fixes: string[] = [];
  const owner = row.owner === options.session;
  const wanted = !cached() || (facts._tag === "Success" && remoteRow && (facts.success.key === false || facts.success.session === false || !facts.success.identity));
  if (!owner) fixes.push(`report only: session ${options.session} does not own ${row.name}; its owner fixes`);
  else if (options.remote) fixes.push("report only: identities are minted on Flagg");
  else if (policy === "intercom") fixes.push("no fix: project policy comms: intercom opts this project out");
  else if (options.fix === false) { if (wanted) fixes.push("fix: false; would mint and push the key"); }
  else if (wanted) {
    const peers = project!.agents.filter(other => other.state !== "closed" && other.name !== row.name).map(other => networkRowIdentity(project!, other));
    const minted = yield* provisionPreflipRow({ home: options.home, target: { project: project!, row, identity, peers }, ...(options.run ? { run: options.run } : {}) }).pipe(Effect.result);
    fixes.push(minted._tag === "Success" ? `fixed: identity minted${remoteRow ? ` and key pushed to ${row.machine}` : ""}` : `fix failed: ${minted.failure.message}`);
    facts = yield* probe.pipe(Effect.result);
  }
  return report({ row: row.name, machine: row.machine, identity, policy, hint: row.restore?.env.MUSTER_COMMS, remote: remoteRow, cachedHere: cached(), fixes,
    facts: facts._tag === "Success" ? facts.success : undefined, probeError: facts._tag === "Failure" ? facts.failure.message : undefined });
});

function report(input: { row: string; machine: string; identity: string; facts: JoinFacts | undefined; probeError?: string; policy: "intercom" | "network" | undefined; hint: string | undefined; remote: boolean; cachedHere?: boolean; fixes: string[] }): CommsDoctorReport {
  const { facts } = input;
  const where = input.machine === "local" ? "Flagg" : input.machine;
  const checks: DoctorCheck[] = [];
  if (input.cachedHere !== undefined) checks.push({ name: "identity cached on Flagg", ok: input.cachedHere, detail: input.cachedHere ? input.identity : `no identity for ${input.identity}` });
  if (input.policy !== undefined || input.cachedHere !== undefined) checks.push({ name: "project policy", ok: input.policy === "intercom" ? false : input.policy === "network" ? true : null, detail: `comms: ${input.policy ?? "unset (desks only)"}` });
  if (!facts) checks.push({ name: `probe ${where}`, ok: false, detail: input.probeError ?? "no facts" });
  else {
    checks.push({ name: `identity on ${where}`, ok: facts.identity, detail: facts.did ?? "none" });
    if (input.remote) {
      checks.push({ name: `key on ${where}`, ok: facts.key, detail: facts.key === null ? "not checked: no identity or config" : facts.key ? "present in agent secrets" : "missing from agent secrets" });
      checks.push({ name: `session bound on ${where}`, ok: facts.session, detail: facts.session ? "peer cache binds this session" : "peer cache lacks this session" });
    }
    checks.push({ name: `config readable on ${where}`, ok: facts.config === null, detail: facts.config ?? "ok" });
    checks.push({ name: "fence published", ok: facts.fence === "published", detail: facts.fence === "published" ? "a reader holds the mailbox lease" : facts.fence === "invalid" ? "fence file invalid" : "no reader yet" });
  }
  const optedOut = input.policy === "intercom";
  const joined = !optedOut && facts?.joined === true;
  checks.push({ name: "launch hint vs joined fact", ok: null, detail: `MUSTER_COMMS=${input.hint ?? "unset"}; joined: ${joined}${joined && input.hint === "intercom" ? " (the joined fact wins over the hint)" : ""}` });
  const verdict = optedOut ? "not joined: project policy comms: intercom opts this project out"
    : !facts ? `unknown: ${input.probeError ?? "no facts"}`
    : !facts.joined ? `not joined: ${facts.reason}`
    : facts.fence === "published" ? "joined: a reader holds the mailbox"
    : "joined, no reader yet: current pi-muster starts it within about a minute (longer while a predecessor's lease runs out); older code needs a restart";
  return { row: input.row, machine: input.machine, identity: input.identity, joined, verdict, checks, fixes: input.fixes };
}

const HERDR_PROMPT_MAX = 800;
/** Owner only, into a pane Muster opened and still bound to its terminal. Bellwether's agent.prompt proves working. */
export const herdrPromptRow = (options: { row: AgentRow; sender: string; text: string }): Effect.Effect<CommsDelivery> => Effect.gen(function* () {
  const { row } = options;
  if (row.owner !== options.sender) return { status: "failed" as const, detail: `herdr-prompt refused: session ${options.sender} does not own ${row.name}; no text typed` };
  const pane = row.pane;
  if (!pane?.openedByMuster) return { status: "failed" as const, detail: `herdr-prompt refused: Muster did not open a pane for ${row.name}; no text typed` };
  const herdr = yield* Effect.promise(() => import("./herdr.ts"));
  const { HERDR_TRANSPORT_GRACE_MS } = yield* Effect.promise(() => import("@joelhooks/pi-bellwether/herdr-client"));
  const client = row.machine === "local"
    ? yield* Effect.serviceOption(Herdr).pipe(Effect.flatMap(client => Option.isSome(client) ? Effect.succeed(client.value) : Effect.fail(new CommsError("Herdr unavailable"))))
    : yield* remoteMachine(row.machine).pipe(Effect.flatMap(({ run, remote, machine }) => run(remote.remoteClient(row.machine, machine)).pipe(Effect.mapError(error => new CommsError(error.message)))));
  // Pi submits on newline, so the prompt is one line, attributed, and bounded like any inline prompt.
  const suffix = ` [Muster herdr-prompt from session ${options.sender}, not Joel.]`;
  const flat = options.text.replace(/\s*\n\s*/gu, " ⏎ ");
  const room = HERDR_PROMPT_MAX - suffix.length;
  const text = `${flat.length > room ? `${flat.slice(0, room - 16)}… [truncated]` : flat}${suffix}`;
  return yield* Effect.gen(function* () {
    const bound = yield* herdr.paneGet(pane.paneId);
    if (!bound || bound.terminal_id !== pane.terminalId) return { status: "failed" as const, detail: `herdr-prompt refused: ${row.name}'s pane ${pane.paneId} no longer holds its terminal; no text typed` };
    const refusal = herdr.agentReadinessRefusal(yield* herdr.agentGet(pane.paneId), row.name);
    if (refusal) return { status: "failed" as const, detail: `herdr-prompt refused: Herdr readiness ${refusal}; no text typed` };
    const result = yield* herdr.call({ method: "agent.prompt", params: { target: pane.paneId, text, wait: { until: ["working"], timeout_ms: herdr.PROOF_OF_LIFE_MS } }, timeoutMs: herdr.PROOF_OF_LIFE_MS + HERDR_TRANSPORT_GRACE_MS });
    return result.agent.agent_status === "working"
      ? { status: "delivered" as const, detail: `typed into ${row.machine} pane ${pane.paneId}; Herdr observed working${flat.length > room ? "; text truncated" : ""}` }
      : { status: "accepted" as const, detail: `typed into ${row.machine} pane ${pane.paneId}; Herdr did not observe working; read the pane before resending` };
  }).pipe(Effect.provideService(Herdr, client));
}).pipe(Effect.catch(error => Effect.succeed({ status: "failed" as const, detail: `herdr-prompt failed: ${error.message}` })));

/** Network sends to catalog rows. A pre-flip row is provisioned first and prompted through Herdr, never intercom.
 * A remote row its sender owns skips intercom, which cannot reach the remote broker. Non-rows keep the plain path. */
export const routedNetworkSend = <R>(options: {
  home: string; sender: string; to: string; id: string; at: string; text: string;
  target: NetworkTarget | undefined;
  network: Effect.Effect<CommsDelivery, never, R>;
  fallback: () => Effect.Effect<CommsDelivery | undefined, never, R>;
  run?: PrivateCommand;
}) => {
  const { target } = options;
  return Effect.flatMap(target ? preflipRow(options.home, target) : Effect.succeed(false), preflip => {
  if (target && preflip) {
    let provisioned = false;
    return reportedNetworkSend({ ...options, fallbackPath: "herdr-prompt",
      network: provisionPreflipRow({ home: options.home, target, ...(options.run ? { run: options.run } : {}) }).pipe(
        Effect.map(() => { provisioned = true; return { status: "failed" as const, detail: `${target.row.name} has no mailbox reader; network send skipped` }; }),
        Effect.catch(error => Effect.succeed({ status: "failed" as const, detail: `${target.row.name} has no mailbox reader and provisioning did not finish: ${error.message}; nothing sent, no intercom fallback` }))),
      fallback: () => provisioned ? herdrPromptRow({ row: target.row, sender: options.sender, text: options.text }) : Effect.succeed(undefined),
      notice: fallback => preflipNotice(target.row.name, fallback && fallback.status !== "failed" ? "delivered via herdr-prompt" : "not delivered"),
    });
  }
  const herdr = target !== undefined && target.row.machine !== "local" && target.row.owner === options.sender;
  return reportedNetworkSend({ ...options, ...(herdr ? { fallbackPath: "herdr-prompt" as const, fallback: () => herdrPromptRow({ row: target.row, sender: options.sender, text: options.text }) } : {}) });
  });
};

export function networkRecipient(home: string, agent: string): CommsIdentityReference {
  const reference = readNetworkIdentities(home)[decodeNetworkIdentityName(agent)];
  if (!reference) throw new CommsError(`NetworkComms unknown recipient: ${agent}; provision it first`);
  return reference;
}

export type WatchRecovery = "reacquire" | "stop" | "backoff";
export function watchCloseAction(code: number): WatchRecovery {
  switch (code) {
    case 4409: return "reacquire";
    case 4408: case 1000: case 1006: case 1012: return "backoff";
    case 4401: return "stop";
    default: return "backoff";
  }
}

/** No client code is loaded until this effect runs on an opted-in project. */
export function openNetworkMailbox(options: { home: string; agent: string; configPath?: string; run?: PrivateCommand }) {
  return Effect.gen(function* () {
    const config = yield* Effect.try({ try: () => readNetworkConfig(options.home, options.configPath), catch: error => error instanceof CommsError ? error : new CommsError("NetworkComms config invalid") });
    const reference = yield* provisionNetworkAgent(options);
    const client = yield* Effect.tryPromise({ try: () => import("./vendor/rat-king-mailbox-client/index.ts"), catch: () => new CommsError("NetworkComms client unavailable") });
    const defs = yield* Effect.tryPromise({ try: () => import("./vendor/rat-king-lexicon/defs.ts"), catch: () => new CommsError("NetworkComms document decoder unavailable") });
    const identity = yield* Effect.tryPromise({
      try: async () => {
        const raw = await (options.run ?? privateCommand)(config.secretsCommand ?? join(options.home, ".local/bin/secrets"), ["lease", reference.secret, "--ttl", "1h", "--client-id", "muster-network", "--no-update-check"]);
        const identity = Schema.decodeUnknownSync(client.Identity)(JSON.parse(raw));
        if (identity.did !== reference.did) throw new Error("identity mismatch");
        return identity;
      },
      catch: () => new CommsError(`NetworkComms identity lease failed: ${options.agent}; entry ${reference.secret} (output withheld)`),
    });
    const documents = yield* Effect.try({
      try: () => Object.values(readNetworkIdentities(options.home)).map(entry => Schema.decodeUnknownSync(Schema.toType(defs.DidDocument))(entry.document)),
      catch: () => new CommsError("NetworkComms invalid cached recipient document"),
    });
    const mailbox = yield* client.RatKingMailbox.pipe(Effect.provide(client.layer({ endpoint: config.endpoint, serviceDid: config.serviceDid, identity, documents }).pipe(Layer.provide(FetchHttpClient.layer))));
    return mailbox;
  });
}
/** The vendored watch owns backoff and the #notice ready barrier. LeaseMismatch gets a fresh fence. */
export function watchNetworkMailbox(options: {
  mailbox: Pick<Effect.Success<ReturnType<typeof openNetworkMailbox>>, "watch">;
  acquire: () => Effect.Effect<LeaseFence, import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError | CommsError>;
  afterSeq: number;
  reacquire?: () => Effect.Effect<LeaseFence, import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError | CommsError>;
}) {
  let checkpoint = options.afterSeq;
  const subscribe = (reacquire = false): Stream.Stream<Batch, import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError | CommsError> => Stream.unwrap((reacquire ? options.reacquire ?? options.acquire : options.acquire)().pipe(Effect.map(fence => options.mailbox.watch(checkpoint, fence)))).pipe(
    Stream.tap(batch => Effect.sync(() => { checkpoint = batch.throughSeq; })),
    Stream.catchTag("MailboxClientError", error => "error" in error && error.error === "LeaseMismatch" ? subscribe(true) : Stream.fail(error)),
  );
  return Stream.suspend(() => subscribe());
}

/** Public references can cross machines; keys never do. Existing references must match. */
export function seedNetworkIdentities(home: string, value: unknown) {
  const incoming = decodeNetworkIdentityCache(value);
  for (const desk of [false, true]) {
    const entries = Object.fromEntries(Object.entries(incoming).filter(([agent]) => agent.includes("/") === desk));
    if (!Object.keys(entries).length) continue;
    const path = desk ? networkDeskIdentityPath(home) : networkIdentityPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = acquireCacheLock(`${path}.lock`, "NetworkComms identity cache busy; retry seeding");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const current = readIdentityCache(path, desk);
      for (const [agent, reference] of Object.entries(entries)) {
        if (reference.did !== reference.document.id || (current[agent] && JSON.stringify(current[agent]) !== JSON.stringify(reference))) throw new CommsError(`NetworkComms peer reference mismatch: ${agent}`);
      }
      writeFileSync(temp, JSON.stringify({ ...current, ...entries }), { flag: "wx", mode: 0o600 });
      renameSync(temp, path);
    } finally { try { unlinkSync(temp); } catch { /* renamed */ } releaseCacheLock(lock); }
  }
}

const UNDECODABLE = Symbol("undecodable");

/** A retired session's reader stops with this; it is never retried. */
export const RETIRED_PREFIX = "NetworkComms reader retired: mail is addressed to successor session";
export const REFUSAL_PREFIX = "NetworkComms refused your message";
export interface NetworkRefusal {
  readonly kind: "stale-recipient" | "unknown-author" | "sender-mismatch";
  readonly reason: string; readonly seq: number; readonly messageId: string;
  readonly senderDid: string; readonly author: string; readonly recipient: string;
}
export const refusalNotice = (refusal: NetworkRefusal, receiver: string) =>
  `${REFUSAL_PREFIX} ${refusal.messageId} (seq ${refusal.seq}) to ${refusal.recipient}: ${receiver} saved it unread: ${refusal.reason}. ` +
  (refusal.kind === "stale-recipient" ? "That session is retired; send to the row's project/row alias instead. "
    : refusal.kind === "unknown-author" ? "The receiver cannot bind your session to an identity; run comms_doctor, or ask your owner to restart you onto current pi-muster. "
    : "Your signing identity does not match your session; run comms_doctor. ") +
  "Resending it unchanged will be refused again. This notice is sent once.";

/** Claims the one notice per sender session, refusal kind and receiver. False when it was already sent. */
export const claimRefusalNotice = (home: string, agent: string, refusal: NetworkRefusal) => Effect.tryPromise({
  try: async () => {
    const dir = join(home, ".local/state/muster/network-quarantine", createHash("sha256").update(agent).digest("hex").slice(0, 16));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `refusal-${createHash("sha256").update(`${refusal.senderDid}\0${refusal.author}\0${refusal.kind}`).digest("hex").slice(0, 24)}.notice`);
    try { await writeFile(path, JSON.stringify({ at: new Date().toISOString(), ...refusal }), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined; throw error; }
    return path;
  }, catch: () => new CommsError("NetworkComms refusal notice record failed"),
});

/** Private evidence for an authenticated message the consumer could not decode. */
export const quarantineNetworkMessage = (home: string, agent: string, record: { seq: number; messageId: string; senderDid: string; reason: string; body: string }) => Effect.tryPromise({
  try: async () => {
    const dir = join(home, ".local/state/muster/network-quarantine", createHash("sha256").update(agent).digest("hex").slice(0, 16));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${record.seq}-${createHash("sha256").update(record.messageId).digest("hex").slice(0, 16)}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(path, JSON.stringify({ agent, ...record }), { mode: 0o600, flag: "wx" });
    return path;
  }, catch: () => new CommsError("NetworkComms quarantine write failed"),
});

export type NetworkRecordHandler = (input: {
  ownDid: string;
  envelope: Parameters<Effect.Success<ReturnType<typeof openNetworkMailbox>>["open"]>[0];
  opened: import("./vendor/rat-king-mailbox-client/index.ts").OpenedMessage;
  mailbox: Effect.Success<ReturnType<typeof openNetworkMailbox>>;
}) => Effect.Effect<string, CommsError>;

/** Scoped lifecycle: acquire → watch → authenticate/open → ingest → deliver/ack → checkpoint.
 * Cancellation releases the current fence. Transport outages retry; authentication and takeover stop.
 */
export function consumeNetworkMailbox(options: {
  home: string; agent: string; session: string;
  mailbox: Pick<Effect.Success<ReturnType<typeof openNetworkMailbox>>, "watch" | "lease" | "open" | "deliver" | "ack">;
  open?: (envelope: Parameters<Effect.Success<ReturnType<typeof openNetworkMailbox>>["open"]>[0]) => Effect.Effect<import("./vendor/rat-king-mailbox-client/index.ts").OpenedMessage, CommsError | import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError>;
  deskRecord?: (input: Omit<Parameters<NetworkRecordHandler>[0], "mailbox">) => Effect.Effect<string, CommsError>;
  senderAgent: (author: string, senderDid: string) => Effect.Effect<string, CommsError>;
  receive: (payload: import("./domain.ts").NetworkPayload) => Effect.Effect<void, CommsError>;
  /** Whether a payload addressed to `recipient` belongs to this session: itself, or a recorded predecessor. */
  accepts?: (recipient: string, session: string) => boolean;
  /** Whether `recipient` is this session's recorded successor: this reader is retired and must hand the mailbox over. */
  succeededBy?: (recipient: string, session: string) => boolean;
  /** Tell an authenticated sender, once, that its message was refused. Failures never stop the reader. */
  refused?: (refusal: NetworkRefusal) => Effect.Effect<void, CommsError>;
  /** Outage length before the agent is told; default five minutes. */
  outageNoticeMs?: number;
}) {
  const outageNoticeMs = options.outageNoticeMs ?? 5 * 60_000;
  const failure = () => new CommsError("NetworkComms consumer failed (private output withheld)");
  return Effect.gen(function* () {
    if (networkModuleSkew()) return yield* Effect.fail(new CommsError(NETWORK_SKEW));
    yield* awaitRestartActivation(options.session);
    const cursorPath = networkCursorPath(options.home, options.agent);
    let afterSeq = yield* Effect.try({
      try: () => {
        try {
          const checkpoint = (options.agent.includes("/") ? decodeNetworkDeskCursors : decodeNetworkCursors)(privateJson(cursorPath))[options.agent];
          if (checkpoint === undefined) throw new Error("cursor belongs to another agent");
          return checkpoint;
        }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0; throw error; }
      }, catch: failure,
    });
    const defs = yield* Effect.promise(() => import("./vendor/rat-king-lexicon/defs.ts"));
    const isMessage = Schema.is(Schema.toType(defs.MessageEvent));
    const { MailboxClientError } = yield* Effect.promise(() => import("./vendor/rat-king-mailbox-client/error.ts"));
    const ownDid = yield* Effect.try({ try: () => networkRecipient(options.home, options.agent).did, catch: failure });
    let fence: LeaseFence | undefined;
    let leaseExpiresAt: string | undefined;
    const lifecycle = createActor(networkLeaseMachine).start();
    const transient = (error: import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError) =>
      !["AuthRequired", "LeaseTakenOver", "StaleGeneration"].includes(error.error ?? "") &&
      (error.error === undefined || error.status === 408 || (error.status !== undefined && error.status >= 500) || error.error === "SocketDisconnected");
    const expired = () => new MailboxClientError({ error: "LeaseExpired", reason: "Consumer lease expired" });
    const bounded = <A>(effect: Effect.Effect<A, import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError>, ms = 10_000) => effect.pipe(
      Effect.timeoutOrElse({ duration: Math.max(1, ms), orElse: () => Effect.fail(new MailboxClientError({ reason: "Mailbox request timed out" })) }));
    const notice = (body: string) => options.receive({ type: "message", recipient: options.session, author: "NetworkComms (local)", body });
    // Each notice wakes the agent for a full turn. Mailbox restarts and backups are routine, so only an
    // outage that outlasts the notice window is announced, and recovery only when degradation was.
    // Every retry calls degrade(), so the announcement lands within one backoff of the window.
    let degradedAt: number | undefined;
    let announced = false;
    const degrade = () => Effect.gen(function* () {
      lifecycle.send({ type: "DEGRADE" });
      degradedAt ??= Date.now();
      if (announced || Date.now() - degradedAt < outageNoticeMs) return;
      announced = true;
      yield* notice(`NetworkComms reader degraded for ${Math.round((Date.now() - degradedAt) / 60_000)} min: mailbox unavailable or lease expired. Retrying without a session restart; no intercom fallback.`);
    });
    const active = () => Effect.gen(function* () {
      lifecycle.send({ type: "ACTIVE" });
      const wasAnnounced = announced;
      degradedAt = undefined; announced = false;
      if (wasAnnounced) yield* notice("NetworkComms reader recovered: mailbox lease active; queued intake resumed.");
    });
    const acquire = () => bounded(options.mailbox.lease.acquire({ did: ownDid,
      harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: options.session }, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })).pipe(Effect.flatMap(lease => lease.did !== ownDid || lease.harness.$type !== "sh.mschf.ratking.runtime.lease#pi" || lease.harness.sessionId !== options.session
      ? Effect.fail(new MailboxClientError({ error: "LeaseTakenOver", reason: "Mailbox lease differs from consumer identity" }))
      : Effect.gen(function* () {
        fence = lease; leaseExpiresAt = lease.expiresAt; // Release even if publishing fails.
        yield* publishConsumerFence(options.home, lease).pipe(Effect.uninterruptible, Effect.mapError(() => new MailboxClientError({ error: "FencePublishFailed", reason: "NetworkComms could not publish consumer fence" })));
        if (lifecycle.getSnapshot().value !== "live") yield* active();
        return lease;
      })));
    // A restart replacement starts while its predecessor's lease is still unexpired (it renewed until exit),
    // and the server refuses every unexpired holder. Wait out that holder's returned expiry and retry;
    // never take a lease over. A holder that keeps renewing outlasts the attempts and the consumer fails.
    const acquireWaiting = (attempt = 0): Effect.Effect<LeaseFence, import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError | CommsError> => acquire().pipe(
      Effect.catch(error => !(error instanceof MailboxClientError) || error.error !== "LeaseHeld" || attempt >= 3 ? Effect.fail(error) : bounded(options.mailbox.lease.resolve(ownDid)).pipe(
        Effect.map(holder => Math.min(6 * 60_000, Math.max(1_000, Date.parse(holder.expiresAt) - Date.now() + 2_000))),
        Effect.catch(missing => missing.error === "LeaseNotFound" ? Effect.succeed(0) : Effect.fail(missing)),
        Effect.flatMap(wait => Effect.sleep(wait)),
        Effect.flatMap(() => acquireWaiting(attempt + 1)))));
    // Today's server refuses acquire even for our own live lease. Reuse it, or acquire only after expiry.
    const reacquire = () => bounded(options.mailbox.lease.resolve(ownDid)).pipe(
      Effect.catch(error => error.error === "LeaseNotFound" ? acquire() : Effect.fail(error)),
      Effect.flatMap(current => {
        if (current.did !== ownDid || current.harness.$type !== "sh.mschf.ratking.runtime.lease#pi" || current.harness.sessionId !== options.session)
          return Effect.fail(new MailboxClientError({ error: "LeaseTakenOver", reason: "Identity lease belongs to another session" }));
        if (Date.parse(current.expiresAt) <= Date.now()) return acquire();
        if (fence && (current.leaseId !== fence.leaseId || current.generation !== fence.generation))
          return Effect.fail(new MailboxClientError({ error: "StaleGeneration", reason: "Identity lease fence changed" }));
        return Effect.gen(function* () {
          const unpublished = fence === undefined;
          fence = current; leaseExpiresAt = current.expiresAt;
          if (unpublished) {
            // An acquire may have succeeded remotely before its transport timed out.
            yield* publishConsumerFence(options.home, current);
            yield* active();
          }
          return current;
        });
      }));
    const run = Effect.suspend(() => watchNetworkMailbox({ mailbox: options.mailbox,
      acquire: () => fence || lifecycle.getSnapshot().value !== "acquiring" ? reacquire() : acquireWaiting(),
      reacquire: () => {
        const previous = fence;
        return reacquire().pipe(Effect.flatMap(current => current.leaseId === previous?.leaseId && current.generation === previous.generation
          ? Effect.sleep(1_000).pipe(Effect.as(current)) : Effect.succeed(current)));
      }, afterSeq,
    }).pipe(Stream.runForEach(batch => Effect.gen(function* () {
      yield* active();
      for (const event of batch.events) {
        if (event.$type !== "sh.mschf.ratking.defs#messageEvent" || !isMessage(event)) continue;
        const authenticated = yield* (options.open ?? options.mailbox.open)(event.envelope).pipe(
          Effect.map(opened => ({ kind: "opened" as const, opened })),
          Effect.catch(error => {
            // Ciphertext has no trustworthy record type before authentication. Preserve it before refusing delivery.
            // Protocol auth/lease/fence errors must retain the existing stop behavior.
            if (!options.deskRecord || !(error instanceof MailboxClientError) || error.error !== undefined || error.status !== undefined) return Effect.fail(failure());
            return Effect.promise(() => import("./desk-phone-store.ts")).pipe(Effect.flatMap(store => store.quarantineDeskPhoneEnvelope(options.home, event, "Envelope verification or decryption failed")),
              Effect.map(path => ({ kind: "quarantined" as const, path })), Effect.mapError(() => new CommsError("NetworkComms quarantine failed; envelope was not acked")));
          }),
        );
        if (authenticated.kind === "quarantined") {
          yield* options.receive({ type: "message", recipient: options.session, author: "desk_phone (local dispatch)",
            body: `desk_phone refused envelope from claimed sender ${event.receipt.message.senderDid}: envelope verification or decryption failed. Saved before ack: ${authenticated.path}.` });
        } else {
          const opened = authenticated.opened;
          if (opened.tid !== event.receipt.message.messageId || opened.senderDid !== event.receipt.message.senderDid) return yield* Effect.fail(new CommsError("NetworkComms receipt differs from authenticated envelope"));
          // An authenticated body that is not a Muster payload is saved and acked, never fatal:
          // the cursor replays it on every start, so failing here would stop the consumer for good.
          const undecodable = (reason: string) => quarantineNetworkMessage(options.home, options.agent, { seq: event.seq, messageId: opened.tid, senderDid: opened.senderDid, reason, body: opened.body }).pipe(
            Effect.mapError(() => new CommsError("NetworkComms could not quarantine an undecodable message; it was not acked")),
            Effect.flatMap(path => options.receive({ type: "message", recipient: options.session, author: "NetworkComms (local)",
              body: `NetworkComms skipped message seq ${event.seq} from ${opened.senderDid}: ${reason}. Saved before ack: ${path}.` })));
          const raw = yield* Effect.try({ try: (): unknown => JSON.parse(opened.body), catch: () => "not JSON" as const }).pipe(Effect.catch(() => Effect.succeed(UNDECODABLE)));
          if (raw === UNDECODABLE) yield* undecodable("body is not JSON");
          else if (options.deskRecord && raw !== null && typeof raw === "object" && "$type" in raw && raw.$type === "sh.mschf.ratking.desk.answer") {
            // This shares the authenticated consumer, lease and checkpoint with ordinary network messages.
            // Record refusals become visible notices, never agent payload decoding failures.
            const notice = yield* options.deskRecord({ ownDid, envelope: event.envelope, opened }).pipe(Effect.catch(() => Effect.succeed("desk_phone answer failed: record handler unavailable; inspect sidecar and retry sync")));
            yield* options.receive({ type: "message", recipient: options.session, author: "desk_phone (local dispatch)", body: notice });
          } else {
            const decoded = yield* Effect.try({ try: () => decodeNetworkPayload(raw), catch: () => "not a payload" as const }).pipe(Effect.catch(() => Effect.succeed(UNDECODABLE)));
            if (decoded === UNDECODABLE) { yield* undecodable("body is not a Muster network payload"); }
            else {
            const payload = decoded;
            // A retired session's reader that meets its successor's mail stops before acking it: the cursor
            // stays before this message, the lease is released on exit, and the successor reads it.
            if (payload.recipient !== options.session && options.succeededBy?.(payload.recipient, options.session)) {
              yield* Effect.tryPromise({ try: async () => {
                await mkdir(dirname(cursorPath), { recursive: true, mode: 0o700 });
                const temp = `${cursorPath}.${process.pid}.tmp`;
                await writeFile(temp, JSON.stringify({ [options.agent]: Math.max(afterSeq, event.seq - 1) }), { mode: 0o600 }); await rename(temp, cursorPath);
              }, catch: failure });
              return yield* Effect.fail(new CommsError(`${RETIRED_PREFIX} ${payload.recipient}; this reader stops and releases its lease`));
            }
            // These refusals are per message: saved, acked and surfaced, never delivered. Failing the consumer
            // instead replays the same message on every start, so one bad record kills the reader for good
            // (2026-10-07: a retired desk session signed with its legacy identity after handover).
            const author = payload.type === "owner" ? payload.item.author : payload.author;
            // Mail to a recorded predecessor follows its successor; any other session's mail is stale.
            const addressed = payload.recipient === options.session || (options.accepts?.(payload.recipient, options.session) ?? false);
            const agent = !addressed ? undefined : yield* options.senderAgent(author, opened.senderDid).pipe(Effect.catch(() => Effect.succeed(undefined)));
            const expected = agent === undefined ? undefined : yield* Effect.try({ try: () => networkRecipient(options.home, agent).did, catch: () => undefined }).pipe(Effect.catch(() => Effect.succeed(undefined)));
            const refusal = !addressed ? { kind: "stale-recipient" as const, reason: `addressed to session ${payload.recipient}, not this session (stale delivery refused)` }
              : agent === undefined ? { kind: "unknown-author" as const, reason: `payload author ${author} is not a known agent (refused)` }
              : expected !== opened.senderDid ? { kind: "sender-mismatch" as const, reason: `authenticated sender differs from payload author ${author} (expected ${expected ?? "unknown"}; refused)` }
              : undefined;
            if (!refusal) yield* options.receive(payload);
            else {
              yield* undecodable(refusal.reason);
              // A refusal of a refusal notice is never answered: two strangers must not ping-pong.
              const notice = payload.type === "message" && payload.body.startsWith(REFUSAL_PREFIX);
              if (options.refused && !notice) yield* options.refused({ ...refusal, seq: event.seq, messageId: opened.tid, senderDid: opened.senderDid, author, recipient: payload.recipient }).pipe(
                Effect.timeout("10 seconds"), Effect.ignore);
            }
            }
          }
        }
        if (!fence) return yield* Effect.fail(failure());
        const delivery = { message: event.receipt.message, leaseId: fence.leaseId, generation: fence.generation };
        // Mailbox errors pass through so lease loss is named below, not withheld.
        yield* options.mailbox.deliver(delivery);
        yield* options.mailbox.ack(delivery);
      }
      // The consumer runs off a poll: never block the event loop on a stalled rename (Pi Freeze, 2026-10-06).
      yield* Effect.tryPromise({ try: async () => {
        await mkdir(dirname(cursorPath), { recursive: true, mode: 0o700 });
        const temp = `${cursorPath}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ [options.agent]: batch.throughSeq }), { mode: 0o600 }); await rename(temp, cursorPath);
      }, catch: failure });
      afterSeq = batch.throughSeq; // Retry only from durable intake, never from the watch's speculative cursor.
    }))));
    // The mailbox grants short leases whatever is requested; renew at half the remaining time while the consumer runs.
    const renewing = Effect.gen(function* () {
      for (;;) {
        const current = fence;
        const wait = current && leaseExpiresAt ? Math.max(1_000, (Date.parse(leaseExpiresAt) - Date.now()) / 2) : 1_000;
        yield* Effect.sleep(wait);
        if (!current || fence !== current || lifecycle.getSnapshot().value === "acquiring") continue;
        let delay = 1_000;
        const renew = (): Effect.Effect<Effect.Success<ReturnType<typeof options.mailbox.lease.renew>>, import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError | CommsError> => Effect.suspend(() => {
          const remaining = Date.parse(leaseExpiresAt!) - Date.now();
          if (remaining <= 0) return Effect.fail(expired());
          return bounded(options.mailbox.lease.renew({ did: current.did, leaseId: current.leaseId, generation: current.generation, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }), Math.min(10_000, remaining)).pipe(
            Effect.catch(error => !transient(error) ? Effect.fail(error) : degrade().pipe(
              Effect.flatMap(() => Effect.sleep(Math.min(delay, Math.max(0, Date.parse(leaseExpiresAt!) - Date.now())))),
              Effect.tap(() => Effect.sync(() => { delay = Math.min(60_000, delay * 2); })), Effect.flatMap(renew))));
        });
        const renewed = yield* renew();
        if (fence !== current) continue; // re-acquired meanwhile
        if (renewed.did !== current.did || renewed.leaseId !== current.leaseId || renewed.generation !== current.generation)
          return yield* Effect.fail(new MailboxClientError({ error: "StaleGeneration", reason: "Renewed fence changed" }));
        fence = renewed; leaseExpiresAt = renewed.expiresAt;
        if (delay > 1_000) yield* active();
        // Expiry is refreshed by the authority; leaseId/generation must remain our fence.
      }
    });
    const retire = () => Effect.suspend(() => {
      if (!fence) return Effect.void;
      const retired = fence;
      const path = networkFencePath(options.home, ownDid);
      return Effect.acquireUseRelease(acquireFenceLock(`${path}.lock`), lock => Effect.tryPromise({ try: async () => {
        const current = readConsumerFence(options.home, ownDid);
        // Serialize with publishers: an old consumer cannot retire a newer registration.
        if (ownsFenceLock(lock) && current?.leaseId === retired.leaseId && current.generation === retired.generation) await unlink(path);
      }, catch: failure }), releaseFenceLock).pipe(Effect.ignore, Effect.ensuring(options.mailbox.lease.release(retired).pipe(Effect.timeout("5 seconds"), Effect.ignore)));
    });
    const reader = Effect.gen(function* () {
      let delay = 5_000;
      for (;;) {
        const result = yield* Effect.raceFirst(run, renewing).pipe(Effect.result);
        if (result._tag === "Success") return;
        const error = result.failure;
        if (!(error instanceof MailboxClientError) || !(transient(error) || ["LeaseExpired", "LeaseNotFound", "LeaseMismatch"].includes(error.error ?? "")))
          return yield* Effect.fail(error);
        if (lifecycle.getSnapshot().value === "live") delay = 5_000;
        yield* degrade();
        if ((leaseExpiresAt && Date.parse(leaseExpiresAt) <= Date.now()) || error.error === "LeaseExpired" || error.error === "LeaseNotFound") {
          lifecycle.send({ type: "EXPIRE" });
          yield* retire(); fence = undefined; leaseExpiresAt = undefined;
        }
        yield* Effect.sleep(leaseExpiresAt ? Math.min(delay, Math.max(0, Date.parse(leaseExpiresAt) - Date.now())) : delay);
        delay = Math.min(60_000, delay * 2);
      }
    });
    return yield* reader.pipe(Effect.mapError(error => {
      lifecycle.send({ type: "FAIL" });
      if (error instanceof MailboxClientError && error.error === "AuthRequired") return new CommsError("NetworkComms authentication failed; consumer stopped");
      if (error instanceof MailboxClientError && ["LeaseTakenOver", "StaleGeneration", "LeaseHeld"].includes(error.error ?? ""))
        return new CommsError(`NetworkComms consumer lost its identity lease: ${error.error}; consumer stopped; this notice is desk-visible.`);
      return error instanceof CommsError && !(error instanceof MailboxClientError) ? error : failure();
    }), Effect.ensuring(retire()), Effect.ensuring(Effect.sync(() => { if (lifecycle.getSnapshot().status !== "done") lifecycle.send({ type: "STOP" }); lifecycle.stop(); })));
  });
}

export function createNetworkComms(options: {
  home: string;
  sender: () => { agent: string; session: string } | undefined;
  recipient: (to: CommsTarget) => Effect.Effect<string, CommsError>;
  run?: PrivateCommand;
  configPath?: string;
  session?: (to: CommsTarget) => Effect.Effect<string, CommsError>;
  deskRecord?: NetworkRecordHandler;
  /** Which addressed sessions this reader accepts; default only its own. */
  accepts?: (recipient: string, session: string) => boolean;
  /** This session's recorded successor: a retired reader hands the mailbox over. */
  succeededBy?: (recipient: string, session: string) => boolean;
  /** Author session → identity for received payloads; default `recipient`. */
  author?: (author: string, senderDid: string) => Effect.Effect<string, CommsError>;
}): CommsShape {
  const mailbox = Effect.suspend(() => {
    const sender = options.sender();
    if (!sender) return Effect.fail(new CommsError("NetworkComms sender context missing; agent and session required"));
    return openNetworkMailbox({ ...options, agent: sender.agent });
  });
  const recipient = (to: CommsTarget) => options.recipient(to).pipe(Effect.flatMap(agent => Effect.try({ try: () => networkRecipient(options.home, agent), catch: error => error instanceof CommsError ? error : new CommsError("NetworkComms recipient invalid") })));
  const targetSession = (to: CommsTarget) => options.session ? options.session(to) : typeof to === "string" ? Effect.succeed(to) : Effect.fail(new CommsError("NetworkComms recipient session required"));
  const send = (to: CommsTarget, body: string) => Effect.gen(function* () {
      const target = yield* recipient(to);
      const sender = options.sender();
      if (!sender) return yield* Effect.fail(new CommsError("NetworkComms sender context missing"));
      const service = yield* openNetworkMailbox({ ...options, agent: sender.agent });
      const ownDid = networkRecipient(options.home, sender.agent).did;
      const result = yield* sendWithConsumerFence({ home: options.home, did: ownDid, send: opts => service.send(target.did, body, opts) });
      const { receiptDelivery } = yield* Effect.promise(() => import("./comms.ts"));
      const delivery = yield* receiptDelivery(result.receipt);
      return { ...delivery, id: result.receipt.message.messageId, senderDid: ownDid, recipientDid: target.did, seq: result.receipt.seq, detail: `${delivery.detail ? `${delivery.detail}; ` : ""}messageId: ${result.receipt.message.messageId}; seq: ${result.receipt.seq}; state: ${result.receipt.state}` };
    }).pipe(Effect.catch(error => Effect.gen(function* () {
      const { MailboxClientError } = yield* Effect.promise(() => import("./vendor/rat-king-mailbox-client/error.ts"));
      const { isKnownError } = yield* Effect.promise(() => import("./vendor/rat-king-lexicon/mailbox.send.ts"));
      const code = error instanceof MailboxClientError && error.error && isKnownError(error.error) ? error.error : undefined;
      return { status: "failed" as const, detail: error instanceof CommsError ? error.message : code
        ? `NetworkComms send failed: ${code}${code === "LeaseMismatch" ? "; sender lease held elsewhere (another process with this identity) or fence changed" : ""} (private output withheld)`
        : "NetworkComms send failed (private output withheld)" };
    })));
  return {
    mode: () => Effect.succeed("network"),
    send: (to, body) => targetSession(to).pipe(Effect.flatMap(session => {
      const sender = options.sender();
      if (!sender) return Effect.succeed({ status: "failed" as const, detail: "NetworkComms sender context missing" });
      return send(to, JSON.stringify({ type: "message", recipient: session, author: sender.session, body }));
    }), Effect.catch(error => Effect.succeed({ status: "failed" as const, detail: error.message }))),
    postOwner: (to, item) => options.sender()?.session === item.author ? send(to, JSON.stringify({ type: "owner", recipient: to, item })) : Effect.succeed({ status: "failed", detail: "NetworkComms owner author differs from sender session" }),
    consume: receive => Effect.gen(function* () {
      const sender = options.sender();
      if (!sender) return yield* Effect.fail(new CommsError("NetworkComms consumer sender context missing"));
      yield* awaitRestartActivation(sender.session);
      const service = yield* mailbox;
      return yield* consumeNetworkMailbox({ home: options.home, agent: sender.agent, session: sender.session, mailbox: service,
        senderAgent: (author, senderDid) => options.author ? options.author(author, senderDid) : options.recipient(author), receive,
        ...(options.accepts ? { accepts: options.accepts } : {}),
        ...(options.succeededBy ? { succeededBy: options.succeededBy } : {}),
        // The sender hears of a refusal once, from the receiver, instead of resending into a quarantine forever.
        refused: refusal => claimRefusalNotice(options.home, sender.agent, refusal).pipe(Effect.flatMap(claimed => claimed === undefined ? Effect.void
          : send(`did:${refusal.senderDid.slice(4)}`, JSON.stringify({ type: "message", recipient: refusal.author, author: sender.session, body: refusalNotice(refusal, `${sender.agent} (session ${sender.session})`) })).pipe(
            Effect.flatMap(delivery => delivery.status === "failed" || delivery.status === "expired"
              ? Effect.promise(() => unlink(claimed).catch(() => {})) : Effect.void)))),
        deskRecord: sender.agent === "switchboard" && options.deskRecord ? input => options.deskRecord!({ ...input, mailbox: service }) : undefined,
        // Static client documents are snapshots. New workers provision after the desk starts.
        open: envelope => mailbox.pipe(Effect.flatMap(fresh => fresh.open(envelope))),
      });
    }),
    resolve: to => Effect.gen(function* () {
      const target = yield* recipient(to);
      const service = yield* mailbox;
      const lease = yield* service.lease.resolve(target.did).pipe(Effect.mapError(() => new CommsError("NetworkComms lease resolution failed")));
      const session = lease.harness.sessionId;
      if (lease.harness.$type !== "sh.mschf.ratking.runtime.lease#pi" || typeof session !== "string" || !session) return yield* Effect.fail(new Unsupported("NetworkComms recipient has no Pi session"));
      return { address: { kind: "did" as const, did: `did:${target.did.slice(4)}` }, session, expiresAt: lease.expiresAt };
    }),
    ask: () => Effect.fail(new Unsupported("NetworkComms ask is unsupported; use owner_note for questions")),
    reply: () => Effect.fail(new Unsupported("NetworkComms reply requires an owner record; use owner_reply")),
    wake: () => Effect.succeed({ woke: false, reason: "NetworkComms wakes through authenticated inbox delivery, not a separate signal" }),
    sessions: () => Effect.succeed(undefined),
  };
}
