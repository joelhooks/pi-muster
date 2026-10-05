import { stripVTControlCharacters } from "node:util";
import { Effect } from "effect";
import type { Role, Roster, Thinking } from "./domain.ts";
import { InputError } from "./errors.ts";
import { Proc } from "./runtime.ts";

export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  opus: "claude-bridge/claude-opus-5-5",
  sol: "openai-codex/gpt-6.1-sol",
};
export const modelAliases = (roster?: Roster): Readonly<Record<string, string>> => ({ ...DEFAULT_ALIASES, ...roster?.aliases });

/** Joel's named exceptions to a fleet-wide refusal: one project, one exact route, his words. */
export const MODEL_EXCEPTIONS: ReadonlyArray<{ project: string; model: string; ruling: string; date: string }> = [
  { project: "front-desk", model: "claude-bridge/claude-sonnet-5-5", ruling: "front desk needs to be opus 5 5 and sonnet 5 5", date: "2026-10-04" },
];
/** Joel's exceptions for one role in any project: opt-in routes, never defaults. */
export const ROLE_MODEL_EXCEPTIONS: ReadonlyArray<{ role: Role; model: string; ruling: string; date: string }> = [
  { role: "worker", model: "claude-bridge/claude-sonnet-5-5", ruling: "we can offer exploratry use of sonnet 55 for workers", date: "2026-10-05" },
];
const allowed = (model: string, project?: string, role?: Role) =>
  MODEL_EXCEPTIONS.some((e) => e.project === project && e.model === model) || ROLE_MODEL_EXCEPTIONS.some((e) => e.role === role && e.model === model);

function refuse(model: string, project?: string, role?: Role) {
  if (/fable/i.test(model)) throw new Error("Fable is off fleet-wide (Joel, 2026-10-04); use opus");
  if (/sonnet/i.test(model) && !allowed(model, project, role)) throw new Error("Sonnet is not used (Joel, 2026-10-03; workers may opt into claude-bridge/claude-sonnet-5-5); use sol or opus");
}

export function resolveModel(choice: string, roster?: Roster, project?: string, role?: Role): { model: string; thinking?: Thinking } {
  if (/fable/i.test(choice) || (/sonnet/i.test(choice) && !choice.includes("/"))) refuse(choice, project, role); // a bare alias never matches an exception route
  const suffix = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(choice);
  const name = suffix ? choice.slice(0, suffix.index) : choice;
  const aliases = modelAliases(roster);
  const model = name.includes("/") ? name : aliases[name];
  if (!model) throw new Error(`Unknown model alias ${name}; aliases: ${Object.keys(aliases).sort().join(", ")}`);
  refuse(model, project, role);
  if (!/^[^/\s:]+\/[^/\s:]+$/.test(model)) throw new Error(`Invalid model route ${model}; expected provider/model`);
  const thinking = suffix?.[1];
  switch (thinking) {
    case "off": case "minimal": case "low": case "medium": case "high": case "xhigh": case "max": return { model, thinking };
    default: return { model };
  }
}

/** Pi's authenticated-model table, not the full registry. Ignore ANSI and headings. */
export function parseRunnableModels(output: string): string[] {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const header = lines.findIndex((line) => /^provider\s+model\s+context\s+max-out\s+thinking\s+images\s*$/.test(line.trim()));
  if (header < 0) return [];
  return [...new Set(lines.slice(header + 1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.length >= 6 && /^[\w.-]+$/.test(fields[0] ?? "") && /^[\w.-]+$/.test(fields[1] ?? "")
      ? [`${fields[0]}/${fields[1]}`] : [];
  }))];
}

export function workingRoutes(model: string, runnable: readonly string[]): string[] {
  const id = model.slice(model.indexOf("/") + 1);
  const candidates = runnable.filter((route) => !/sonnet|fable/i.test(route) && route.slice(route.indexOf("/") + 1).startsWith(id));
  return candidates.sort((a, b) => {
    const rank = (route: string) => (id.startsWith("claude-") && route.startsWith("claude-bridge/") ? 0 : 2)
      + (route.slice(route.indexOf("/") + 1) === id ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  }).slice(0, 3);
}

export function parseModelWindows(output: string): ReadonlyMap<string, number> {
  const routes = new Set(parseRunnableModels(output));
  const windows = new Map<string, number>();
  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const [provider, id, context] = line.trim().split(/\s+/);
    const route = `${provider}/${id}`;
    const match = /^(\d+(?:\.\d+)?)([KM]?)$/i.exec(context ?? "");
    if (!routes.has(route) || !match) continue;
    const size = Number(match[1]) * (match[2]?.toUpperCase() === "M" ? 1_000_000 : match[2]?.toUpperCase() === "K" ? 1000 : 1);
    if (size > 0) windows.set(route, size);
  }
  return windows;
}

