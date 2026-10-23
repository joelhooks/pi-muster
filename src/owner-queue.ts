import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { decodeOwnerItem, decodeOwnerReader, decodeOwnerSession, decodeProject } from "./domain.ts";
import type { OwnerItem, OwnerKind } from "./domain.ts";
import { projectPath } from "./store.ts";
import { StoreError } from "./errors.ts";
import { POST_NSID, MENTION_NSID } from "./owner-lexicon.ts";
import type { CommsDelivery, CommsShape } from "./runtime.ts";
import { readRemoteBinding, writeRemoteNoteSidecar } from "./remote.ts";

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
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function readOwnerSources(owner: string, home = homedir()) {
  const read = readOwnerQueue(owner, home);
  return [{ source: owner, cursor: read.cursor, items: read.items, aliases: [] as string[] }];
}
/** Read only appended bytes. A replaced/truncated queue resets this session-local projection. */
export function ownerSourceReader(owner: string, home = homedir(), observe?: (event: { path: string; bytes: number; lines: number }) => void) {
  const path = ownerPath(owner, home);
  let queue: { ino: number; dev: number; size: number; tail: Buffer; read: ReturnType<typeof readOwnerQueue> } | undefined;
  let running: Promise<ReturnType<typeof readOwnerSources>> | undefined;
  const refresh = async () => {
    let handle;
    try { handle = await open(path, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; queue = undefined; return readOwnerSources(owner, home); }
    try {
      const stat = await handle.stat();
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
        try { queue.read.items.push({ item: decodeOwnerItem(JSON.parse(line)), line: queue.read.cursor }); } catch { /* malformed lines count */ }
      }
      queue.tail = raw.subarray(end + 1); queue.size += bytes;
      observe?.({ path, bytes, lines: lines.length });
      return [{ source: owner, cursor: queue.read.cursor, items: queue.read.items, aliases: [] as string[] }];
    } finally { await handle.close(); }
  };
  return {
    event: (name: string | undefined) => name === undefined || name === `${owner}.jsonl`,
    read() { if (!running) running = refresh().finally(() => { running = undefined; }); return running; },
  };
}
function ownerProject(project: string): string {
  try { return decodeProject(JSON.parse(readFileSync(projectPath(project), "utf8"))).slug; }
  catch { return project === process.env.MUSTER_PROJECT ? process.env.MUSTER_PROJECT_SLUG ?? project : project; }
}
export function resolveOwner(params: { owner: string; project: string; agent?: string; home: string }) {
  if (!params.agent) return { owner: params.owner, resolution: "explicit recipient" };
  const binding = readRemoteBinding(process.env, params.agent);
  if (binding) return { owner: binding.owner, resolution: "pushed binding" };
  try {
    const project = decodeProject(JSON.parse(readFileSync(projectPath(params.project), "utf8")));
    const row = project.agents.find(row => row.name === params.agent);
    if (row) return { owner: row.owner, resolution: "catalog row" };
    return { owner: params.owner, resolution: "MUSTER_OWNER fallback: no catalog row" };
  } catch { return { owner: params.owner, resolution: "MUSTER_OWNER fallback: catalog unreadable" }; }
}
export function findOwnerPost(session: string, uri: string, home = homedir()) {
  const post = readOwnerQueue(session, home).items.find(({ item }) => item.uri === uri)?.item;
  if (!post) throw new Error(`post not found in this session's queue: ${uri}`);
  return post;
}
export function appendOwnerItem(owner: string, input: OwnerNoteInput, home = homedir(), persist = true): OwnerItem {
  decodeOwnerSession(owner);
  const author = decodeOwnerSession(input.author);
  const parent = input.replyTo ? findOwnerPost(author, input.replyTo, home) : undefined;
  const mention = input.mention ?? (wakeKind(input.kind) ? owner : undefined);
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
    const path = ownerPath(owner, home); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(item)}\n`, { mode: 0o600 });
  }
  return item;
}
export function ingestOwnerItem(owner: string, value: OwnerItem, home = homedir(), project?: string): boolean {
  const item = decodeOwnerItem(value);
  if (project !== undefined && item.project !== undefined && item.project !== project) throw new Error("owner item project mismatch");
  if (readOwnerQueue(owner, home).items.some(record => record.item.uri === item.uri || record.item.cid === item.cid)) return false;
  const path = ownerPath(owner, home); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(item)}\n`, { mode: 0o600 }); return true;
}
export function readOwnerQueue(owner: string, home = homedir()): { items: Array<{ item: OwnerItem; line: number }>; cursor: number } {
  let raw: string;
  try { raw = readFileSync(ownerPath(owner, home), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [], cursor: 0 }; throw error; }
  const lines = raw.split("\n"); lines.pop();
  const items: Array<{ item: OwnerItem; line: number }> = [];
  lines.forEach((line, index) => { try { items.push({ item: decodeOwnerItem(JSON.parse(line)), line: index + 1 }); } catch { /* count malformed lines */ } });
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
    } catch { /* a live PID alone is not evidence of reuse */ }
    return true;
  } catch { return false; }
}
export function writeReader(owner: string, home = homedir(), now = Date.now(), pid = process.pid, startedAt = new Date(now).toISOString()) {
  const path = readerPath(owner, home); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ pid, startedAt, heartbeatAt: new Date(now).toISOString() }), { mode: 0o600 }); renameSync(temp, path);
}
export async function writeReaderAsync(owner: string, home = homedir(), now = Date.now(), pid = process.pid, startedAt = new Date(now).toISOString()) {
  const path = readerPath(owner, home); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${pid}.${randomBytes(4).toString("hex")}.tmp`;
  try { await writeFile(temp, JSON.stringify({ pid, startedAt, heartbeatAt: new Date(now).toISOString() }), { mode: 0o600 }); await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
export function retireReader(owner: string, home: string, startedAt: string) {
  try { const reader = decodeOwnerReader(JSON.parse(readFileSync(readerPath(owner, home), "utf8"))); if (reader.pid === process.pid && reader.startedAt === startedAt) writeReader(owner, home, 0, process.pid, startedAt); }
  catch { /* missing or replaced presence is not ours */ }
}
/** The short code in a `NOT DELIVERED: <code>: ...` detail. */
export const sendFailureCode = (detail: string | undefined) => (detail ?? "").replace(/^NOT DELIVERED:\s*/, "").split(/:| \(/)[0]?.trim().slice(0, 60) || "unknown";
/** All posts, including silent notes and replies, cross pi-ratking. No local delivery fallback. */
export const deliverOwnerItem = <R>(params: { owner: string; agent?: string; home: string; session: string; project: string; item: OwnerNoteInput; comms?: CommsShape; send: (to: string, message: string) => Effect.Effect<CommsDelivery, never, R>; message?: string }) => Effect.gen(function* () {
  const { owner, resolution } = resolveOwner(params);
  const note = params.item.mention === params.owner ? { ...params.item, mention: owner } : params.item;
  const item = yield* Effect.try({ try: () => appendOwnerItem(owner, { ...note, project: ownerProject(params.project) }, params.home, false), catch: () => new StoreError({ path: "owner ratking record", message: "owner ratking record refused" }) });
  const delivery = params.comms?.postOwner ? yield* params.comms.postOwner(owner, item) : { status: "failed" as const, detail: "pi-ratking not loaded" };
  const { ratkingReceipt } = yield* Effect.promise(() => import("./comms-ratking.ts"));
  const result = yield* ratkingReceipt({ home: params.home, id: item.uri, at: new Date().toISOString(), to: owner, sender: params.session, delivery }).pipe(Effect.mapError(error => new StoreError({ path: "ratking receipt", message: error.message })));
  // A failed send must not lose the note: park it where the owner's next pass reads it. Same URI as the send, so a later delivery dedupes.
  const failureCode = result.lost ? sendFailureCode(delivery.detail) : undefined;
  const remote = process.env.MUSTER_MACHINE !== undefined && process.env.MUSTER_MACHINE !== "" && process.env.MUSTER_MACHINE !== "local";
  const stored = !result.lost ? undefined : remote
    ? (writeRemoteNoteSidecar(process.env, { project: item.project ?? ownerProject(params.project), owner, item, sendFailed: failureCode! }) ? "sidecar" as const : undefined)
    : (() => { try { ingestOwnerItem(owner, item, params.home); return "local-queue" as const; } catch { return undefined; } })();
  return { id: item.uri, uri: item.uri, queued: !result.lost || stored !== undefined, woke: delivery.status === "delivered" && mentions(item, owner), path: "ratking" as const, delivery, owner, resolution, pendingPull: false, lost: result.lost && stored === undefined, ...(stored ? { stored } : {}), ...(failureCode ? { failureCode } : {}) };
});
