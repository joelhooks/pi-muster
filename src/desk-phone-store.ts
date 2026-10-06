import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Semaphore } from "effect";
import { decodeDeskInboxIdentities, decodeDeskPhoneState, encodeDeskPhoneState, encodeDeskPhoneQuarantine, type DeskInboxIdentities, type DeskPhoneState, type DeskPhoneEntry } from "./domain.ts";
import { DeskInboxError } from "./desk-inbox.ts";

export const deskPhoneConfigPath = (home: string) => join(home, ".config", "muster", "desk-inbox.json");
export const deskPhoneStatePath = (home: string) => join(home, ".local", "state", "muster", "desk-inbox", "pending.json");
const failed = (message: string) => () => new DeskInboxError(message);
// Tool calls and the existing mailbox callback share a module instance. Queue them without a clock;
// the file lock still fences other processes and fails visibly after a crashed writer.
const operations = Semaphore.makeUnsafe(1);
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
async function privateJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("Private file must be a regular 0600 file");
  return JSON.parse(await readFile(path, "utf8"));
}
export const quarantineDeskPhoneEnvelope = (home: string, event: unknown, reason: string) => Effect.tryPromise({
  try: async () => {
    const encoded = await encodeDeskPhoneQuarantine({ event, reason });
    const dir = join(dirname(deskPhoneStatePath(home)), "quarantine");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${encoded.event.receipt.message.messageId}-${randomUUID()}.json`);
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(encoded)); await file.sync(); }
    finally { await file.close(); }
    return path;
  }, catch: failed("desk_phone could not quarantine unauthenticated envelope; no ack permitted"),
});

export const readDeskPhoneConfig = (home: string) => Effect.tryPromise({
  try: async () => {
    const config = decodeDeskInboxIdentities(await privateJson(deskPhoneConfigPath(home)));
    if (config.phone === config.switchboard) throw new Error("Different identities required");
    return config;
  }, catch: failed("desk_phone refused: configure distinct Switchboard and phone DIDs in ~/.config/muster/desk-inbox.json (regular file, 0600)"),
});

/** A short operation lock, never a mailbox lease. A crash leaves a visible refusal, not concurrent writers. */
export function withDeskPhoneState<A, E, R>(home: string, identities: DeskInboxIdentities,
  use: (state: Omit<DeskPhoneState, "entries"> & { entries: Record<string, DeskPhoneEntry> }, save: () => Effect.Effect<void, DeskInboxError>) => Effect.Effect<A, E, R>) {
  const path = deskPhoneStatePath(home);
  return operations.withPermit(Effect.acquireUseRelease(Effect.tryPromise({ try: async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return open(`${path}.lock`, "wx", 0o600);
  }, catch: failed("desk_phone state busy or unavailable; retry, or inspect pending.json.lock after a crashed operation") }), () => Effect.gen(function* () {
    const state = yield* Effect.tryPromise({ try: async () => {
      let value: unknown;
      try { value = await privateJson(path); }
      catch (error) { if (!missing(error)) throw error; value = { identities, entries: {} }; }
      const decoded = await decodeDeskPhoneState(value);
      if (decoded.identities.phone !== identities.phone || decoded.identities.switchboard !== identities.switchboard) throw new Error("Identity binding changed");
      for (const [id, entry] of Object.entries(decoded.entries)) {
        if (id !== entry.item.itemId || entry.item.project !== "rats-nest") throw new Error("Invalid sidecar key or project");
      }
      return { identities: decoded.identities, entries: { ...decoded.entries } };
    }, catch: failed("desk_phone sidecar invalid, not private, or bound to different identities; no action taken") });
    const save = () => Effect.tryPromise({ try: async () => {
      const temp = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(await encodeDeskPhoneState(state)), { flag: "wx", mode: 0o600 }); await rename(temp, path); }
      finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
    }, catch: failed("desk_phone could not save sidecar; inspect the send receipt and queue before retrying") });
    return yield* use(state, save);
  }), handle => Effect.promise(async () => { await handle.close(); await unlink(`${path}.lock`); })));
}
