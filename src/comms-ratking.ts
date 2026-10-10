import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { commsAddress } from "./comms.ts";
import { networkReceiptPath } from "./comms-fallback.ts";
import { resolveDeskRoute } from "./desk-route.ts";
import { decodeDeskRouteReceipt, decodeNetworkPayload, decodeProject, type NetworkPayload, type OwnerItem, type Project } from "./domain.ts";
import { readRegistry } from "./registry.ts";
import { projectPath } from "./store.ts";
import { CommsError, Unsupported, type CommsDelivery, type CommsShape, type CommsTarget } from "./runtime.ts";

/**
 * Muster over pi-ratking. pi-ratking owns the network: names, keys, leases and the reader.
 * Muster only turns a row or owner into a name and puts its payload in an ordinary message body.
 */
export const RATKING_SEND = "ratking/send";
export const RATKING_SEND_RESULT = "ratking/send:result";
export const RATKING_MESSAGE = "ratking/message";
/**
 * Muster's JSON payloads ride as pi-ratking kind "data" (rat-king cfade48): they reach `ratking/message`
 * listeners only, never the model, and Muster's inbound hook turns them into queue items or follow-ups.
 * pi-ratking decodes kind as "message", "ask" or "data"; an older pi-ratking refuses "data".
 * Owner traffic stays inside a ratking project, whose rows and owner run the ratking Muster, so it is data.
 */
export const RATKING_KIND = "data";
/**
 * `send` crosses projects (desk_send, row messages), and a recipient on Muster older than d3d8d03 has no
 * hook for data: it would see nothing. A message kind shows the payload raw at worst, never drops it.
 */
export const RATKING_SEND_KIND = "message";
const SEND_TIMEOUT_MS = 30_000;

interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): (() => void) | void;
}

/** A row's Rat King name. pi-ratking claims it from RATKING_NAME. */
export const rowRatkingName = (project: Pick<Project, "slug">, row: { readonly name: string }) => `${project.slug}/${row.name}`;

/** Rowless owners with reserved Rat King names. */
export const OWNER_ALIASES: readonly string[] = ["switchboard", "servo", "titan"];

type LoadedTool = { readonly name: string; readonly sourceInfo?: { readonly path?: string; readonly source?: string } };
const fromRatking = (tool: LoadedTool) => /pi-ratking/.test(`${tool.sourceInfo?.path ?? ""} ${tool.sourceInfo?.source ?? ""}`);

/** pi-ratking registers its tool as `ratking`, or as `intercom` once pi-intercom is gone; either way its source names the package. */
export function ratkingLoaded(tools: readonly LoadedTool[], toolName = "ratking"): boolean {
  return tools.some(tool => tool.name === toolName || fromRatking(tool));
}

/** pi-intercom is loaded: some `intercom` tool that pi-ratking did not register. */
export function intercomLoaded(tools: readonly LoadedTool[]): boolean {
  return tools.some(tool => tool.name === "intercom" && !fromRatking(tool));
}

/** pi-ratking's config file, the same lookup pi-ratking makes. */
export const ratkingConfigPath = (home: string, env: Readonly<Record<string, string | undefined>> = process.env) => env.RATKING_CONFIG || join(home, ".config/rat-king/pi.json");

/**
 * DIDs pi-ratking reads as reserved names (the Switchboard, an owner). Muster's legacy reader must never consume one.
 * A refused name is not pi-ratking's to read, so it is left out. A missing or unreadable file reserves nothing.
 */
export function reservedRatkingDids(home: string, env: Readonly<Record<string, string | undefined>> = process.env): Set<string> {
  const dids = new Set<string>();
  try {
    const config = JSON.parse(readFileSync(ratkingConfigPath(home, env), "utf8")) as { reserved?: unknown; refuse?: unknown };
    const refused = new Set(Array.isArray(config.refuse) ? config.refuse.filter(name => typeof name === "string") : []);
    if (typeof config.reserved !== "object" || config.reserved === null) return dids;
    for (const [name, entry] of Object.entries(config.reserved)) {
      const did = (entry as { did?: unknown } | null)?.did;
      if (!refused.has(name) && typeof did === "string") dids.add(did);
    }
  } catch { /* no config: nothing reserved */ }
  return dids;
}

/**
 * The owner session's Rat King name. This very process answers to its own RATKING_NAME. A live row in any
 * catalog is `<project>/<row>`; a rowless owner is the name recorded at launch, from its own RATKING_NAME or
 * MUSTER_AGENT, then a subscribed Switchboard's recorded name, then any row's recorded ownerName; last, the alias table.
 */
