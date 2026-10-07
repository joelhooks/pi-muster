import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import { createActor } from "xstate";
import { networkLeaseMachine } from "./machines.ts";
import { FetchHttpClient } from "effect/http";
import { decodeOwnerSession, decodeNetworkSendFence, decodeNetworkFenceLock, decodeNetworkIdentityName, decodeCommsIdentityCache, decodeNetworkIdentityCache, decodeNetworkDeskIdentityCache, decodeNetworkDeskCursors, decodeNetworkDeskPeers, decodeNetworkPeers, decodeNetworkPeerReferences, decodeCommsIdentityReference, decodeNetworkCommsConfig, decodeNetworkPayload, decodeNetworkCursors, type CommsIdentityReference } from "./domain.ts";
import { CommsError, MusterEnv, Proc, Unsupported, type CommsShape, type CommsTarget } from "./runtime.ts";
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
export function readNetworkConfig(home: string, path = networkConfigPath(home)) {
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
        try {
          reference = decodeCommsIdentityReference(JSON.parse(await (options.run ?? privateCommand)(config.provisionWrapper, ["provision", "--agent", provisionName, "--did", did])));
        } catch { throw new CommsError(`NetworkComms provisioning failed: ${agent} (output withheld)`); }
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
export function prepareRemoteNetworkAgent(options: { home: string; agent: string; machineName: string; machine: import("./domain.ts").MachineConfig; peers?: readonly string[]; run?: PrivateCommand }) {
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
    yield* remoteNode(options.machineName, options.machine,
      `import {homedir} from 'node:os'; import {seedNetworkIdentities} from ${JSON.stringify(helper)}; seedNetworkIdentities(process.env.HOME??homedir(),JSON.parse(process.argv[1]));`, [JSON.stringify(peers)]).pipe(Effect.mapError(() => new CommsError(`machine ${options.machineName}: public peer cache probe failed; launch refused`)));
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
  senderAgent: (author: string) => Effect.Effect<string, CommsError>;
  receive: (payload: import("./domain.ts").NetworkPayload) => Effect.Effect<void, CommsError>;
}) {
  const failure = () => new CommsError("NetworkComms consumer failed (private output withheld)");
  return Effect.gen(function* () {
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
    const degrade = () => Effect.gen(function* () {
      const previous = lifecycle.getSnapshot().value;
      lifecycle.send({ type: "DEGRADE" });
      if (previous === "live" || previous === "acquiring") yield* notice("NetworkComms reader degraded: mailbox unavailable or lease expired. Retrying without a session restart; no intercom fallback.");
    });
    const active = () => Effect.gen(function* () {
      const previous = lifecycle.getSnapshot().value;
      lifecycle.send({ type: "ACTIVE" });
      if (previous === "degraded" || previous === "reacquiring") yield* notice("NetworkComms reader recovered: mailbox lease active; queued intake resumed.");
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
            // These refusals are per message: saved, acked and surfaced, never delivered. Failing the consumer
            // instead replays the same message on every start, so one bad record kills the reader for good
            // (2026-10-07: a retired desk session signed with its legacy identity after handover).
            const author = payload.type === "owner" ? payload.item.author : payload.author;
            const agent = payload.recipient !== options.session ? undefined : yield* options.senderAgent(author).pipe(Effect.catch(() => Effect.succeed(undefined)));
            const expected = agent === undefined ? undefined : yield* Effect.try({ try: () => networkRecipient(options.home, agent).did, catch: () => undefined }).pipe(Effect.catch(() => Effect.succeed(undefined)));
            if (payload.recipient !== options.session) yield* undecodable(`addressed to session ${payload.recipient}, not this session (stale delivery refused)`);
            else if (agent === undefined) yield* undecodable(`payload author ${author} is not a known agent (refused)`);
            else if (expected !== opened.senderDid) yield* undecodable(`authenticated sender differs from payload author ${author} (expected ${expected ?? "unknown"}; refused)`);
            else yield* options.receive(payload);
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
        senderAgent: author => options.recipient(author), receive,
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
