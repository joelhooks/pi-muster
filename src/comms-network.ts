import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { decodeNetworkSendFence, decodeNetworkFenceLock, decodeNetworkIdentityName, decodeCommsIdentityCache, decodeCommsIdentityReference, decodeNetworkCommsConfig, decodeNetworkPayload, decodeNetworkCursors, type CommsIdentityReference } from "./domain.ts";
import { CommsError, Unsupported, type CommsShape, type CommsTarget } from "./runtime.ts";
import type { Batch, LeaseFence } from "./vendor/rat-king-mailbox-client/index.ts";

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
export function readNetworkIdentities(home: string) {
  const path = networkIdentityPath(home);
  try {
    const cache = decodeCommsIdentityCache(privateJson(path));
    if (Object.values(cache).some(entry => entry.did !== entry.document.id)) throw new Error("document mismatch");
    return cache;
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    if (error instanceof CommsError) throw error;
    throw new CommsError(`NetworkComms invalid identity cache: ${path}`);
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
export function provisionNetworkAgent(options: { home: string; agent: string; configPath?: string; run?: PrivateCommand }): Effect.Effect<CommsIdentityReference, CommsError> {
  return Effect.tryPromise({
    try: async () => {
      const agent = decodeNetworkIdentityName(options.agent);
      const provisionName = networkProvisionName(agent);
      const config = readNetworkConfig(options.home, options.configPath);
      const path = networkIdentityPath(options.home);
      const did = Object.hasOwn(config.didOverrides ?? {}, provisionName) ? config.didOverrides![provisionName]! : config.didTemplate.replace("{agent}", provisionName);
      const cached = readNetworkIdentities(options.home)[agent];
      if (cached) {
        if (cached.did !== did) throw new CommsError(`NetworkComms cached identity differs from config: ${agent}`);
        return cached;
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const lock = `${path}.lock`;
      try { writeFileSync(lock, "", { flag: "wx", mode: 0o600 }); }
      catch { throw new CommsError(`NetworkComms identity cache busy: ${agent}; retry provisioning`); }
      try {
        const identities = readNetworkIdentities(options.home);
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
      } finally { unlinkSync(lock); }
    },
    catch: error => error instanceof CommsError ? error : new CommsError(`NetworkComms provisioning failed: ${options.agent} (output withheld)`),
  });
}

export function prepareRemoteNetworkAgent(options: { home: string; agent: string; machineName: string; machine: import("./domain.ts").MachineConfig }) {
  return Effect.gen(function* () {
    const configPath = options.machine.comms?.config;
    if (!configPath) return yield* Effect.fail(new CommsError(`machine ${options.machineName}: network project requires a comms config block; launch refused`));
    const { remoteNode } = yield* Effect.promise(() => import("./remote.ts"));
    const helper = join(options.machine.musterExtension, "src/comms-network.ts");
    const effect = join(options.machine.musterExtension, "node_modules/effect/dist/index.js");
    const raw = yield* remoteNode(options.machineName, options.machine,
      `import {homedir} from 'node:os'; import {Effect} from ${JSON.stringify(effect)}; import {provisionNetworkAgent} from ${JSON.stringify(helper)}; const reference=await Effect.runPromise(provisionNetworkAgent({home:process.env.HOME??homedir(),agent:process.argv[1],configPath:process.argv[2]})); console.log(JSON.stringify(reference));`, [options.agent, configPath]).pipe(Effect.mapError(() => new CommsError(`machine ${options.machineName}: network config/provision probe failed for ${options.agent}; launch refused`)));
    const reference = yield* Effect.try({ try: () => decodeCommsIdentityReference(JSON.parse(raw)), catch: () => new CommsError(`machine ${options.machineName}: invalid public identity reference for ${options.agent}`) });
    yield* Effect.try({ try: () => seedNetworkIdentities(options.home, { [options.agent]: reference }), catch: () => new CommsError(`machine ${options.machineName}: peer identity cache mismatch for ${options.agent}`) });
    const peers = yield* Effect.try({ try: () => readNetworkIdentities(options.home), catch: () => new CommsError("NetworkComms peer references unavailable") });
    yield* remoteNode(options.machineName, options.machine,
      `import {homedir} from 'node:os'; import {seedNetworkIdentities} from ${JSON.stringify(helper)}; seedNetworkIdentities(process.env.HOME??homedir(),JSON.parse(process.argv[1]));`, [JSON.stringify(peers)]).pipe(Effect.mapError(() => new CommsError(`machine ${options.machineName}: public peer cache probe failed; launch refused`)));
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
  acquire: () => Effect.Effect<LeaseFence, import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError>;
  afterSeq: number;
}) {
  let checkpoint = options.afterSeq;
  const subscribe = (): Stream.Stream<Batch, import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError> => Stream.unwrap(options.acquire().pipe(Effect.map(fence => options.mailbox.watch(checkpoint, fence)))).pipe(
    Stream.tap(batch => Effect.sync(() => { checkpoint = batch.throughSeq; })),
    Stream.catchTag("MailboxClientError", error => error.error === "LeaseMismatch" ? subscribe() : Stream.fail(error)),
  );
  return Stream.suspend(subscribe);
}

/** Public references can cross machines; keys never do. Existing references must match. */
export function seedNetworkIdentities(home: string, value: unknown) {
  const incoming = decodeCommsIdentityCache(value);
  const path = networkIdentityPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
  try {
    const current = readNetworkIdentities(home);
    for (const [agent, reference] of Object.entries(incoming)) {
      if (reference.did !== reference.document.id || (current[agent] && JSON.stringify(current[agent]) !== JSON.stringify(reference))) throw new CommsError(`NetworkComms peer reference mismatch: ${agent}`);
    }
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...current, ...incoming }), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally { unlinkSync(lock); }
}

/** Scoped lifecycle: acquire → watch → authenticate/open → ingest → deliver/ack → checkpoint.
 * Cancellation releases the current fence. Auth failures stop; only the vendor owns socket backoff.
 */
export function consumeNetworkMailbox(options: {
  home: string; agent: string; session: string;
  mailbox: Pick<Effect.Success<ReturnType<typeof openNetworkMailbox>>, "watch" | "lease" | "open" | "deliver" | "ack">;
  open?: (envelope: Parameters<Effect.Success<ReturnType<typeof openNetworkMailbox>>["open"]>[0]) => Effect.Effect<import("./vendor/rat-king-mailbox-client/index.ts").OpenedMessage, CommsError | import("./vendor/rat-king-mailbox-client/error.ts").MailboxClientError>;
  senderAgent: (author: string) => Effect.Effect<string, CommsError>;
  receive: (payload: import("./domain.ts").NetworkPayload) => Effect.Effect<void, CommsError>;
}) {
  const failure = () => new CommsError("NetworkComms consumer failed (private output withheld)");
  return Effect.gen(function* () {
    const cursorPath = join(options.home, ".local/state/muster/network-cursors", `${networkProvisionName(options.agent)}.json`);
    const afterSeq = yield* Effect.try({
      try: () => {
        try {
          const checkpoint = decodeNetworkCursors(privateJson(cursorPath))[options.agent];
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
    const acquire = () => options.mailbox.lease.acquire({ did: ownDid,
      harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: options.session }, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }).pipe(Effect.flatMap(lease => lease.did !== ownDid || lease.harness.$type !== "sh.mschf.ratking.runtime.lease#pi" || lease.harness.sessionId !== options.session
      ? Effect.fail(new MailboxClientError({ reason: "Mailbox lease differs from consumer identity" }))
      : Effect.gen(function* () {
        fence = lease; // Release even if publishing fails.
        yield* publishConsumerFence(options.home, lease).pipe(Effect.uninterruptible, Effect.mapError(() => new MailboxClientError({ reason: "NetworkComms could not publish consumer fence" })));
        return lease;
      })));
    const run = watchNetworkMailbox({ mailbox: options.mailbox, acquire, afterSeq }).pipe(Stream.runForEach(batch => Effect.gen(function* () {
      for (const event of batch.events) {
        if (event.$type !== "sh.mschf.ratking.defs#messageEvent" || !isMessage(event)) continue;
        const opened = yield* (options.open ?? options.mailbox.open)(event.envelope).pipe(Effect.mapError(failure));
        if (opened.tid !== event.receipt.message.messageId || opened.senderDid !== event.receipt.message.senderDid) return yield* Effect.fail(new CommsError("NetworkComms receipt differs from authenticated envelope"));
        const payload = yield* Effect.try({ try: () => decodeNetworkPayload(JSON.parse(opened.body)), catch: failure });
        if (payload.recipient !== options.session) return yield* Effect.fail(new CommsError("NetworkComms recipient session changed; refusing stale delivery"));
        const author = payload.type === "owner" ? payload.item.author : payload.author;
        const agent = yield* options.senderAgent(author);
        if (networkRecipient(options.home, agent).did !== opened.senderDid) return yield* Effect.fail(new CommsError("NetworkComms authenticated sender differs from payload author"));
        yield* options.receive(payload);
        if (!fence) return yield* Effect.fail(failure());
        const delivery = { message: event.receipt.message, leaseId: fence.leaseId, generation: fence.generation };
        yield* options.mailbox.deliver(delivery).pipe(Effect.mapError(failure));
        yield* options.mailbox.ack(delivery).pipe(Effect.mapError(failure));
      }
      // The consumer runs off a poll: never block the event loop on a stalled rename (Pi Freeze, 2026-10-06).
      yield* Effect.tryPromise({ try: async () => {
        await mkdir(dirname(cursorPath), { recursive: true, mode: 0o700 });
        const temp = `${cursorPath}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ [options.agent]: batch.throughSeq }), { mode: 0o600 }); await rename(temp, cursorPath);
      }, catch: failure });
    })), Effect.mapError(error => "error" in error && error.error === "AuthRequired" ? new CommsError("NetworkComms authentication failed; consumer stopped") : error instanceof CommsError ? error : failure()));
    return yield* Effect.ensuring(run, Effect.suspend(() => {
      if (!fence) return Effect.void;
      const retired = fence;
      const path = networkFencePath(options.home, ownDid);
      return Effect.acquireUseRelease(acquireFenceLock(`${path}.lock`), lock => Effect.tryPromise({ try: async () => {
        const current = readConsumerFence(options.home, ownDid);
        // Serialize with publishers: an old consumer cannot retire a newer registration.
        if (ownsFenceLock(lock) && current?.leaseId === retired.leaseId && current.generation === retired.generation) await unlink(path);
      }, catch: failure }), releaseFenceLock).pipe(Effect.ignore, Effect.ensuring(options.mailbox.lease.release(retired).pipe(Effect.timeout("5 seconds"), Effect.ignore)));
    }));
  });
}

export function createNetworkComms(options: {
  home: string;
  sender: () => { agent: string; session: string } | undefined;
  recipient: (to: CommsTarget) => Effect.Effect<string, CommsError>;
  run?: PrivateCommand;
  configPath?: string;
  session?: (to: CommsTarget) => Effect.Effect<string, CommsError>;
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
      const service = yield* mailbox;
      return yield* consumeNetworkMailbox({ home: options.home, agent: sender.agent, session: sender.session, mailbox: service,
        senderAgent: author => options.recipient(author), receive,
        // Static client documents are snapshots. New workers provision after the desk starts.
        open: envelope => mailbox.pipe(Effect.flatMap(fresh => fresh.open(envelope)), Effect.mapError(() => new CommsError("NetworkComms envelope authentication failed"))),
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
