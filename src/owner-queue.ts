import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { decodeOwnerItem, decodeOwnerSession, decodeProject } from "./domain.ts";
import type { OwnerItem, OwnerKind } from "./domain.ts";
import { projectPath } from "./store.ts";
import { StoreError } from "./errors.ts";
import { POST_NSID, MENTION_NSID } from "./owner-lexicon.ts";
import type { CommsDelivery, CommsShape } from "./runtime.ts";
import { readRemoteBinding } from "./remote.ts";

export interface OwnerNoteInput { author: string; project?: string; lane?: string; kind: OwnerKind; title: string; body?: string; refs?: readonly string[]; replyTo?: string; mention?: string; text?: string; signed?: unknown }
export const mentions = (item: OwnerItem, reader: string) => item.facets?.some(f => Number.isInteger(f.index.byteStart) && Number.isInteger(f.index.byteEnd) && f.index.byteStart >= 0 && f.index.byteEnd > f.index.byteStart && f.index.byteEnd <= Buffer.byteLength(item.text) && f.features.some(feature => feature.$type === MENTION_NSID && feature.did === reader)) ?? false;
export const wakeKind = (kind: OwnerKind) => kind === "question" || kind === "blocked" || kind === "action";
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
/**
 * Build one signed-shape owner post. Slice 5 (Tin-Tin, audit 3) retired the JSONL owner queue: posts travel only as
 * Rat King mail, so a reply names its parent by uri and pi-ratking threads it by the message that carried that uri.
 */
export function ownerItem(owner: string, input: OwnerNoteInput): OwnerItem {
  decodeOwnerSession(owner);
  const author = decodeOwnerSession(input.author);
  const parent = input.replyTo ? { uri: input.replyTo, cid: "" } : undefined;
  const mention = input.mention ?? (wakeKind(input.kind) ? owner : undefined);
  if (mention) decodeOwnerSession(mention);
  const prefix = mention ? `@${mention} ` : "";
  const title = [...input.title.replace(/\r?\n/g, " ")].slice(0, 200).join("");
  const record = {
    $type: POST_NSID, uri: `muster://${author}/${POST_NSID}/${Date.now().toString(16).padStart(12, "0")}${randomBytes(6).toString("hex")}`,
    author, createdAt: new Date().toISOString(), text: `${prefix}${input.text === undefined ? `${title}${input.body === undefined ? "" : `\n${capBody(input.body)}`}` : capBody(input.text)}`, kind: input.kind,
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(input.lane ? { lane: input.lane } : {}), ...(input.refs ? { refs: input.refs } : {}),
    ...(parent ? { reply: { root: parent, parent } } : {}),
    ...(mention ? { facets: [{ index: { byteStart: 0, byteEnd: Buffer.byteLength(prefix.trimEnd()) }, features: [{ $type: MENTION_NSID, did: mention }] }] } : {}),
  };
  return decodeOwnerItem({ ...record, cid: createHash("sha256").update(canonicalJson(record)).digest("hex").slice(0, 32), ...(input.signed === undefined ? {} : { signed: input.signed }) });
}
/** The short code in a `NOT DELIVERED: <code>: ...` detail. */
export const sendFailureCode = (detail: string | undefined) => (detail ?? "").replace(/^NOT DELIVERED:\s*/, "").split(/:| \(/)[0]?.trim().slice(0, 60) || "unknown";
/** All posts, including silent notes and replies, cross pi-ratking. No local fallback: a send that still fails after
 * pi-ratking's retries is lost and says so loudly. */
export const deliverOwnerItem = <R>(params: { owner: string; agent?: string; home: string; session: string; project: string; item: OwnerNoteInput; comms?: CommsShape; send: (to: string, message: string) => Effect.Effect<CommsDelivery, never, R>; message?: string }) => Effect.gen(function* () {
  const { owner, resolution } = resolveOwner(params);
  const note = params.item.mention === params.owner ? { ...params.item, mention: owner } : params.item;
  const item = yield* Effect.try({ try: () => ownerItem(owner, { ...note, project: ownerProject(params.project) }), catch: () => new StoreError({ path: "owner ratking record", message: "owner ratking record refused" }) });
  const delivery = params.comms?.postOwner ? yield* params.comms.postOwner(owner, item) : { status: "failed" as const, detail: "pi-ratking not loaded" };
  const { ratkingReceipt } = yield* Effect.promise(() => import("./comms-ratking.ts"));
  const result = yield* ratkingReceipt({ home: params.home, id: item.uri, at: new Date().toISOString(), to: owner, sender: params.session, delivery }).pipe(Effect.mapError(error => new StoreError({ path: "ratking receipt", message: error.message })));
  const failureCode = result.lost ? sendFailureCode(delivery.detail) : undefined;
  return { id: item.uri, uri: item.uri, queued: !result.lost, woke: delivery.status === "delivered" && mentions(item, owner), path: "ratking" as const, delivery, owner, resolution, lost: result.lost, ...(failureCode ? { failureCode } : {}) };
});
