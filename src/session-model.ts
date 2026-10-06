import { Schema } from "effect";
import { Thinking } from "./domain.ts";
import type { LaunchProfile, Roster, Role } from "./domain.ts";
import { resolveModel } from "./models.ts";

export interface SessionModel {
  readonly model?: string;
  readonly switchedAt?: string;
  readonly thinking?: Thinking;
  readonly contextTokens: number | null;
}
type Entry = Record<string, unknown>;
type ModelLookup = (provider: string, id: string) => { virtual: boolean } | undefined;

/** Drop message bodies before retaining journal entries in memory or sending them over SSH. */
function restoreEntry(raw: unknown): Entry | undefined {
  const object = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!object(raw) || raw.type === "session") return undefined;
  const base = { type: raw.type, id: raw.id, parentId: raw.parentId, timestamp: raw.timestamp };
  if (raw.type === "model_change") return { ...base, provider: raw.provider, modelId: raw.modelId };
  if (raw.type === "thinking_level_change") return { ...base, thinkingLevel: raw.thinkingLevel };
  const message = raw.message;
  if (raw.type !== "message" || !object(message) || message.role !== "assistant") return base;
  const usage = message.usage;
  return { ...base, message: { role: "assistant", provider: message.provider, model: message.model, api: message.api, stopReason: message.stopReason,
    ...(object(usage) ? { usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens } } : {}) } };
}

/** Self-contained so SSH executes the same branch/evidence projection as the local reader.
 * Pi 1.0.3 session-manager buildSessionPath and virtual-models getBranchSelection.
 * Keep original links; the envelope explicitly identifies an already selected branch.
 */
function projectRestoreEntries(raw: unknown[]): Entry[] {
  const object = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  const entries = raw.filter(object).filter(entry => entry.type !== "session");
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch: Entry[] = [];
  const seen = new Set<Entry>();
  let current = entries.at(-1);
  while (current && !seen.has(current)) {
    branch.push(current); seen.add(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  branch.reverse();
  let change: Entry | undefined, thinking: Entry | undefined, assistant: Entry | undefined, previousChange: Entry | undefined, usage: Entry | undefined;
  for (const entry of branch) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") change = entry;
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(entry.thinkingLevel)) thinking = entry;
    const message = entry.message;
    if (entry.type !== "message" || !object(message) || message.role !== "assistant") continue;
    if (message.api !== "pi-virtual" && typeof message.provider === "string" && typeof message.model === "string") {
      assistant = entry; previousChange = change;
    }
    if (message.stopReason !== "error" && message.stopReason !== "aborted" && object(message.usage)) {
      const u = message.usage;
      if ((number(u.totalTokens) || number(u.input) + number(u.output) + number(u.cacheRead) + number(u.cacheWrite)) > 0) usage = entry;
    }
  }
  const keep = new Set([change, thinking, assistant, previousChange, usage]);
  return branch.filter(entry => keep.has(entry)).map(entry => {
    const base = { type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
    if (entry.type === "model_change") return { ...base, provider: entry.provider, modelId: entry.modelId };
    if (entry.type === "thinking_level_change") return { ...base, thinkingLevel: entry.thinkingLevel };
    const message = entry.message;
    if (!object(message)) return base;
    const u = message.usage;
    return { ...base, message: { role: "assistant", provider: message.provider, model: message.model, api: message.api, stopReason: message.stopReason,
      ...(object(u) ? { usage: { input: number(u.input), output: number(u.output), cacheRead: number(u.cacheRead), cacheWrite: number(u.cacheWrite), totalTokens: number(u.totalTokens) } } : {}) } };
  });
}
/** Remote projection: at most five metadata entries, never transcript content. */
export const SESSION_MODEL_READ_SCRIPT = `
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
const entries = [];
const restoreEntry = ${restoreEntry.toString()};
for await (const line of createInterface({ input: createReadStream(process.argv[1]), crlfDelay: Infinity })) {
  try { const entry = restoreEntry(JSON.parse(line)); if (entry) entries.push(entry); } catch { /* partial write */ }
}
const projectRestoreEntries = ${projectRestoreEntries.toString()};
process.stdout.write(JSON.stringify({ type: 'muster_restore_branch', entries: projectRestoreEntries(entries) }));
`;
const object = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);
const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Read the last complete entry's parent path, not discarded file-wide changes.
 * No virtual models are registered by default; a catalog lookup can retain a virtual change.
 */
export function parseSessionModel(text: string, getModel?: ModelLookup): SessionModel {
  const raw: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const parsed: unknown = JSON.parse(line);
      const entry = object(parsed) && parsed.type === "muster_restore_branch" ? parsed : restoreEntry(parsed);
      if (entry) raw.push(entry);
    } catch { /* partial write */ }
  }
  const envelope = raw.length === 1 ? raw[0] : undefined;
  const branch = object(envelope) && envelope.type === "muster_restore_branch" && Array.isArray(envelope.entries)
    ? envelope.entries.filter(object) : projectRestoreEntries(raw);
  let model: string | undefined;
  let switchedAt: string | undefined;
  let thinking: Thinking | undefined;
  let contextTokens: number | null = null;
  let change: { model: string; provider: string; id: string; timestamp?: string } | undefined;
  for (const entry of branch) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      change = { model: `${entry.provider}/${entry.modelId}`, provider: entry.provider, id: entry.modelId, ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}) };
      model = change.model; switchedAt = change.timestamp;
    }
    if (entry.type === "thinking_level_change") {
      try { thinking = Schema.decodeUnknownSync(Thinking)(entry.thinkingLevel); } catch { /* future thinking level */ }
    }
    const message = entry.message;
    if (entry.type !== "message" || !object(message) || message.role !== "assistant") continue;
    if (message.api !== "pi-virtual" && typeof message.provider === "string" && typeof message.model === "string") {
      const physical = `${message.provider}/${message.model}`;
      model = change && getModel?.(change.provider, change.id)?.virtual ? change.model : physical;
      switchedAt = change?.model === model ? change.timestamp : undefined;
    }
    if (message.stopReason !== "error" && message.stopReason !== "aborted" && object(message.usage)) {
      const usage = message.usage;
      const total = tokens(usage.totalTokens) || tokens(usage.input) + tokens(usage.output) + tokens(usage.cacheRead) + tokens(usage.cacheWrite);
      if (total > 0) contextTokens = total;
    }
  }
  return { ...(model ? { model } : {}), ...(switchedAt ? { switchedAt } : {}), ...(thinking ? { thinking } : {}), contextTokens };
}

export function restoreProfile({ profile, live, model, thinking, roster, project, role }: {
  profile: LaunchProfile; live: SessionModel; model?: string; thinking?: Thinking; roster?: Roster; project?: string; role?: Role;
}): { profile: LaunchProfile; note: string } {
  const selected = resolveModel(model ?? live.model ?? profile.model, roster, project, role);
  const next = { ...profile, model: selected.model, thinking: thinking ?? selected.thinking ?? live.thinking ?? profile.thinking };
  const time = live.switchedAt && !Number.isNaN(Date.parse(live.switchedAt)) ? new Date(live.switchedAt).toISOString().slice(11, 16) + "Z" : null;
  const source = model !== undefined ? "explicit model" : live.model ? `session${time ? `, switched ${time}` : ""}` : "launch profile";
  return { profile: next, note: `model: ${next.model}:${next.thinking} (from ${source})` };
}