export function ownerName(owner: string, sources: { readonly catalogs: readonly Project[]; readonly recorded?: string | undefined; readonly aliases?: Readonly<Record<string, string>>; readonly self?: OwnerSelf; readonly switchboards?: Readonly<Record<string, string>> }): string | undefined {
  if (sources.self?.name && owner === sources.self.session) return sources.self.name;
  for (const project of sources.catalogs) {
    const row = project.agents.find(row => row.sessionId === owner && row.state !== "closed");
    if (row) return rowRatkingName(project, row);
  }
  if (sources.recorded) return sources.recorded;
  if (sources.switchboards?.[owner]) return sources.switchboards[owner];
  for (const project of sources.catalogs) {
    const row = project.agents.find(row => row.owner === owner && row.ownerName);
    if (row?.ownerName) return row.ownerName;
  }
  const alias = sources.aliases?.[owner];
  return alias !== undefined && OWNER_ALIASES.includes(alias) ? alias : undefined;
}

/** Subscribed Switchboards, one file per session id. A file holds that Switchboard's Rat King name, or nothing. */
export const switchboardSessionsDir = (home: string) => join(home, ".local", "state", "muster", "switchboards");

/** Session id → the Rat King name each subscribed Switchboard recorded. Unnamed subscriptions are left out. */
export function subscribedSwitchboards(home: string): Record<string, string> {
  const names: Record<string, string> = {};
  const dir = switchboardSessionsDir(home);
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return names; }
  for (const file of files) {
    try { const name = readFileSync(join(dir, file), "utf8").trim(); if (name) names[decodeURIComponent(file)] = name; } catch { /* removed meanwhile */ }
  }
  return names;
}

/** This process: its session and the RATKING_NAME it was started with. */
export type OwnerSelf = { readonly session: string; readonly name?: string | undefined };

/** The name this process answers to, recorded on rows it launches. */
export function ownerSelfName(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env.RATKING_NAME) return env.RATKING_NAME;
  if (env.MUSTER_AGENT) return env.MUSTER_PROJECT_SLUG ? `${env.MUSTER_PROJECT_SLUG}/${env.MUSTER_AGENT}` : env.MUSTER_AGENT;
  return env.MUSTER_SWITCHBOARD === "1" ? "switchboard" : undefined;
}

/** This catalog first, then every registered one. An unreadable catalog has no rows to offer. */
export function registeredCatalogs(home: string, dir?: string): Project[] {
  const catalogs: Project[] = [];
  const add = (path: string, slug?: string) => {
    try {
      const project = decodeProject(JSON.parse(readFileSync(projectPath(path), "utf8")));
      if ((slug === undefined || project.slug === slug) && !catalogs.some(known => known.slug === project.slug)) catalogs.push(project);
    } catch { /* unreadable */ }
  };
  if (dir) add(dir);
  try { for (const entry of readRegistry(home).values()) add(entry.dir, entry.slug); } catch { /* no registry */ }
  return catalogs;
}

/** The legacy session → identity caches, read only for the reserved rowless names. */
export function ownerAliases(home: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const file of ["network-peers.json", "network-desk-peers.json"]) {
    try {
      const table = JSON.parse(readFileSync(join(home, ".local/state/muster", file), "utf8")) as unknown;
      if (typeof table !== "object" || table === null) continue;
      for (const [session, name] of Object.entries(table)) if (typeof name === "string" && OWNER_ALIASES.includes(name)) aliases[session] = name;
    } catch { /* absent */ }
  }
  return aliases;
}

export interface RatkingTarget { readonly name: string; readonly session: string }

/** A Muster target as a Rat King name, plus the session the payload names. A DID is pi-ratking's business. */
export function ratkingTarget(to: CommsTarget, options: { readonly catalogs: readonly Project[]; readonly env: Readonly<Record<string, string | undefined>>; readonly aliases?: Readonly<Record<string, string>>; readonly self?: OwnerSelf; readonly switchboards?: Readonly<Record<string, string>> }): RatkingTarget {
  const address = commsAddress(to);
  if (address.kind === "did") throw new Unsupported("Muster sends to Rat King names, not DIDs");
  if (address.kind === "alias") {
    const project = options.catalogs.find(project => project.slug === address.project);
    const row = project?.agents.find(row => row.name === address.row && row.state !== "closed");
    if (!project || !row) throw new CommsError(`no open row ${address.project}/${address.row}`);
    return { name: rowRatkingName(project, row), session: row.sessionId };
  }
  // A reserved rowless name (`switchboard`) is its own address.
  if (OWNER_ALIASES.includes(address.id)) return { name: address.id, session: address.id };
  const name = ownerName(address.id, { catalogs: options.catalogs, recorded: address.id === options.env.MUSTER_OWNER ? options.env.MUSTER_OWNER_NAME : undefined, ...(options.aliases ? { aliases: options.aliases } : {}), ...(options.self ? { self: options.self } : {}), ...(options.switchboards ? { switchboards: options.switchboards } : {}) });
  if (!name) throw new CommsError(`no Rat King name for session ${address.id}: not a live row, no recorded owner name, no alias; set RATKING_NAME on that Pi and relaunch its rows`);
  return { name, session: address.id };
}

