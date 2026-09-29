import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

/** Provider cache TTL. A wake inside it reads a warm prefix; past it the whole prefix is written again. */
export const CACHE_TTL_MS = 60 * 60_000;

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

/**
 * Cache cost in input-token equivalents: reads bill at 0.1x, writes at 1.25x.
 * Reads dominate (about 85% of cache cost on the fleet), and the fixed prefix
 * is about a quarter of all reads, so this is the number an owner trims.
 */
export function turnCost(usage: Usage): number {
  return usage.cacheRead * 0.1 + usage.cacheWrite * 1.25 + usage.input;
}

export interface SessionCost {
  readonly turns: number;
  readonly cost: number;
  readonly lastTurnCost: number | null;
  /** Context size of the newest turn, from its usage. Never scraped from a footer. */
  readonly contextTokens: number | null;
  readonly model: string | null;
  /**
   * The newest turn failed in the Claude bridge's prompt capture and no user
   * message came after it. Timer and intercom wakes skip the hook that records
   * a prompt, so such a lane stays dead until someone types to it.
   */
  readonly captureStuck: { readonly error: string; readonly afterRefresh: boolean } | null;
  /** Text of the newest user message; tells a failed refresh from a fresh failure. */
  readonly lastUserText: string | null;
}

const EMPTY: SessionCost = { turns: 0, cost: 0, lastTurnCost: null, contextTokens: null, model: null, captureStuck: null, lastUserText: null };
const CAPTURE_ERROR = "prompt-capture:";

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageFromLine(line: string): { usage: Usage; model: string | null } | null {
  if (!line.includes('"usage"')) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof entry !== "object" || entry === null) return null;
  const message = (entry as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const { role, usage, model } = message as { role?: unknown; usage?: unknown; model?: unknown };
  if (role !== "assistant" || typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const parts = { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite) };
  const total = num(u.totalTokens) || parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
  return { usage: { ...parts, totalTokens: total }, model: typeof model === "string" ? model : null };
}

export function costFromLines(lines: Iterable<string>, refreshMark = ""): SessionCost {
  let acc = EMPTY;
  for (const line of lines) acc = fold(acc, line, refreshMark);
  return acc;
}

function userText(line: string): string | null {
  if (!line.includes('"role":"user"')) return null;
  try {
    const content = (JSON.parse(line) as { message?: { role?: unknown; content?: unknown } }).message;
    if (content?.role !== "user") return null;
    if (typeof content.content === "string") return content.content;
    if (!Array.isArray(content.content)) return "";
    return content.content.map((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
  } catch {
    return null;
  }
}

function captureError(line: string): string | null {
  if (!line.includes(CAPTURE_ERROR)) return null;
  try {
    const message = (JSON.parse(line) as { message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } }).message;
    return message?.role === "assistant" && message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.startsWith(CAPTURE_ERROR)
      ? message.errorMessage
      : null;
  } catch {
    return null;
  }
}

/** `refreshMark` names Muster's own refresh message, so a failure right after it reads as `afterRefresh`. */
function fold(acc: SessionCost, line: string, refreshMark = ""): SessionCost {
  const text = userText(line);
  if (text !== null) return { ...acc, captureStuck: null, lastUserText: text };
  const parsed = usageFromLine(line);
  if (!parsed) return acc;
  const cost = turnCost(parsed.usage);
  const error = captureError(line);
  return {
    ...acc,
    captureStuck: error ? { error, afterRefresh: refreshMark !== "" && (acc.lastUserText ?? "").startsWith(refreshMark) } : null,
    turns: acc.turns + 1,
    cost: acc.cost + cost,
    lastTurnCost: cost,
    contextTokens: parsed.usage.totalTokens,
    model: parsed.model ?? acc.model,
  };
}

/** Streams the JSONL; long-lived owner sessions run to hundreds of megabytes. */
export async function readSessionCost(path: string, refreshMark = ""): Promise<SessionCost> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let acc = EMPTY;
  for await (const line of lines) acc = fold(acc, line, refreshMark);
  return acc;
}

export function sessionMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
