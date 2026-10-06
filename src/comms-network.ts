import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { decodeAgentName, decodeCommsIdentityCache, decodeCommsIdentityReference, decodeNetworkCommsConfig, type CommsIdentityReference } from "./domain.ts";
import { CommsError, Unsupported, type CommsShape, type CommsTarget } from "./runtime.ts";
import type { Batch, LeaseFence } from "./vendor/rat-king-mailbox-client/index.ts";

export const networkConfigPath = (home: string) => join(home, ".config/muster/network.json");
export const networkIdentityPath = (home: string) => join(home, ".local/state/muster/network-identities.json");

function privateJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new CommsError(`NetworkComms requires an owned 0600 regular file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}
export function readNetworkConfig(home: string) {
  const path = networkConfigPath(home);
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
export function provisionNetworkAgent(options: { home: string; agent: string; run?: PrivateCommand }): Effect.Effect<CommsIdentityReference, CommsError> {
  return Effect.tryPromise({
    try: async () => {
      const agent = decodeAgentName(options.agent);
      const config = readNetworkConfig(options.home);
      const path = networkIdentityPath(options.home);
      const did = config.didTemplate.replace("{agent}", agent);
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
          reference = decodeCommsIdentityReference(JSON.parse(await (options.run ?? privateCommand)(config.provisionWrapper, ["provision", "--agent", agent, "--did", did])));
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

export function networkRecipient(home: string, agent: string): CommsIdentityReference {
  const reference = readNetworkIdentities(home)[decodeAgentName(agent)];
  if (!reference) throw new CommsError(`NetworkComms unknown recipient: ${agent}; provision it first`);
  return reference;
}

export type WatchRecovery = "reacquire" | "stop" | "backoff";
export function watchCloseAction(code: number): WatchRecovery {
  switch (code) {
    case 4409: return "reacquire";
    case 4408: case 1000: case 1006: case 1012: return "backoff";
    case 4401: default: return "stop";
  }
}

/** No client code is loaded until this effect runs on an opted-in project. */
export function openNetworkMailbox(options: { home: string; agent: string; run?: PrivateCommand }) {
  return Effect.gen(function* () {
    const config = yield* Effect.try({ try: () => readNetworkConfig(options.home), catch: error => error instanceof CommsError ? error : new CommsError("NetworkComms config invalid") });
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

export function createNetworkComms(options: {
  home: string;
  sender: () => { agent: string; session: string } | undefined;
  recipient: (to: CommsTarget) => Effect.Effect<string, CommsError>;
  run?: PrivateCommand;
}): CommsShape {
  const mailbox = Effect.suspend(() => {
    const sender = options.sender();
    if (!sender) return Effect.fail(new CommsError("NetworkComms sender context missing; agent and session required"));
    return openNetworkMailbox({ ...options, agent: sender.agent });
  });
  const recipient = (to: CommsTarget) => options.recipient(to).pipe(Effect.flatMap(agent => Effect.try({ try: () => networkRecipient(options.home, agent), catch: error => error instanceof CommsError ? error : new CommsError("NetworkComms recipient invalid") })));
  return {
    send: (to, message) => Effect.gen(function* () {
      const target = yield* recipient(to);
      const service = yield* mailbox;
      const result = yield* service.send(target.did, message);
      const { receiptDelivery } = yield* Effect.promise(() => import("./comms.ts"));
      return yield* receiptDelivery(result.receipt);
    }).pipe(Effect.catch(error => Effect.succeed({ status: "failed" as const, detail: error instanceof CommsError ? error.message : "NetworkComms send failed (private output withheld)" }))),
    resolve: to => Effect.gen(function* () {
      const target = yield* recipient(to);
      const service = yield* mailbox;
      const lease = yield* service.lease.resolve(target.did).pipe(Effect.mapError(() => new CommsError("NetworkComms lease resolution failed")));
      const session = lease.harness.sessionId;
      if (lease.harness.$type !== "sh.mschf.ratking.runtime.lease#pi" || typeof session !== "string" || !session) return yield* Effect.fail(new Unsupported("NetworkComms recipient has no Pi session"));
      return { address: { kind: "did" as const, did: `did:${target.did.slice(4)}` }, session, expiresAt: lease.expiresAt };
    }),
    ask: () => Effect.fail(new Unsupported("NetworkComms ask requires the mailbox consumer (slice 2)")),
    reply: () => Effect.fail(new Unsupported("NetworkComms reply requires the mailbox consumer (slice 2)")),
    wake: () => Effect.succeed({ woke: false, reason: "NetworkComms wake requires the mailbox consumer (slice 2)" }),
    sessions: () => Effect.succeed(undefined),
  };
}