type SendRequest = { readonly to: string; readonly body: string; readonly kind?: string } | { readonly replyTo: string; readonly body: string; readonly kind?: string };

/** One request, one result by requestId. Not delivered is a failed delivery with pi-ratking's code; there is no fallback. */
export function ratkingSend(events: EventBus, createId: () => string, request: SendRequest, timeoutMs = SEND_TIMEOUT_MS): Effect.Effect<CommsDelivery> {
  return Effect.callback<CommsDelivery>((resume) => {
    const requestId = `muster-${createId()}`;
    let done = false;
    const finish = (delivery: CommsDelivery) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof off === "function") off();
      resume(Effect.succeed(delivery));
    };
    const off = events.on(RATKING_SEND_RESULT, (payload) => {
      const result = payload as { requestId?: unknown; status?: unknown; id?: unknown; seq?: unknown; to?: unknown; code?: unknown; reason?: unknown } | null;
      if (result?.requestId !== requestId) return;
      if (result.status === "delivered") {
        finish({ status: "delivered", detail: `ratking → ${typeof result.to === "string" ? result.to : "to" in request ? request.to : "reply"}`,
          ...(typeof result.id === "string" ? { id: result.id } : {}), ...(typeof result.seq === "number" && Number.isInteger(result.seq) && result.seq >= 1 ? { seq: result.seq } : {}) });
        return;
      }
      const code = typeof result.code === "string" ? result.code : "Unknown";
      finish({ status: "failed", detail: `NOT DELIVERED: ${code}${typeof result.reason === "string" && result.reason ? `: ${result.reason}` : ""} (ratking; no fallback)` });
    });
    const timer = setTimeout(() => finish({ status: "failed", detail: `NOT DELIVERED: Timeout: no ratking/send:result in ${Math.round(timeoutMs / 1000)} s; is pi-ratking loaded? (no fallback)` }), timeoutMs);
    timer.unref?.();
    events.emit(RATKING_SEND, { requestId, ...request });
    return Effect.sync(() => finish({ status: "failed", detail: "interrupted" }));
  });
}

/** Ratking message ids by the owner post they carried: owner_reply answers the message, not a guessed name. */
const repliesByUri = new Map<string, string>();
export const rememberRatkingMessage = (uri: string, id: string) => {
  repliesByUri.set(uri, id);
  if (repliesByUri.size > 1000) repliesByUri.delete(repliesByUri.keys().next().value!);
};

export function RatkingComms(options: {
  readonly events: EventBus;
  readonly createId: () => string;
  /** The session payloads name as their author. */
  readonly sender: () => string | undefined;
  readonly target: (to: CommsTarget) => RatkingTarget;
  readonly timeoutMs?: number;
}): CommsShape {
  const send = (request: SendRequest) => ratkingSend(options.events, options.createId, request, options.timeoutMs);
  const target = (to: CommsTarget) => Effect.try({ try: () => options.target(to), catch: error => error instanceof CommsError ? error : new CommsError(String(error)) });
  const failed = (error: CommsError): CommsDelivery => ({ status: "failed", detail: `NOT DELIVERED: ${error.message} (ratking; no fallback)` });
  return {
    mode: () => Effect.succeed("ratking"),
    send: (to, message) => target(to).pipe(
      Effect.flatMap(({ name, session }) => {
        const author = options.sender();
        if (!author) return Effect.succeed<CommsDelivery>({ status: "failed", detail: "NOT DELIVERED: sender session missing (ratking)" });
        return send({ to: name, kind: RATKING_SEND_KIND, body: JSON.stringify({ type: "message", recipient: session, author, body: message }) });
      }),
      Effect.catch(error => Effect.succeed(failed(error)))),
    postOwner: (to, item) => {
      const body = (recipient: string) => JSON.stringify({ type: "owner", recipient, item });
      const replyTo = item.reply ? repliesByUri.get(item.reply.parent.uri) : undefined;
      if (replyTo) return send({ replyTo, kind: RATKING_KIND, body: body(typeof to === "string" ? to : item.author) });
      return target(to).pipe(Effect.flatMap(({ name, session }) => send({ to: name, kind: RATKING_KIND, body: body(session) })), Effect.catch(error => Effect.succeed(failed(error))));
    },
    reply: (id, message) => send({ replyTo: id, body: message }),
    ask: () => Effect.fail(new Unsupported("Muster asks through owner_note; ratking ask is the tool's")),
    wake: () => Effect.succeed({ woke: false, reason: "ratking wakes by delivery" }),
    resolve: () => Effect.fail(new Unsupported("ratking leases are pi-ratking's")),
    sessions: () => Effect.succeed(undefined),
  };
}

