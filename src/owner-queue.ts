import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import { decodeOwnerItem, decodeOwnerReader, decodeOwnerSession, decodeOwnerForward, decodeProject } from "./domain.ts";
import type { OwnerItem, OwnerKind } from "./domain.ts";
import { projectPath } from "./store.ts";
import { StoreError } from "./errors.ts";
import { POST_NSID, MENTION_NSID } from "./owner-lexicon.ts";
import { networkTargetRow } from "./desk-route.ts";
import { relayEvent } from "./relay-events.ts";
import type { CommsDelivery, CommsShape } from "./runtime.ts";
import { writeRemoteOwnerItem } from "./remote.ts";
import { retiredSessionReason } from "./comms.ts";

export interface OwnerNoteInput { author: string; project?: string; lane?: string; kind: OwnerKind; title: string; body?: string; refs?: readonly string[]; replyTo?: string; mention?: string; text?: string; signed?: unknown }
export const mentions = (item: OwnerItem, reader: string) => item.facets?.some(f => Number.isInteger(f.index.byteStart) && Number.isInteger(f.index.byteEnd) && f.index.byteStart >= 0 && f.index.byteEnd > f.index.byteStart && f.index.byteEnd <= Buffer.byteLength(item.text) && f.features.some(feature => feature.$type === MENTION_NSID && feature.did === reader)) ?? false;
export const wakeKind = (kind: OwnerKind) => kind === "question" || kind === "blocked" || kind === "action";
export const ownerPath = (session: string, home = homedir()) => join(home, ".local/state/muster/owner-queue", `${decodeOwnerSession(session)}.jsonl`);
const readerPath = (session: string, home: string) => ownerPath(session, home).replace(/jsonl$/, "reader");
export const capBody = (body: string) => {
  let bytes = 0; let result = "";
  for (const char of body) { bytes += Buffer.byteLength(char); if (bytes > 4096) break; result += char; }
  return result;
};
/** Sorted keys recursively; cid hashes the record without its own cid. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const forwardPath = (session: string, home: string, project?: string) => ownerPath(session, home).replace(/jsonl$/, project === undefined ? "forward" : `${createHash("sha256").update(project).digest("hex")}.forward`);
function readForward(session: string, home: string, project: string) {
  for (const scoped of [true, false]) {
    // Old session-wide records are only usable for a dead reader and their recorded project.
    try {
      const record = decodeOwnerForward(JSON.parse(readFileSync(forwardPath(session, home, scoped ? project : undefined), "utf8")));
      if (!scoped && readerFresh(session, home)) return undefined;
      if (record.project !== project) {
        if (scoped) throw new Error("owner forward project mismatch");
        return undefined;
      }
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return undefined;
}
/** Writes compress chains to one hop; the read bound covers chains written before that. */
const MAX_OWNER_HOPS = 16;
/** Bounded hops; corrupt records and cycles fail closed. */
export function ownerRoute(owner: string, home = homedir(), project?: string) {
  const sources: Array<{ owner: string; forward: ReturnType<typeof decodeOwnerForward> }> = [];
  const seen = new Set<string>();
  for (;;) {
    decodeOwnerSession(owner);
    if (seen.has(owner)) throw new Error("owner forward cycle");
    seen.add(owner);
    const forward = project === undefined ? undefined : readForward(owner, home, project);
    if (!forward) return { owner, sources };
    if (sources.length === MAX_OWNER_HOPS) throw new Error(`owner forward depth exceeds ${MAX_OWNER_HOPS}`);
    sources.push({ owner, forward }); owner = forward.to;
  }
}
export function forwardOwner(params: { from: string; to: string; project: string; home: string; at?: string }) {
  if (params.from === params.to) return;
  decodeOwnerSession(params.from); decodeOwnerSession(params.to);
  const reversePath = forwardPath(params.to, params.home, params.project);
  let retired: string | undefined;
  try {
    const reverse = decodeOwnerForward(JSON.parse(readFileSync(reversePath, "utf8")));
    if (reverse.project !== params.project) throw new Error("owner forward project mismatch");
    if (reverse.to === params.from) {
      renameSync(reversePath, `${reversePath}.retired-${new Date().toISOString()}`);
      retired = `retired reverse forward ${params.to} → ${params.from} for ${params.project}`;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const route = ownerRoute(params.to, params.home, params.project);
  if (route.owner === params.from || route.sources.some(s => s.owner === params.from)) throw new Error("owner forward cycle");
  if (route.sources.length >= MAX_OWNER_HOPS) throw new Error(`owner forward depth exceeds ${MAX_OWNER_HOPS}`);
  const existing = readForward(params.from, params.home, params.project);
  if (existing?.to === params.to) return retired; // Never move the history boundary on a repeated takeover.
  let heartbeatAt: string | undefined;
  try { heartbeatAt = decodeOwnerReader(JSON.parse(readFileSync(readerPath(params.from, params.home), "utf8"))).heartbeatAt; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (heartbeatAt && !Number.isFinite(Date.parse(heartbeatAt))) throw new Error("invalid owner reader heartbeat");
  const record = decodeOwnerForward({ to: params.to, at: params.at ?? new Date().toISOString(), project: params.project, cursor: readOwnerQueue(params.from, params.home).cursor, ...(heartbeatAt ? { heartbeatAt } : {}) });
  const path = forwardPath(params.from, params.home, params.project);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); renameSync(temp, path);
  // Every restart adds a hop. Repoint earlier forwards to the new owner, keeping
  // each record's own cursor and heartbeat boundary, so chains stay one hop deep.
  const suffix = `.${createHash("sha256").update(params.project).digest("hex")}.forward`;
  for (const name of readdirSync(dirname(path))) {
    if (!name.endsWith(suffix) || name === basename(path)) continue;
    const earlier = join(dirname(path), name);
    let prior;
    try { prior = decodeOwnerForward(JSON.parse(readFileSync(earlier, "utf8"))); } catch { continue; /* readers fail closed on it */ }
    if (prior.to !== params.from || prior.project !== params.project) continue;
    const priorTemp = `${earlier}.${process.pid}.tmp`;
    writeFileSync(priorTemp, JSON.stringify({ ...prior, to: params.to }), { mode: 0o600 }); renameSync(priorTemp, earlier);
  }
  return retired;
}
/** The original records stay intact; source aliases carry routing and display context. */
function routeOwnerSources(owner: string, reads: Array<{ source: string; read: ReturnType<typeof readOwnerQueue> }>, routeFor: (source: string, project?: string) => ReturnType<typeof ownerRoute>) {
  return reads.map(({ source, read }) => {
    const aliases = new Set<string>();
    const routes = new Map<string | undefined, ReturnType<typeof ownerRoute>>();
    const items = read.items.filter(({ item, line }) => {
      let route = routes.get(item.project);
      if (!route) { route = routeFor(source, item.project); routes.set(item.project, route); }
      if (route.owner !== owner) return false;
      const boundary = source === owner ? undefined : route.sources[0]?.forward;
      if (boundary && line <= boundary.cursor && boundary.heartbeatAt && Date.parse(item.createdAt) <= Date.parse(boundary.heartbeatAt)) return false;
      for (const hop of route.sources) aliases.add(hop.owner);
      return true;
    });
    return { source, cursor: read.cursor, items, aliases: [...aliases] };
  }).filter(source => source.source === owner || source.items.length > 0);
}
export function readOwnerSources(owner: string, home = homedir()) {
  const names = new Set([owner]);
  try {
    for (const name of readdirSync(dirname(ownerPath(owner, home)))) {
      if (!name.endsWith(".forward")) continue;
      names.add(name.slice(0, -8).replace(/\.[a-f0-9]{64}$/, ""));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return routeOwnerSources(owner, [...names].map(source => ({ source, read: readOwnerQueue(source, home) })), (source, project) => ownerRoute(source, home, project));
}
type QueueRead = ReturnType<typeof readOwnerQueue>;
type Forward = ReturnType<typeof decodeOwnerForward>;
const execAsync = promisify(execFile);
async function readerFreshAsync(owner: string, home: string) {
  try {
    const reader = decodeOwnerReader(JSON.parse(await readFile(readerPath(owner, home), "utf8")));
    const age = Date.now() - Date.parse(reader.heartbeatAt);
    if (!Number.isInteger(reader.pid) || reader.pid <= 0 || !Number.isFinite(age) || age < 0 || age > 120000 || !Number.isFinite(Date.parse(reader.startedAt))) return false;
    process.kill(reader.pid, 0);
    try {
      const { stdout } = await execAsync("ps", ["-o", "lstart=", "-p", String(reader.pid)], { timeout: 2000, env: { ...process.env, LC_ALL: "C" } });
      const started = Date.parse(stdout.trim());
      if (Number.isFinite(started) && started > Date.parse(reader.startedAt)) return false;
    } catch { /* Live PID without metadata is not evidence of reuse. */ }
    return true;
  } catch { return false; }
}
/** Session-owned derived cache. Original histories and tool-call reads remain intact. */
export function ownerSourceReader(owner: string, home = homedir(), observe?: (event: { path: string; bytes: number; lines: number }) => void) {
  decodeOwnerSession(owner);
  const directory = dirname(ownerPath(owner, home));
  let revision = 1, indexed = 0;
  let forwards = new Map<string, Forward>();
  let names = new Set([owner]);
  let relevant = new Set([owner]);
  const queues = new Map<string, { ino: number; dev: number; size: number; tail: Buffer; read: QueueRead }>();
  let running: Promise<ReturnType<typeof readOwnerSources>> | undefined;
  const refresh = async () => {
    if (indexed !== revision) {
      const version = revision;
      let files: string[];
      try { files = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
      const next = new Map<string, Forward>();
      const nextNames = new Set([owner]);
      for (const file of files) {
        if (!file.endsWith(".forward")) continue;
        try {
          const record = decodeOwnerForward(JSON.parse(await readFile(join(directory, file), "utf8")));
          const source = file.slice(0, -8).replace(/\.[a-f0-9]{64}$/, "");
          decodeOwnerSession(source); nextNames.add(source); next.set(file, record);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      forwards = next; names = nextNames; indexed = version;
    }
    const fresh = new Set<string>();
    for (const source of names) if (forwards.has(`${source}.forward`) && await readerFreshAsync(source, home)) fresh.add(source);
    const routeFor = (source: string, project?: string): ReturnType<typeof ownerRoute> => {
      const sources: ReturnType<typeof ownerRoute>["sources"] = [];
      const seen = new Set<string>();
      for (;;) {
        if (seen.has(source)) throw new Error("owner forward cycle");
        seen.add(source);
        const scoped = project === undefined ? undefined : forwards.get(`${source}.${createHash("sha256").update(project).digest("hex")}.forward`);
        if (scoped && scoped.project !== project) throw new Error("owner forward project mismatch");
        const legacy = fresh.has(source) ? undefined : forwards.get(`${source}.forward`);
        const forward = scoped ?? (legacy?.project === project && project !== undefined ? legacy : undefined);
        if (!forward) return { owner: source, sources };
        if (sources.length === MAX_OWNER_HOPS) throw new Error(`owner forward depth exceeds ${MAX_OWNER_HOPS}`);
        sources.push({ owner: source, forward }); source = forward.to;
      }
    };
    const projects = new Set([...forwards.values()].map(record => record.project));
    relevant = new Set([...names].filter(source => source === owner || [...projects].some(project => routeFor(source, project).owner === owner)));
    for (const source of queues.keys()) if (!relevant.has(source)) queues.delete(source);
    const reads: Array<{ source: string; read: QueueRead }> = [];
    for (const source of names) {
      if (!relevant.has(source)) continue;
      const path = ownerPath(source, home);
      let handle;
      try { handle = await open(path, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; queues.delete(source); reads.push({ source, read: { items: [], cursor: 0 } }); continue; }
      try {
        const stat = await handle.stat();
        let queue = queues.get(source);
        if (!queue || queue.ino !== stat.ino || queue.dev !== stat.dev || stat.size < queue.size) queue = { ino: stat.ino, dev: stat.dev, size: 0, tail: Buffer.alloc(0), read: { items: [], cursor: 0 } };
        const buffer = Buffer.alloc(stat.size - queue.size);
        let bytes = 0;
        while (bytes < buffer.length) {
          const result = await handle.read(buffer, bytes, buffer.length - bytes, queue.size + bytes);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
        }
        const raw = Buffer.concat([queue.tail, buffer.subarray(0, bytes)]);
        const end = raw.lastIndexOf(10);
        const lines = end < 0 ? [] : raw.subarray(0, end).toString("utf8").split("\n");
        for (const line of lines) {
          queue.read.cursor++;
          try { queue.read.items.push({ item: decodeOwnerItem(JSON.parse(line)), line: queue.read.cursor }); } catch { /* malformed complete lines still count */ }
        }
        queue.tail = raw.subarray(end + 1); queue.size += bytes;
        queues.set(source, queue); reads.push({ source, read: queue.read });
        observe?.({ path, bytes, lines: lines.length });
      } finally { await handle.close(); }
    }
    return routeOwnerSources(owner, reads, routeFor);
  };
  return {
    event(name: string | undefined) {
      if (name === undefined || name.endsWith(".forward")) { revision++; return true; }
      return name.endsWith(".jsonl") && relevant.has(name.slice(0, -6));
    },
    read() {
      if (!running) running = refresh().finally(() => { running = undefined; });
      return running;
    },
  };
}
/** Launches carry a directory; forwards and packet notices carry the catalog slug. */
function ownerProject(project: string): string {
  try { return decodeProject(JSON.parse(readFileSync(projectPath(project), "utf8"))).slug; }
  catch {
    // A remote worker cannot read the owner's catalog; only use its own launch identity.
    return project === process.env.MUSTER_PROJECT ? process.env.MUSTER_PROJECT_SLUG ?? project : project;
  }
}
export function resolveOwner(params: { owner: string; project: string; agent?: string; home: string }) {
  if (!params.agent) return { owner: params.owner, resolution: "explicit recipient" };
  try {
    const project = decodeProject(JSON.parse(readFileSync(projectPath(params.project), "utf8")));
    const row = project.agents.find(row => row.name === params.agent);
    if (row) return { owner: row.owner, resolution: "catalog row" };
    return { owner: params.owner, resolution: "MUSTER_OWNER fallback: no catalog row" };
  } catch { return { owner: params.owner, resolution: "MUSTER_OWNER fallback: catalog unreadable" }; }
}
export function findOwnerPost(session: string, uri: string, home = homedir()) {
  const post = readOwnerSources(session, home).flatMap(s => s.items).find(({ item }) => item.uri === uri)?.item;
  if (!post) throw new Error(`post not found in this session's queue: ${uri}`);
  return post;
}
function guardOwnerRecipient(home: string, owner: string): void {
  const reason = retiredSessionReason(home, owner);
  if (reason) throw new Error(`${reason}; owner route has no live successor; repair with project_status takeover or agent_launch adopt`);
}

export function appendOwnerItem(owner: string, input: OwnerNoteInput, home = homedir(), persist = true): OwnerItem {
  const originalOwner = owner;
  owner = ownerRoute(owner, home, input.project).owner;
  guardOwnerRecipient(home, owner);
  const author = decodeOwnerSession(input.author);
  const parent = input.replyTo ? findOwnerPost(author, input.replyTo, home) : undefined;
  const mention = input.mention === originalOwner ? owner : input.mention ?? (wakeKind(input.kind) ? owner : undefined);
  if (mention) decodeOwnerSession(mention);
  const prefix = mention ? `@${mention} ` : "";
  const title = [...input.title.replace(/\r?\n/g, " ")].slice(0, 200).join("");
  const record = {
    $type: POST_NSID, uri: `muster://${author}/${POST_NSID}/${Date.now().toString(16).padStart(12, "0")}${randomBytes(6).toString("hex")}`,
    author, createdAt: new Date().toISOString(), text: `${prefix}${input.text === undefined ? `${title}${input.body === undefined ? "" : `\n${capBody(input.body)}`}` : capBody(input.text)}`, kind: input.kind,
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(input.lane ? { lane: input.lane } : {}), ...(input.refs ? { refs: input.refs } : {}),
    ...(parent ? { reply: { root: parent.reply?.root ?? { uri: parent.uri, cid: parent.cid }, parent: { uri: parent.uri, cid: parent.cid } } } : {}),
    ...(mention ? { facets: [{ index: { byteStart: 0, byteEnd: Buffer.byteLength(prefix.trimEnd()) }, features: [{ $type: MENTION_NSID, did: mention }] }] } : {}),
  };
  const item = decodeOwnerItem({ ...record, cid: createHash("sha256").update(canonicalJson(record)).digest("hex").slice(0, 32), ...(input.signed === undefined ? {} : { signed: input.signed }) });
  if (persist) {
    const path = ownerPath(owner, home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(item)}\n`, { mode: 0o600 });
  }
  return item;
}
/** Pull preserves the full post and CID. Forwarded source queues also count for dedupe. */
export function ingestOwnerItem(owner: string, value: OwnerItem, home = homedir(), project?: string): boolean {
  const item = decodeOwnerItem(value);
  if (project !== undefined && item.project !== undefined && item.project !== project) throw new Error("owner item project mismatch");
  const routedOwner = ownerRoute(owner, home, item.project).owner;
  if (readOwnerQueue(owner, home).items.some(record => record.item.cid === item.cid)) return false;
  if (readOwnerSources(routedOwner, home).some(source => readOwnerQueue(source.source, home).items.some(record => record.item.cid === item.cid))) return false;
  // Keep the original recipient's mention valid through the feed's forwarding aliases.
  const path = ownerPath(owner, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(item)}\n`, { mode: 0o600 });
  return true;
}
/** Ignore only malformed complete lines. An incomplete trailing append is retried. */
export function readOwnerQueue(owner: string, home = homedir()): { items: Array<{ item: OwnerItem; line: number }>; cursor: number } {
  let raw: string;
  try { raw = readFileSync(ownerPath(owner, home), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], cursor: 0 }; throw error; }
  const lines = raw.split("\n"); lines.pop();
  const items: Array<{ item: OwnerItem; line: number }> = [];
  lines.forEach((line, index) => { try { items.push({ item: decodeOwnerItem(JSON.parse(line)), line: index + 1 }); } catch { /* foreign lines do not hide later items */ } });
  return { items, cursor: lines.length };
}
export function readerFresh(owner: string, home = homedir(), now = Date.now()): boolean {
  try {
    const reader = decodeOwnerReader(JSON.parse(readFileSync(readerPath(owner, home), "utf8")));
    const age = now - Date.parse(reader.heartbeatAt);
    if (!Number.isInteger(reader.pid) || reader.pid <= 0 || !Number.isFinite(age) || age < 0 || age > 120000 || !Number.isFinite(Date.parse(reader.startedAt))) return false;
    process.kill(reader.pid, 0);
    try {
      const started = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(reader.pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim());
      if (Number.isFinite(started) && started > Date.parse(reader.startedAt)) return false;
    } catch { /* A live pid with unavailable start metadata is not evidence of reuse. */ }
    return true;
  } catch { return false; }
}
export function writeReader(owner: string, home = homedir(), now = Date.now(), pid = process.pid, startedAt = new Date(now).toISOString()) {
  const path = readerPath(owner, home); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ pid, startedAt, heartbeatAt: new Date(now).toISOString() }), { mode: 0o600 }); renameSync(temp, path);
}
/** Timer heartbeat. A rename can stall for a minute in an APFS metadata stall, so it
 * must never block the event loop (Pi Freeze, 2026-10-06). Its own temp name keeps it
 * apart from the sync retire write. */
export async function writeReaderAsync(owner: string, home = homedir(), now = Date.now(), pid = process.pid, startedAt = new Date(now).toISOString()) {
  const path = readerPath(owner, home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ pid, startedAt, heartbeatAt: new Date(now).toISOString() }), { mode: 0o600 });
    await rename(temp, path);
  } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
/** Sync on purpose: it runs once at shutdown or session switch, and must finish before exit. */
export function retireReader(owner: string, home: string, startedAt: string) {
  try {
    const reader = decodeOwnerReader(JSON.parse(readFileSync(readerPath(owner, home), "utf8")));
    if (reader.pid === process.pid && reader.startedAt === startedAt) writeReader(owner, home, 0, process.pid, startedAt);
  } catch { /* missing or replaced presence is not ours */ }
}
/** Queue first. Missing readers and any queue/telemetry failure keep the old outbox path. */
export const deliverOwnerItem = <R>(params: { owner: string; agent?: string; home: string; session: string; project: string; item: OwnerNoteInput; comms?: CommsShape; send: (to: string, message: string) => Effect.Effect<CommsDelivery, never, R>; message?: string }) => Effect.gen(function* () {
  const resolved = resolveOwner(params);
  const project = ownerProject(params.project);
  const route = yield* Effect.try({ try: () => ownerRoute(resolved.owner, params.home, project), catch: error => new StoreError({ path: ownerPath(resolved.owner, params.home), message: String(error) }) });
  const owner = route.owner;
  const resolution = yield* Effect.try({ try: () => {
    guardOwnerRecipient(params.home, owner);
    const retired = retiredSessionReason(params.home, params.owner);
    return retired && owner !== params.owner ? `${resolved.resolution}; owner ${params.owner} retired; routed to successor ${owner}` : resolved.resolution;
  }, catch: error => new StoreError({ path: ownerPath(owner, params.home), message: String(error) }) });
  const note = params.item.mention === params.owner ? { ...params.item, mention: owner } : params.item;
  const mode = params.comms?.mode ? yield* params.comms.mode().pipe(Effect.catch(() => Effect.succeed("network" as const))) : "intercom";
  if (mode === "network") {
    // Local readers must not see a post until authenticated mailbox ingestion.
    const item = yield* Effect.try({ try: () => appendOwnerItem(owner, { ...note, project }, params.home, false), catch: () => new StoreError({ path: "owner network record", message: "owner network record refused" }) });
    const message = params.message ?? `Owner notice from ${params.item.author} (${params.item.lane ?? ""}): [${params.item.kind}] ${params.item.title.slice(0, 200)}${params.item.body ? `\n${capBody(params.item.body)}` : ""}${params.item.refs?.length ? `\nrefs: ${params.item.refs.join(", ")}` : ""}`;
    const { routedNetworkSend } = yield* Effect.promise(() => import("./comms-network.ts"));
    const result = yield* routedNetworkSend({ home: params.home, sender: params.session, to: owner, id: item.uri, at: new Date().toISOString(), text: message,
      target: networkTargetRow(params.home, params.project, owner),
      network: params.comms?.postOwner ? params.comms.postOwner(owner, item) : Effect.succeed({ status: "failed" as const, detail: "NetworkComms owner transport unavailable" }),
      fallback: () => Effect.gen(function* () {
        if (!params.comms?.relay) return { status: "failed" as const, detail: "intercom fallback unavailable" };
        // Make the same record visible, not a duplicate post. Remote owners pull its sidecar.
        const recorded = yield* Effect.try({ try: () => {
          ingestOwnerItem(owner, item, params.home);
          if (process.env.MUSTER_MACHINE && process.env.MUSTER_MACHINE !== "local") writeRemoteOwnerItem(owner, item, params.session);
          return true;
        }, catch: () => new StoreError({ path: "owner fallback record", message: "owner fallback record could not be queued" }) }).pipe(Effect.catch(() => Effect.succeed(false)));
        const sent = yield* params.comms.relay(owner, message);
        return recorded ? sent : { ...sent, detail: `${sent.detail ? `${sent.detail}; ` : ""}fallback queue write failed; notice only` };
      }),
    });
    const delivery = result.delivery;
    const queued = ["accepted", "queued", "delivered", "acked"].includes(delivery.status);
    const woke = ["delivered", "acked"].includes(delivery.status) && mentions(item, owner);
    const path = result.path === "herdr-prompt" ? "herdr-prompt" as const : result.fallback ? "intercom" as const : "network" as const;
    relayEvent({ ts: new Date().toISOString(), session: params.session, project: params.project, kind: "owner_note", noteKind: params.item.kind, woke, path, itemId: item.uri }, params.home);
    return { id: item.uri, uri: item.uri, queued, woke, path, delivery, owner, resolution, pendingPull: false };
  }
  let item: OwnerItem | undefined;
  let queueError: unknown;
  try { item = appendOwnerItem(owner, { ...note, project }, params.home); } catch (error) { queueError = error; }
  const woke = item ? mentions(item, owner) : note.mention === owner || wakeKind(params.item.kind);
  if (!item && !woke) return yield* new StoreError({ path: ownerPath(params.owner, params.home), message: `silent owner note not queued: ${String(queueError)}` });
  const remote = !!process.env.MUSTER_MACHINE && process.env.MUSTER_MACHINE !== "local";
  if (remote) {
    if (!item) return yield* new StoreError({ path: ownerPath(owner, params.home), message: `remote owner note not queued: ${String(queueError)}` });
    yield* Effect.try({ try: () => writeRemoteOwnerItem(owner, item, params.session), catch: error => new StoreError({ path: "remote owner note sidecar", message: String(error) }) });
  }
  let path: "queue" | "intercom" = item && (!woke || (!remote && readerFresh(owner, params.home))) ? "queue" : "intercom";
  const logged = relayEvent({ ts: new Date().toISOString(), session: params.session, project: params.project, kind: "owner_note", noteKind: params.item.kind, woke, path, ...(item ? { itemId: item.uri } : {}) }, params.home);
  if (!logged && woke) path = "intercom";
  const delivery = path === "intercom" ? yield* params.send(owner, params.message ?? `Owner notice from ${params.item.author} (${params.item.lane ?? ""}): [${params.item.kind}] ${params.item.title.slice(0, 200)}${params.item.body ? `\n${capBody(params.item.body)}` : ""}${params.item.refs?.length ? `\nrefs: ${params.item.refs.join(", ")}` : ""}`) : { status: "queued" as const, detail: "owner queue" };
  const pendingPull = remote && delivery.status !== "delivered" && delivery.status !== "acked";
  return { id: item?.uri ?? null, uri: item?.uri ?? null, queued: !!item, woke: pendingPull ? false : woke, path, delivery: pendingPull ? { status: "queued" as const, detail: "Queued for the Flagg owner to pull on the next status pass; not delivered." } : delivery, owner, resolution, ...(remote ? { pendingPull } : {}) };
});
