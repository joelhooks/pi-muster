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
/** Remote projection: never send transcript content across Proc's bounded stdout. */
export const SESSION_MODEL_READ_SCRIPT = `
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
let model, thinking, usage;
for await (const line of createInterface({ input: createReadStream(process.argv[1]), crlfDelay: Infinity })) {
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if (entry?.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string')
    model = { type: entry.type, provider: entry.provider, modelId: entry.modelId, timestamp: entry.timestamp };
  if (entry?.type === 'thinking_level_change' && ['off','minimal','low','medium','high','xhigh','max'].includes(entry.thinkingLevel))
    thinking = { type: entry.type, thinkingLevel: entry.thinkingLevel };
  const message = entry?.message;
  if (entry?.type === 'message' && message?.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted' && message.usage && typeof message.usage === 'object' && !Array.isArray(message.usage))
    usage = { type: 'message', message: { role: 'assistant', usage: { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, totalTokens: message.usage.totalTokens } } };
}
process.stdout.write([model, thinking, usage].filter(Boolean).map(entry => JSON.stringify(entry)).join('\\n'));
`;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Pure JSONL reader. Partial trailing writes and unrelated entries do not erase valid evidence. */
export function parseSessionModel(text: string): SessionModel {
  let model: string | undefined;
  let switchedAt: string | undefined;
  let thinking: Thinking | undefined;
  let contextTokens: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!object(entry)) continue;
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      model = `${entry.provider}/${entry.modelId}`;
      switchedAt = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    }
    if (entry.type === "thinking_level_change") {
      try { thinking = Schema.decodeUnknownSync(Thinking)(entry.thinkingLevel); } catch { /* unrelated or future thinking level */ }
    }
    const message = entry.message;
    if (entry.type === "message" && object(message) && message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && object(message.usage)) {
      const usage = message.usage;
      // Pi calculateContextTokens: totalTokens || input + output + cacheRead + cacheWrite.
      contextTokens = tokens(usage.totalTokens) || tokens(usage.input) + tokens(usage.output) + tokens(usage.cacheRead) + tokens(usage.cacheWrite);
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