export function restoreContextNote(model: string, tokens: number | null, windows: ReadonlyMap<string, number>): string | null {
  const window = windows.get(model);
  if (!window || tokens === null) return `restore context ${tokens ?? "unknown"} tokens; ${model} window ${window ?? "unknown"}; warning: context check unavailable, proceeding`;
  const fits = [...windows].filter(([route, size]) => size >= tokens && !/sonnet|fable/i.test(route)).sort((a, b) => a[1] - b[1]);
  const suggestion = fits[0] ? `use ${fits[0][0]} (${fits[0][1]} window)` : "no authenticated model with a fitting window listed";
  if (tokens > window) throw new Error(`restore refused: ${tokens} context tokens exceed ${model} window ${window} (${Math.round(tokens / window * 100)}%); ${suggestion}`);
  return tokens > window * 0.8 ? `restore context ${tokens} tokens / ${model} window ${window} (${Math.round(tokens / window * 100)}%); warning: above 80%; ${suggestion}` : null;
}

const listRunnableModels = (cwd: string) => Effect.gen(function* () {
  const proc = yield* Proc;
  return yield* proc.run("pi", ["--list-models"], { cwd, timeoutMs: 20_000 }).pipe(
    Effect.map((result) => result.code === 0
      ? { models: parseRunnableModels(result.stdout), windows: parseModelWindows(result.stdout), reason: "empty or unrecognized model list" }
      : { models: [] as string[], windows: new Map<string, number>(), reason: result.stderr.trim() || `pi --list-models exited ${result.code}` }),
    Effect.catch((error) => Effect.succeed({ models: [] as string[], windows: new Map<string, number>(), reason: error.message })),
  );
});

/** Remote launches historically prove auth in the pane; restore adds a window check, not a new auth gate. */
export const checkRestoreContext = (model: string, cwd: string, tokens: number | null) => Effect.gen(function* () {
  const listing = yield* listRunnableModels(cwd);
  const note = yield* Effect.try({
    try: () => restoreContextNote(model, tokens, listing.windows),
    catch: error => new InputError({ message: error instanceof Error ? error.message : String(error) }),
  });
  return listing.models.length === 0 ? `${note}; model listing unavailable: ${listing.reason}` : note;
});

export const checkRunnableModel = (model: string, cwd: string, context?: { tokens: number | null }) => Effect.gen(function* () {
  const listing = yield* listRunnableModels(cwd);
  if (listing.models.length === 0) return `model check skipped: ${listing.reason}${context ? `; ${restoreContextNote(model, context.tokens, listing.windows)}` : ""}`;
  if (listing.models.includes(model)) return context ? yield* Effect.try({
    try: () => restoreContextNote(model, context.tokens, listing.windows),
    catch: error => new InputError({ message: error instanceof Error ? error.message : String(error) }),
  }) : null;
  const routes = workingRoutes(model, listing.models);
  const alias = Object.entries(DEFAULT_ALIASES).find(([, route]) => route === routes[0])?.[0];
  return yield* new InputError({ message: `${model} has no auth here; ${routes.length ? `use ${routes.join(", ")}${alias ? ` (alias ${alias})` : ""}` : "no working route found in pi --list-models"}` });
});

// Pi 0.79.10: dist/modes/interactive/components/assistant-message.js,
// AssistantMessageComponent.updateContent(stopReason === "error"), and
// dist/modes/interactive/interactive-mode.js, InteractiveMode.showError,
// both render `Error: ${errorMessage}` via Text(..., 1, 0). Prose is not an error.
export const MODEL_ERROR_PATTERNS = [
  { pattern: /^\s*Error:\s*No API key found for \S+/i, severity: "error" },
  { pattern: /^\s*Error:.*\b401\b/i, severity: "error" },
  { pattern: /^\s*Error:.*\bUnauthorized\b/i, severity: "error" },
  { pattern: /^\s*Error:.*\binvalid api key\b/i, severity: "error" },
  { pattern: /^\s*Error:.*\bauthentication failed\b/i, severity: "error" },
  { pattern: /^\s*Error:\s*Model .* not found\b/i, severity: "error" },
  { pattern: /^\s*Error:\s*Unknown model\b/i, severity: "error" },
  { pattern: /^\s*Error:\s*No models available\b/i, severity: "error" },
  { pattern: /^\s*Error:.*\brate limit exceeded\b/i, severity: "warning" },
] as const;
export function modelOutputIssue(output: string) {
  const lines = stripVTControlCharacters(output).split(/\r?\n/);
  // pi-tui dist/components/editor.js, Editor.render: top and bottom horizontal
  // borders (createScrollBorder adds ↑/↓ N more). Exclude the final editor pair,
  // its text and all footer/status rows. One border means the chat was clipped:
  // fail conservatively rather than classify text typed into the editor.
  const borders = lines.flatMap((line, index) => /^\s*─{3,}(?:\s*[↑↓]\s+\d+ more\s*─*)?\s*$/.test(line) ? [index] : []);
  if (borders.length === 1) return null;
  const chat = borders.length >= 2 ? lines.slice(0, borders[borders.length - 2]) : lines;
  const line = chat.filter((value) => value.trim().length > 0).at(-1);
  if (!line) return null;
  const match = MODEL_ERROR_PATTERNS.find(({ pattern }) => pattern.test(line));
  return match ? { line: line.trim().slice(0, 1500), severity: match.severity } : null;
}
