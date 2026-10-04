import { Effect, Layer } from "effect";
import { decodeAgentName, decodeSlug, type Policy } from "./domain.ts";
import { createIntercom } from "./intercom.ts";
import { readRegistry } from "./registry.ts";
import { exists, load } from "./store.ts";
import { Comms, CommsError, Unsupported, type CommsAddress, type CommsDelivery, type CommsLease, type CommsShape, type CommsTarget, type IntercomTransport } from "./runtime.ts";

export type CommsAdapter = "intercom" | "network";
export function selectComms(env: string | undefined, policy?: Pick<Policy, "comms">): CommsAdapter {
  const selected = env ?? policy?.comms ?? "intercom";
  if (selected !== "intercom" && selected !== "network") throw new CommsError(`invalid MUSTER_COMMS: ${selected}; expected intercom or network`);
  return selected;
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

const networkError = () => new Unsupported("NetworkComms is not implemented; delivery refused (no fallback to intercom)");
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
export function createComms(options: { events: Parameters<typeof createIntercom>[0]; createId: () => string; home: string; projectDir: string; adapterEnv: () => string | undefined }) {
  let transport: ReturnType<typeof createIntercom> | undefined;
  const project = (dir: string) => load(dir).pipe(Effect.mapError(error => new CommsError(error.message)));
  const lookup: Parameters<typeof IntercomComms>[1] = address => Effect.gen(function* () {
    const known = yield* Effect.try({ try: () => readRegistry(options.home).get(address.project), catch: error => new CommsError(`catalog registry unreadable: ${String(error)}`) });
    const catalog = yield* project(known?.dir ?? options.projectDir);
    if (catalog.slug !== address.project) return yield* Effect.fail(new CommsError(`unknown project alias: ${address.project}`));
    const row = catalog.agents.find(row => row.name === address.row);
    if (!row) return yield* Effect.fail(new CommsError(`unknown agent alias: ${address.project}/${address.row}`));
    return row.sessionId;
  });
  const adapter = Effect.gen(function* () {
    const env = options.adapterEnv();
    // An explicit override must not depend on a readable project catalog.
    const policy = env === undefined && exists(options.projectDir) ? (yield* project(options.projectDir)).policy : undefined;
    const selected = yield* Effect.try({ try: () => selectComms(env, policy), catch: error => new CommsError(String(error)) });
    if (selected === "network") return NetworkComms;
    transport ??= createIntercom(options.events, options.createId);
    return IntercomComms(transport, lookup);
  });
  const service: CommsShape = {
    send: (to, message) => adapter.pipe(Effect.flatMap(service => service.send(to, message)), Effect.catchCause(cause => Effect.succeed<CommsDelivery>({ status: "failed", detail: String(cause) }))),
    ask: (to, message, opts) => adapter.pipe(Effect.flatMap(service => service.ask(to, message, opts))),
    reply: (id, message) => adapter.pipe(Effect.flatMap(service => service.reply(id, message))),
    wake: to => adapter.pipe(Effect.flatMap(service => service.wake(to))),
    resolve: identity => adapter.pipe(Effect.flatMap(service => service.resolve(identity))),
    sessions: () => adapter.pipe(Effect.flatMap(service => service.sessions())),
  };
  return { ...service, dispose: () => { transport?.dispose(); transport = undefined; } };
}
