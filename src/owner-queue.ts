import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { decodeOwnerItem, decodeOwnerReader, decodeOwnerSession, decodeOwnerForward, decodeProject } from "./domain.ts";
import type { OwnerItem, OwnerKind } from "./domain.ts";
import { projectPath } from "./store.ts";
import { StoreError } from "./errors.ts";
import { POST_NSID, MENTION_NSID } from "./owner-lexicon.ts";
import { relayEvent } from "./relay-events.ts";
import type { CommsDelivery } from "./runtime.ts";

export interface OwnerNoteInput { author: string; lane?: string; kind: OwnerKind; title: string; body?: string; refs?: readonly string[]; replyTo?: string; mention?: string; text?: string; signed?: unknown }
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
const forwardPath = (session: string, home: string) => ownerPath(session, home).replace(/jsonl$/, "forward");
function readForward(session: string, home: string) {
  try { return decodeOwnerForward(JSON.parse(readFileSync(forwardPath(session, home), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
/** Four hops at most; corrupt records and cycles fail closed. */
export function ownerRoute(owner: string, home = homedir()) {
  const sources: Array<{ owner: string; forward: ReturnType<typeof decodeOwnerForward> }> = [];
  const seen = new Set<string>();
  for (;;) {
    decodeOwnerSession(owner);
    if (seen.has(owner)) throw new Error("owner forward cycle");
    seen.add(owner);
    const forward = readForward(owner, home);
    if (!forward) return { owner, sources };
    if (sources.length === 4) throw new Error("owner forward depth exceeds 4");
    sources.push({ owner, forward }); owner = forward.to;
  }
}
export function forwardOwner(params: { from: string; to: string; project: string; home: string; at?: string }) {
  if (params.from === params.to) return;
  const route = ownerRoute(params.to, params.home);
  if (route.owner === params.from || route.sources.some(s => s.owner === params.from)) throw new Error("owner forward cycle");
  if (route.sources.length >= 4) throw new Error("owner forward depth exceeds 4");
  const existing = readForward(params.from, params.home);
  if (existing?.to === params.to) return; // Never move the history boundary on a repeated takeover.
  let heartbeatAt: string | undefined;
  try { heartbeatAt = decodeOwnerReader(JSON.parse(readFileSync(readerPath(params.from, params.home), "utf8"))).heartbeatAt; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (heartbeatAt && !Number.isFinite(Date.parse(heartbeatAt))) throw new Error("invalid owner reader heartbeat");
  const record = decodeOwnerForward({ to: params.to, at: params.at ?? new Date().toISOString(), project: params.project, cursor: readOwnerQueue(params.from, params.home).cursor, ...(heartbeatAt ? { heartbeatAt } : {}) });
  const path = forwardPath(params.from, params.home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); renameSync(temp, path);
}
/** The original records stay intact; source aliases carry routing and display context. */
export function readOwnerSources(owner: string, home = homedir()) {
  const names = [owner];
  try {
    for (const name of readdirSync(dirname(ownerPath(owner, home)))) {
      if (!name.endsWith(".forward")) continue;
      const source = name.slice(0, -8);
      if (source !== owner && ownerRoute(source, home).owner === owner) names.push(source);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return names.map(source => {
    const read = readOwnerQueue(source, home);
    const route = source === owner ? undefined : ownerRoute(source, home);
    const boundary = route?.sources[0]?.forward;
    return { source, cursor: read.cursor, items: read.items.filter(({ item, line }) =>
      !boundary || line > boundary.cursor || !boundary.heartbeatAt || Date.parse(item.createdAt) > Date.parse(boundary.heartbeatAt)),
      aliases: route?.sources.map(s => s.owner) ?? [] };
  });
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
export function appendOwnerItem(owner: string, input: OwnerNoteInput, home = homedir()): OwnerItem {
  const originalOwner = owner;
  owner = ownerRoute(owner, home).owner;
  const author = decodeOwnerSession(input.author);
  const parent = input.replyTo ? findOwnerPost(author, input.replyTo, home) : undefined;
  const mention = input.mention === originalOwner ? owner : input.mention ?? (wakeKind(input.kind) ? owner : undefined);
  if (mention) decodeOwnerSession(mention);
  const prefix = mention ? `@${mention} ` : "";
  const title = [...input.title.replace(/\r?\n/g, " ")].slice(0, 200).join("");
  const record = {
    $type: POST_NSID, uri: `muster://${author}/${POST_NSID}/${Date.now().toString(16).padStart(12, "0")}${randomBytes(6).toString("hex")}`,
    author, createdAt: new Date().toISOString(), text: `${prefix}${input.text === undefined ? `${title}${input.body === undefined ? "" : `\n${capBody(input.body)}`}` : capBody(input.text)}`, kind: input.kind,
    ...(input.lane ? { lane: input.lane } : {}), ...(input.refs ? { refs: input.refs } : {}),
    ...(parent ? { reply: { root: parent.reply?.root ?? { uri: parent.uri, cid: parent.cid }, parent: { uri: parent.uri, cid: parent.cid } } } : {}),
    ...(mention ? { facets: [{ index: { byteStart: 0, byteEnd: Buffer.byteLength(prefix.trimEnd()) }, features: [{ $type: MENTION_NSID, did: mention }] }] } : {}),
  };
  const item = decodeOwnerItem({ ...record, cid: createHash("sha256").update(canonicalJson(record)).digest("hex").slice(0, 32), ...(input.signed === undefined ? {} : { signed: input.signed }) });
  const path = ownerPath(owner, home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(item)}\n`, { mode: 0o600 });
  return item;
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
export function retireReader(owner: string, home: string, startedAt: string) {
  try {
    const reader = decodeOwnerReader(JSON.parse(readFileSync(readerPath(owner, home), "utf8")));
    if (reader.pid === process.pid && reader.startedAt === startedAt) writeReader(owner, home, 0, process.pid, startedAt);
  } catch { /* missing or replaced presence is not ours */ }
}
/** Queue first. Missing readers and any queue/telemetry failure keep the old outbox path. */
export const deliverOwnerItem = <R>(params: { owner: string; agent?: string; home: string; session: string; project: string; item: OwnerNoteInput; send: (to: string, message: string) => Effect.Effect<CommsDelivery, never, R>; message?: string }) => Effect.gen(function* () {
  const resolved = resolveOwner(params);
  const route = yield* Effect.try({ try: () => ownerRoute(resolved.owner, params.home), catch: error => new StoreError({ path: ownerPath(resolved.owner, params.home), message: String(error) }) });
  const owner = route.owner;
  const note = params.item.mention === params.owner ? { ...params.item, mention: owner } : params.item;
  let item: OwnerItem | undefined;
  let queueError: unknown;
  try { item = appendOwnerItem(owner, note, params.home); } catch (error) { queueError = error; }
  const woke = item ? mentions(item, owner) : note.mention === owner || wakeKind(params.item.kind);
  if (!item && !woke) return yield* new StoreError({ path: ownerPath(params.owner, params.home), message: `silent owner note not queued: ${String(queueError)}` });
  let path: "queue" | "intercom" = item && (!woke || readerFresh(owner, params.home)) ? "queue" : "intercom";
  const logged = relayEvent({ ts: new Date().toISOString(), session: params.session, project: params.project, kind: "owner_note", noteKind: params.item.kind, woke, path, ...(item ? { itemId: item.uri } : {}) }, params.home);
  if (!logged && woke) path = "intercom";
  const delivery = path === "intercom" ? yield* params.send(owner, params.message ?? `Owner notice from ${params.item.author} (${params.item.lane ?? ""}): [${params.item.kind}] ${params.item.title.slice(0, 200)}${params.item.body ? `\n${capBody(params.item.body)}` : ""}${params.item.refs?.length ? `\nrefs: ${params.item.refs.join(", ")}` : ""}`) : { status: "queued" as const, detail: "owner queue" };
  return { id: item?.uri ?? null, uri: item?.uri ?? null, queued: !!item, woke, path, delivery, owner, resolution: resolved.resolution };
});