const NOT_LOADED = "NOT DELIVERED: pi-ratking not loaded in this Pi (ratking; no fallback). Load @rat-king/pi-ratking and restart this Pi.";

/** Ratking selected but pi-ratking absent: every send fails at once and says why. Never the intercom adapter. */
export const RatkingMissing: CommsShape = {
  mode: () => Effect.succeed("ratking"),
  send: () => Effect.succeed({ status: "failed", detail: NOT_LOADED }),
  postOwner: () => Effect.succeed({ status: "failed", detail: NOT_LOADED }),
  reply: () => Effect.succeed({ status: "failed", detail: NOT_LOADED }),
  ask: () => Effect.fail(new CommsError(NOT_LOADED)),
  wake: () => Effect.succeed({ woke: false, reason: "pi-ratking not loaded" }),
  resolve: () => Effect.fail(new CommsError(NOT_LOADED)),
  sessions: () => Effect.succeed(undefined),
};

/** One inbound ratking message. Muster acts only on its own verified payloads; pi-ratking already shows the rest. */
export function ratkingInbound(message: unknown, handle: { readonly owner: (item: OwnerItem, id: string) => void; readonly message: (payload: Extract<NetworkPayload, { type: "message" }>) => void }): "owner" | "message" | "ignored" {
  if (typeof message !== "object" || message === null) return "ignored";
  const { body, verified, id } = message as { body?: unknown; verified?: unknown; id?: unknown };
  if (typeof body !== "string" || verified !== true || typeof id !== "string") return "ignored";
  let payload: NetworkPayload;
  try { payload = decodeNetworkPayload(JSON.parse(body)); } catch { return "ignored"; }
  if (payload.type === "owner") {
    rememberRatkingMessage(payload.item.uri, id);
    handle.owner(payload.item, id);
    return "owner";
  }
  handle.message(payload);
  return "message";
}

const undelivered = (delivery: CommsDelivery) => delivery.status === "failed" || delivery.status === "expired";

/** The same private route receipt as the network path, marked ratking. */
export function ratkingReceipt(options: { readonly home: string; readonly id: string; readonly at: string; readonly to: string; readonly sender: string; readonly delivery: CommsDelivery }) {
  return Effect.try({
    try: () => {
      const record = decodeDeskRouteReceipt({ id: options.id, at: options.at, to: options.to, sender: options.sender, path: "ratking", network: options.delivery });
      const receipt = networkReceiptPath(options.home);
      mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
      const fd = openSync(receipt, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error("unsafe receipt file");
        writeSync(fd, `${JSON.stringify(record)}\n`);
      } finally { closeSync(fd); }
      return { ...record, receipt, delivery: options.delivery, lost: undelivered(options.delivery) };
    },
    catch: () => new CommsError("ratking send finished but its receipt write failed; do not retry blindly"),
  });
}

/** desk_send over pi-ratking: the same desk fence, then one named send, no fallback. */
export function sendDeskRatking(options: { readonly home: string; readonly dir: string; readonly to: string; readonly text: string; readonly sender: string; readonly id: string; readonly at: string; readonly comms: CommsShape }) {
  return Effect.gen(function* () {
    const target = yield* Effect.try({ try: () => resolveDeskRoute(options.home, options.dir, options.to), catch: error => error instanceof CommsError ? error : new CommsError(`desk_send refused alias ${options.to}: unknown, foreign, or non-desk row`) });
    const delivery = yield* options.comms.send(`${target.project.slug}/${target.row.name}`, options.text);
    return yield* ratkingReceipt({ home: options.home, id: options.id, at: options.at, to: options.to, sender: options.sender, delivery });
  });
}
