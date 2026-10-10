import { Effect, Layer, Schema } from "effect";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { decodeAgentName, decodeSlug, decodeProject, decodeSessionSuccessor, type SessionSuccessor, type Policy } from "./domain.ts";
import { networkCatalogPeer, networkCatalogPeers, networkRowIdentity, networkTargetRow } from "./desk-route.ts";
import { createIntercom } from "./intercom.ts";
import { readRegistry } from "./registry.ts";
import { exists, load, projectPath } from "./store.ts";
import { Comms, CommsError, Unsupported, type CommsAddress, type CommsDelivery, type CommsLease, type CommsShape, type CommsTarget, type IntercomTransport, type LeaseAuthorityShape, type NetworkMailboxShape } from "./runtime.ts";
import type { MainValue as Lease } from "./vendor/rat-king-lexicon/runtime.lease.ts";
import type { ReceiptValue as Receipt } from "./vendor/rat-king-lexicon/defs.ts";

export const sessionSuccessorsPath = (home: string) => join(home, ".local/state/muster/session-successors.jsonl");

/** Call only after the catalog commits. Same-id restores are not retirements. */
export function recordSessionSuccessor(home: string, value: SessionSuccessor): void {
  const record = decodeSessionSuccessor(value);
  if (record.from === record.to) return;
  const path = sessionSuccessorsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Exact ids only: aliases must keep following the authoritative row. */
export function retiredSessionReason(home: string, to: string): string | undefined {
  if (to.includes("/") || to.startsWith("did:")) return undefined;
  let contents: string;
  try { contents = readFileSync(sessionSuccessorsPath(home), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CommsError("session successor history unreadable; send refused");
  }
  let match: SessionSuccessor | undefined;
  for (const line of contents.split("\n").filter(line => line.trim())) {
    let record: SessionSuccessor;
    try { record = decodeSessionSuccessor(JSON.parse(line)); }
    catch { throw new CommsError("session successor history invalid; send refused"); }
    if (record.to === to) match = undefined; // A restore can revive a previously retired id.
    else if (record.from === to) match = record;
  }
  return match ? `session ${match.from} retired by restart; successor ${match.to}; send to ${match.project}/${match.row} or the new id` : undefined;
}

function readSuccessors(home: string): SessionSuccessor[] {
  let contents: string;
  try { contents = readFileSync(sessionSuccessorsPath(home), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return contents.split("\n").filter(line => line.trim()).map(line => decodeSessionSuccessor(JSON.parse(line)));
}

/** The session a retired id continues as now, following restart hops; undefined for a live or unknown id.
 * Unreadable history answers undefined: callers then keep their refusal. */
export function currentSuccessor(home: string, id: string): string | undefined {
  let records: SessionSuccessor[];
  try { records = readSuccessors(home); } catch { return undefined; }
  let current = id;
  const seen = new Set([id]);
  for (let hop = 0; hop < 16; hop++) {
    let next: string | undefined;
    // The latest record wins: a restore that revives an id clears its earlier retirement.
    for (const record of records) { if (record.to === current) next = undefined; else if (record.from === current) next = record.to; }
    if (next === undefined) return current === id ? undefined : current;
    if (seen.has(next)) return undefined;
    seen.add(next); current = next;
  }
  return undefined;
}

/** True when `candidate` is a recorded predecessor of `session`: mail addressed to it belongs to `session`. */
export const isPredecessorSession = (home: string, candidate: string, session: string) => candidate !== session && currentSuccessor(home, candidate) === session;

/** The session id a fork's parent journal names in its header, or undefined. A restart fork's parent is its predecessor. */
export function forkParentSession(header: { parentSession?: string } | null | undefined): string | undefined {
  const path = header?.parentSession;
  if (!path) return undefined;
  try {
    const first = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0] ?? "") as { type?: unknown; id?: unknown };
    return first.type === "session" && typeof first.id === "string" && first.id ? first.id : undefined;
  } catch { return undefined; }
}

/** A retired session signs as the row its successor now holds, so a self-restart's own handover has a sender. */
export function successorRowSender(dir: string, session: string, home: string) {
  const successor = currentSuccessor(home, session);
  const row = successor ? catalogCommsSender(dir, successor) : undefined;
  return row ? { agent: row.agent, session } : undefined;
}

export function assertCurrentSession(home: string, to: CommsTarget): void {
  const address = commsAddress(to);
  if (address.kind !== "session") return;
  const reason = retiredSessionReason(home, address.id);
  if (reason) throw new CommsError(reason);
}

/** Session context is resolved at use time; no arbitrary desk identity fallback. */
export function catalogCommsSender(dir: string, session: string) {
  try {
    const project = decodeProject(JSON.parse(readFileSync(projectPath(dir), "utf8")));
    const row = project.agents.find(row => row.sessionId === session);
    return row ? { agent: networkRowIdentity(project, row), session } : undefined;
  } catch { return undefined; }
}
/** True when this catalog's row `name` now belongs to another session: the caller is a retired predecessor. */
export function retiredCatalogSession(dir: string, name: string, session: string): boolean {
  try {
    const row = decodeProject(JSON.parse(readFileSync(projectPath(dir), "utf8"))).agents.find(row => row.name === name);
    return row !== undefined && row.sessionId !== session;
  } catch { return false; }
}
/** Decoded policies default comms to intercom; only the raw catalog tells an explicit choice from an unset one. */
export function explicitPolicyComms(dir: string): "intercom" | "network" | undefined {
  try {
    const comms = (JSON.parse(readFileSync(projectPath(dir), "utf8")) as { policy?: { comms?: unknown } }).policy?.comms;
    return comms === "intercom" || comms === "network" ? comms : undefined;
  } catch { return undefined; }
}
export function catalogNetworkPeers(dir: string) {
  const project = decodeProject(JSON.parse(readFileSync(projectPath(dir), "utf8")));
  return Object.fromEntries(project.agents.map(row => [row.sessionId, networkRowIdentity(project, row)]));
}

/** A launch hint only: selection follows the joined fact, which this value never overrides back to intercom. */
export function remoteCommsEnvironment(project: Pick<import("./domain.ts").Project, "policy">, machine: Pick<import("./domain.ts").MachineConfig, "comms">): Record<string, string> {
  if (project.policy?.comms === "ratking") return { MUSTER_COMMS: "ratking" };
  if (project.policy?.comms !== "network") return { MUSTER_COMMS: "intercom" };
  if (!machine.comms) throw new CommsError("network project requires a remote comms config block; launch refused");
  return { MUSTER_COMMS: "network", MUSTER_NETWORK_CONFIG: machine.comms.config };
}

export type CommsAdapter = "intercom" | "network";
export function selectComms(env: string | undefined, policy?: Pick<Policy, "comms">): CommsAdapter {
  const selected = env ?? policy?.comms ?? "intercom";
  if (selected !== "intercom" && selected !== "network" && selected !== "ratking") throw new CommsError(`invalid MUSTER_COMMS: ${selected}; expected intercom, network or ratking`);
  // ratking rides pi-ratking when it is loaded (createComms); a Pi without it keeps today's intercom path.
  return selected === "ratking" ? "intercom" : selected;
}

export function commsAddress(identity: CommsTarget): CommsAddress {
  if (typeof identity !== "string") {
    if (identity.kind === "alias") { decodeSlug(identity.project); decodeAgentName(identity.row); }
    if (identity.kind === "did" && !identity.did.startsWith("did:")) throw new CommsError("invalid DID");
    return identity;
  }
  if (identity.startsWith("did:")) return { kind: "did", did: `did:${identity.slice(4)}` };
  if (identity.includes("/")) {
    const [project, row, extra] = identity.split("/");
    if (!project || !row || extra !== undefined) throw new CommsError(`invalid Muster alias: ${identity}`);
    return { kind: "alias", project: decodeSlug(project), row: decodeAgentName(row) };
  }
  return { kind: "session", id: identity };
}

/** Only metadata crosses this seam. Message bodies are passed through untouched. */
export function IntercomComms(transport: IntercomTransport, lookup: (address: Extract<CommsAddress, { kind: "alias" }>) => Effect.Effect<string, CommsError>): CommsShape {
  const resolve = (identity: CommsTarget): Effect.Effect<CommsLease, CommsError> => Effect.gen(function* () {
    const address = yield* Effect.try({ try: () => commsAddress(identity), catch: error => new CommsError(String(error)) });
    if (address.kind === "did") return yield* Effect.fail(new Unsupported("IntercomComms cannot resolve a DID"));
    const session = address.kind === "alias" ? yield* lookup(address) : address.id;
    return { address, session };
  });
  return {
    resolve,
    send: (to, message) => resolve(to).pipe(
      Effect.flatMap(lease => transport.send(lease.session, message)),
      Effect.map(result => ({ ...result, status: result.status === "sent" ? "delivered" as const : result.status === "queued" ? "queued" as const : "failed" as const })),
      Effect.catchCause(cause => Effect.succeed({ status: "failed" as const, detail: String(cause) })),
    ),
    ask: () => Effect.fail(new Unsupported("IntercomComms ask is unsupported by the consent-aware outbox")),
    reply: () => Effect.fail(new Unsupported("IntercomComms reply is unsupported by the consent-aware outbox")),
    wake: () => Effect.succeed({ woke: false, reason: "intercom has no wake" }),
    sessions: transport.sessions,
  };
}

/** Unknown knownValues remain valid on the wire, but cannot prove delivery. */
export function receiptDelivery(receipt: Receipt): Effect.Effect<CommsDelivery, Unsupported> {
  switch (receipt.state) {
    case "accepted": case "queued": case "delivered": case "acked": case "expired": case "failed":
      return Effect.succeed({ status: receipt.state, ...(receipt.detail === undefined ? {} : { detail: receipt.detail }) });
    default: return Effect.fail(new Unsupported(`unsupported Rat King receipt state: ${receipt.state}`));
  }
}

const networkError = () => new Unsupported("NetworkComms requires the configured call-time adapter; delivery refused (no fallback to intercom)");
export const LeaseAuthority: LeaseAuthorityShape = {
  acquire: () => Effect.fail(networkError()),
  resolve: () => Effect.fail(networkError()),
  release: () => Effect.fail(networkError()),
};
export const NetworkMailbox: NetworkMailboxShape = {
  send: () => Effect.fail(networkError()),
  ack: () => Effect.fail(networkError()),
  list: () => Effect.fail(networkError()),
};

export type HarnessSessionAdapter = (lease: Lease) => Effect.Effect<string, CommsError>;
/** An adapter must explicitly resolve a session; paneId is never a session or identity. */
export function leaseToComms(lease: Lease, adapters: Readonly<Record<string, HarnessSessionAdapter>> = {}): Effect.Effect<CommsLease, CommsError> {
  const adapter = Object.hasOwn(adapters, lease.harness.$type) ? adapters[lease.harness.$type] : undefined;
  if (!adapter) return Effect.fail(new Unsupported(`unsupported Rat King harness: ${lease.harness.$type}`));
  return adapter(lease).pipe(Effect.flatMap(session => session.length === 0
    ? Effect.fail(new Unsupported("Rat King adapter did not resolve a session"))
    : Effect.succeed({ address: { kind: "did" as const, did: `did:${lease.did.slice(4)}` }, session, expiresAt: lease.expiresAt })));
}
/** Explicit lease-authority seam; the configured pilot adapter uses the vendored client. */
export function resolveNetworkAddress(identity: CommsTarget, options: {
  readonly localDid: (address: Exclude<CommsAddress, { kind: "did" }>) => Effect.Effect<Lease["did"], CommsError>;
  readonly authority: LeaseAuthorityShape;
  readonly adapters: Readonly<Record<string, HarnessSessionAdapter>>;
}): Effect.Effect<CommsLease, CommsError> {
  return Effect.gen(function* () {
    const address = yield* Effect.try({ try: () => commsAddress(identity), catch: error => new CommsError(String(error)) });
    // A local address is not a branded Lexicon DID. Decode at this network-only
    // boundary; loading the generated validators must never affect startup.
    const did = address.kind === "did" ? yield* Effect.tryPromise({
      try: async () => {
        const { Main } = await import("./vendor/rat-king-lexicon/runtime.lease.ts");
        return Schema.decodeUnknownSync(Main.schema.fields.did)(address.did);
      },
      catch: error => new CommsError(`invalid Rat King DID: ${String(error)}`),
    }) : yield* options.localDid(address);
    const lease = yield* options.authority.resolve(did);
    if (lease.did !== did) return yield* Effect.fail(new CommsError("Rat King authority returned a lease for another DID"));
    return yield* leaseToComms(lease, options.adapters);
  });
}
export const NetworkComms: CommsShape = {
  send: () => Effect.succeed({ status: "failed", detail: networkError().message }),
  ask: () => Effect.fail(networkError()),
  reply: () => Effect.fail(networkError()),
  wake: () => Effect.fail(networkError()),
  resolve: () => Effect.fail(networkError()),
  sessions: () => Effect.fail(networkError()),
};
export const IntercomCommsLayer = (transport: IntercomTransport, lookup: Parameters<typeof IntercomComms>[1]) => Layer.succeed(Comms)(IntercomComms(transport, lookup));
export const NetworkCommsLayer = Layer.succeed(Comms)(NetworkComms);

/** Called by tools, never at extension startup. Re-read policy and catalog at operation time. */
export function createComms(options: { deskRecord?: import("./comms-network.ts").NetworkRecordHandler; events: Parameters<typeof createIntercom>[0]; createId: () => string; home: string; projectDir: string; adapterEnv: () => string | undefined; followProjectPolicy?: boolean; networkConfig?: () => string | undefined; networkPeers?: () => Readonly<Record<string, string>>; networkSender?: () => { agent: string; session: string } | undefined;
  /** This process runs on a remote machine: it never mints, and it joins only on a key Flagg pushed here. */
  remote?: boolean; run?: import("./comms-network.ts").PrivateCommand;
  /** The session this one was forked from (a restart fork's parent): mail addressed to it is this session's. */
  forkParent?: () => string | undefined;
  /** pi-ratking's transport when it is loaded in this Pi and MUSTER_COMMS=ratking opts in. It then carries every send; the network module only drains. */
  ratking?: () => CommsShape | undefined }) {
  let transport: ReturnType<typeof createIntercom> | undefined;
  // A join, once seen, holds for this process. A miss is rechecked after 20 s: the key check spawns the secrets CLI.
  const joins = new Map<string, { joined: boolean; at: number }>();
  const joinedFact = Effect.gen(function* () {
    const sender = options.networkSender?.();
    if (!sender) return false;
    // Flagg's catalog is authoritative: an explicit intercom opts out, and only network projects or desks join.
    // A remote copy of the catalog is not, so Flagg's policy reaches remote rows only through the key it pushes.
    if (!options.remote) {
      const explicit = exists(options.projectDir) ? explicitPolicyComms(options.projectDir) : undefined;
      if (explicit === "intercom" || (explicit !== "network" && !sender.agent.includes("/"))) return false;
    }
    const key = `${sender.agent}\0${sender.session}`;
    const seen = joins.get(key);
    if (seen && (seen.joined || Date.now() - seen.at < 20_000)) return seen.joined;
    const network = yield* Effect.tryPromise({ try: () => import("./comms-network.ts"), catch: () => new CommsError("NetworkComms adapter unavailable") });
    // An older sibling module on disk has no join facts: stay on the launch hint.
    const join = yield* Effect.try({ try: () => network.localJoinFacts, catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined));
    if (typeof join !== "function") return false;
    const facts = yield* Effect.promise(() => join({ home: options.home, agent: sender.agent, session: sender.session, remote: options.remote === true,
      ...(options.networkConfig?.() ? { configPath: options.networkConfig()! } : {}), ...(options.run ? { run: options.run } : {}) }));
    // Only the secrets listing costs a process; file-only misses are rechecked every time.
    if (facts.joined || facts.key === false) joins.set(key, { joined: facts.joined, at: Date.now() });
    return facts.joined;
  });
  const project = (dir: string) => load(dir).pipe(Effect.mapError(error => new CommsError(error.message)));
  const lookup: Parameters<typeof IntercomComms>[1] = address => Effect.gen(function* () {
    const known = yield* Effect.try({ try: () => readRegistry(options.home).get(address.project), catch: error => new CommsError(`catalog registry unreadable: ${String(error)}`) });
    const catalog = yield* project(known?.dir ?? options.projectDir);
    if (catalog.slug !== address.project) return yield* Effect.fail(new CommsError(`unknown project alias: ${address.project}`));
    const row = catalog.agents.find(row => row.name === address.row);
    if (!row) return yield* Effect.fail(new CommsError(`unknown agent alias: ${address.project}/${address.row}`));
    return row.intercomAddress ?? row.sessionId;
  });
  const selection = Effect.gen(function* () {
    // A launch's MUSTER_COMMS is a hint: it never overrides a joined fact back to intercom.
    if (yield* joinedFact) return "network" as const;
    const env = options.adapterEnv();
    // An explicit override must not depend on a readable project catalog.
    const follow = env === "network" && options.followProjectPolicy && exists(options.projectDir);
    const policy = (env === undefined || follow) && exists(options.projectDir) ? (yield* project(options.projectDir)).policy : undefined;
    // Following policy lets an explicit project opt-out win; an unset policy never overrides explicit env.
    const fromEnv = follow ? (explicitPolicyComms(options.projectDir) === undefined ? env : undefined) : env;
    const selected = yield* Effect.try({ try: () => selectComms(fromEnv, policy?.comms === undefined && options.networkSender?.()?.agent.includes("/") ? { ...policy, comms: "network" } : policy), catch: error => new CommsError(String(error)) });
    return selected;
  });
  const adapter = Effect.gen(function* () {
    const selected = yield* selection;
    if (selected === "network") {
      const network = yield* Effect.tryPromise({ try: () => import("./comms-network.ts"), catch: () => new CommsError("NetworkComms adapter unavailable") });
      yield* Effect.try({ try: () => network.readNetworkConfig(options.home, options.networkConfig?.()), catch: error => error instanceof CommsError ? error : new CommsError("NetworkComms config invalid") });
      const configuredPeers = options.networkPeers?.() ?? {};
      yield* Effect.try({ try: () => network.seedNetworkPeers(options.home, configuredPeers), catch: () => new CommsError("NetworkComms peer cache unavailable") });
      const recipient = (to: CommsTarget) => Effect.gen(function* () {
          const address = yield* Effect.try({ try: () => commsAddress(to), catch: () => new CommsError("NetworkComms invalid recipient") });
          // Identity on demand: Flagg mints an addressed row before the first send, or the send fails. Never the bare refusal.
          const minted = (identity: string) => Effect.gen(function* () {
            if (options.remote || address.kind === "did") return identity;
            const cached = yield* Effect.try({ try: () => network.readNetworkIdentities(options.home)[identity], catch: () => new CommsError("NetworkComms identity cache invalid") });
            if (cached) return identity;
            const target = networkTargetRow(options.home, options.projectDir, address.kind === "alias" ? `${address.project}/${address.row}` : address.id);
            if (!target || target.identity !== identity) return identity;
            yield* network.provisionPreflipRow({ home: options.home, target, ...(options.run ? { run: options.run } : {}) }).pipe(
              Effect.mapError(error => new CommsError(`NetworkComms could not mint ${identity} before the first send: ${error.message}; nothing sent, no intercom fallback`)));
            return identity;
          });
          if (address.kind === "alias") {
            // Validate project ownership before trusting a qualified cache key.
            yield* lookup(address);
            const known = readRegistry(options.home).get(address.project);
            const catalog = yield* project(known?.dir ?? options.projectDir);
            const row = catalog.agents.find(row => row.name === address.row);
            if (!row) return yield* Effect.fail(new CommsError("NetworkComms unknown alias"));
            return yield* minted(networkRowIdentity(catalog, row));
          }
          if (address.kind === "did") {
            const cache = yield* Effect.try({ try: () => network.readNetworkIdentities(options.home), catch: () => new CommsError("NetworkComms identity cache invalid") });
            const agent = Object.entries(cache).find(([, entry]) => entry.did === address.did)?.[0];
            if (!agent) return yield* Effect.fail(new CommsError(`NetworkComms unknown recipient: ${address.did}`));
            return agent;
          }
          const peer = yield* Effect.try({ try: () => exists(options.projectDir) ? networkCatalogPeer(options.home, options.projectDir, address.id) : undefined, catch: error => error instanceof CommsError ? error : new CommsError("NetworkComms local catalog invalid") });
          if (peer) return yield* minted(peer);
          const configuredPeer = options.networkPeers?.()[address.id];
          if (configuredPeer?.includes("/")) return configuredPeer;
          const deskPeer = yield* Effect.try({ try: () => network.readNetworkPeers(options.home)[address.id], catch: () => new CommsError("NetworkComms peer cache invalid") });
          if (deskPeer) return deskPeer;
          if (configuredPeer) return configuredPeer;
          const catalog = yield* project(options.projectDir);
          const row = catalog.agents.find(row => row.sessionId === address.id || row.intercomAddress === address.id || row.name === address.id);
          if (!row) return yield* Effect.fail(new CommsError(`NetworkComms unknown recipient: ${address.id}`));
          return yield* minted(networkRowIdentity(catalog, row));
        });
      /** Identities some row holds. A rowless author may never claim one: rows bind to their sessions. */
      const rowIdentities = () => {
        const rows = new Set<string>([...Object.values(options.networkPeers?.() ?? {}), ...Object.values(network.readNetworkPeers(options.home))]);
        if (exists(options.projectDir)) for (const identity of Object.values(networkCatalogPeers(options.home, options.projectDir))) rows.add(identity);
        return rows;
      };
      return network.createNetworkComms({
        home: options.home,
        configPath: options.networkConfig?.(),
        deskRecord: options.deskRecord,
        ...(options.run ? { run: options.run } : {}),
        // A recorded predecessor of this session, or the session it was forked from, addresses this session.
        accepts: (addressed, session) => addressed === session || isPredecessorSession(options.home, addressed, session) || options.forkParent?.() === addressed,
        succeededBy: (addressed, session) => isPredecessorSession(options.home, session, addressed),
        // Catalog peers first; then a predecessor speaks as its successor's row; then a rowless agent (a
        // MUSTER_AGENT owner) whose authenticated DID is its own cached identity.
        author: (author, senderDid) => recipient(author).pipe(Effect.catch(error => Effect.gen(function* () {
          const successor = currentSuccessor(options.home, author);
          if (successor) return yield* recipient(successor);
          const rowless = yield* Effect.try({ try: () => {
            const named = Object.entries(network.readNetworkIdentities(options.home)).find(([, entry]) => entry.did === senderDid)?.[0];
            return named && !rowIdentities().has(named) ? named : undefined;
          }, catch: () => new CommsError("NetworkComms identity cache invalid") });
          if (rowless) return rowless;
          return yield* Effect.fail(error);
        }))),
        session: to => Effect.gen(function* () {
          const address = yield* Effect.try({ try: () => commsAddress(to), catch: () => new CommsError("NetworkComms invalid recipient") });
          if (address.kind === "alias") {
            const known = yield* Effect.try({ try: () => readRegistry(options.home).get(address.project), catch: () => new CommsError("NetworkComms registry unreadable") });
            const catalog = yield* project(known?.dir ?? options.projectDir);
            const row = catalog.slug === address.project ? catalog.agents.find(row => row.name === address.row) : undefined;
            if (!row) return yield* Effect.fail(new CommsError(`NetworkComms unknown recipient: ${address.project}/${address.row}`));
            return row.sessionId;
          }
          if (address.kind === "session") {
            const catalog = yield* project(options.projectDir).pipe(Effect.option);
            const row = catalog._tag === "Some" ? catalog.value.agents.find(row => row.sessionId === address.id || row.intercomAddress === address.id || row.name === address.id) : undefined;
            if (row) return row.sessionId;
            const peers = options.networkPeers?.() ?? {};
            return Object.entries(peers).find(([session, agent]) => session === address.id || agent === address.id)?.[0] ?? address.id;
          }
          return yield* Effect.fail(new Unsupported("NetworkComms direct DID send needs a recipient session"));
        }),
        sender: () => {
          const sender = options.networkSender?.();
          if (!sender) return undefined;
          // Catalog binding wins over a launch environment's legacy bare name.
          return catalogCommsSender(options.projectDir, sender.session) ?? sender;
        },
        recipient,
      });
    }
    transport ??= createIntercom(options.events, options.createId);
    return IntercomComms(transport, lookup);
  });
  const current = (to: CommsTarget) => Effect.try({ try: () => assertCurrentSession(options.home, to), catch: error => error instanceof CommsError ? error : new CommsError(String(error)) });
  const ratking = options.adapterEnv() === "ratking" ? options.ratking?.() : undefined;
  if (ratking) {
    // The legacy consumer drains an existing legacy identity only; it never mints one or reads the ratking name.
    const legacyDrain = () => joinedFact;
    const shaped: CommsShape = {
      ...ratking,
      legacyDrain,
      send: (to, message) => current(to).pipe(Effect.flatMap(() => ratking.send(to, message)), Effect.catch(error => Effect.succeed<CommsDelivery>({ status: "failed", detail: `NOT DELIVERED: ${error.message} (ratking; no fallback)` }))),
      postOwner: (to, item) => current(to).pipe(Effect.flatMap(() => ratking.postOwner ? ratking.postOwner(to, item) : Effect.succeed<CommsDelivery>({ status: "failed", detail: "ratking owner transport unavailable" })), Effect.catch(error => Effect.succeed<CommsDelivery>({ status: "failed", detail: `NOT DELIVERED: ${error.message} (ratking; no fallback)` }))),
      consume: receive => joinedFact.pipe(Effect.flatMap(joined => joined ? adapter.pipe(Effect.flatMap(service => service.consume ? service.consume(receive) : Effect.void)) : Effect.void)),
    };
    return { ...shaped, dispose: () => { transport?.dispose(); transport = undefined; },
      rejoin: () => { for (const [key, seen] of joins) if (!seen.joined) joins.delete(key); } };
  }
  const service: CommsShape = {
    relay: (to, message) => current(to).pipe(Effect.flatMap(() => Effect.suspend(() => {
      transport ??= createIntercom(options.events, options.createId);
      return IntercomComms(transport, lookup).send(to, message);
    })), Effect.catch(error => Effect.succeed<CommsDelivery>({ status: "failed", detail: error.message }))),
    mode: () => selection.pipe(Effect.flatMap(selected => selected === "intercom" ? Effect.succeed("intercom" as const) : adapter.pipe(Effect.flatMap(service => service.mode ? service.mode() : Effect.succeed("network" as const))))),
    postOwner: (to, item) => current(to).pipe(Effect.flatMap(() => adapter), Effect.flatMap(service => service.postOwner ? service.postOwner(to, item) : Effect.succeed<CommsDelivery>({ status: "failed", detail: "owner mailbox not selected" })), Effect.catch(error => Effect.succeed<CommsDelivery>({ status: "failed", detail: error.message }))),
    consume: receive => adapter.pipe(Effect.flatMap(service => service.consume ? service.consume(payload => adapter.pipe(Effect.flatMap(current => current.consume ? receive(payload) : Effect.fail(new CommsError("NetworkComms disabled by project policy; consumer stopped"))))) : Effect.void)),
    send: (to, message) => current(to).pipe(Effect.flatMap(() => adapter), Effect.flatMap(service => service.send(to, message)), Effect.catchCause(cause => Effect.succeed<CommsDelivery>({ status: "failed", detail: String(cause) }))),
    ask: (to, message, opts) => current(to).pipe(Effect.flatMap(() => adapter), Effect.flatMap(service => service.ask(to, message, opts))),
    reply: (id, message) => adapter.pipe(Effect.flatMap(service => service.reply(id, message))),
    wake: to => current(to).pipe(Effect.flatMap(() => adapter), Effect.flatMap(service => service.wake(to))),
    resolve: identity => current(identity).pipe(Effect.flatMap(() => adapter), Effect.flatMap(service => service.resolve(identity))),
    sessions: () => adapter.pipe(Effect.flatMap(service => service.sessions())),
  };
  return { ...service, dispose: () => { transport?.dispose(); transport = undefined; },
    /** Forget join misses: a fix or a policy flip takes effect on the next selection, not after the 20 s recheck. */
    rejoin: () => { for (const [key, seen] of joins) if (!seen.joined) joins.delete(key); } };
}
