// slice B: the phone record API has not landed yet. This is the only legacy client caller.
// No provisioning, remote keys, peer writers or consumer startup. Remove with the phone port.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { decodeCommsIdentityCache, decodeNetworkCommsConfig, decodeNetworkSendFence } from "./domain.ts";
import { CommsError } from "./runtime.ts";

function privateJson(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new CommsError("phone requires an owned 0600 file");
  return JSON.parse(readFileSync(path, "utf8"));
}
export const networkFencePath = (home: string, did: string) => join(home, ".local/state/muster/network-fences", `${createHash("sha256").update(did).digest("hex")}.json`);
export const readNetworkIdentities = (home: string) => decodeCommsIdentityCache(privateJson(join(home, ".local/state/muster/network-identities.json")));
const privateCommand = (file: string, args: string[]): Promise<string> => new Promise((resolve, reject) => execFile(file, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(new CommsError("phone identity lease failed (output withheld)")) : resolve(stdout)));
export function openNetworkMailbox(options: { home: string; agent: string; configPath?: string }) {
  return Effect.gen(function* () {
    const config = yield* Effect.try({ try: () => decodeNetworkCommsConfig(privateJson(options.configPath ?? join(options.home, ".config/muster/network.json"))), catch: () => new CommsError("phone legacy config unavailable") });
    const reference = yield* Effect.try({ try: () => readNetworkIdentities(options.home)[options.agent], catch: () => new CommsError("phone legacy identity unavailable") });
    if (!reference) return yield* Effect.fail(new CommsError("phone legacy identity unavailable; no mint path"));
    const client = yield* Effect.promise(() => import("./vendor/rat-king-mailbox-client/index.ts"));
    const defs = yield* Effect.promise(() => import("./vendor/rat-king-lexicon/defs.ts"));
    const identity = yield* Effect.tryPromise({ try: async () => {
      const raw = await privateCommand(config.secretsCommand ?? join(options.home, ".local/bin/secrets"), ["lease", reference.secret, "--ttl", "1h", "--client-id", "muster-phone", "--no-update-check"]);
      const value = Schema.decodeUnknownSync(client.Identity)(JSON.parse(raw));
      if (value.did !== reference.did) throw new Error("identity mismatch");
      return value;
    }, catch: () => new CommsError("phone identity lease failed (output withheld)") });
    const documents = yield* Effect.try({ try: () => Object.values(readNetworkIdentities(options.home)).map(entry => Schema.decodeUnknownSync(Schema.toType(defs.DidDocument))(entry.document)), catch: () => new CommsError("phone documents unavailable") });
    return yield* client.RatKingMailbox.pipe(Effect.provide(client.layer({ endpoint: config.endpoint, serviceDid: config.serviceDid, identity, documents }).pipe(Layer.provide(FetchHttpClient.layer))));
  });
}
export function sendWithConsumerFence(options: { home: string; did: string; send: (options?: import("./vendor/rat-king-mailbox-client/index.ts").SendOptions) => ReturnType<Effect.Success<ReturnType<typeof openNetworkMailbox>>["send"]> }) {
  return Effect.gen(function* () {
    const path = networkFencePath(options.home, options.did);
    const fence = yield* Effect.try({ try: () => decodeNetworkSendFence(privateJson(path)), catch: () => new CommsError("phone requires its existing legacy reader fence; slice B pending") });
    if (fence.did !== options.did) return yield* Effect.fail(new CommsError("phone fence DID mismatch"));
    return yield* options.send({ fence });
  });
}
