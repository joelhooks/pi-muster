import { Effect } from "effect";
import type { Roster, Thinking } from "./domain.ts";
import { InputError } from "./errors.ts";
import { Proc } from "./runtime.ts";

export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  opus: "claude-bridge/claude-opus-5-5",
  fable: "claude-bridge/claude-fable-5-1",
  sol: "openai-codex/gpt-6.1-sol",
};
export const modelAliases = (roster?: Roster): Readonly<Record<string, string>> => ({ ...DEFAULT_ALIASES, ...roster?.aliases });

export function resolveModel(choice: string, roster?: Roster): { model: string; thinking?: Thinking } {
  if (/sonnet/i.test(choice)) throw new Error("Sonnet is not used (Joel, 2026-10-03); use sol or opus");
  const suffix = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(choice);
  const name = suffix ? choice.slice(0, suffix.index) : choice;
  const aliases = modelAliases(roster);
  const model = name.includes("/") ? name : aliases[name];
  if (!model) throw new Error(`Unknown model alias ${name}; aliases: ${Object.keys(aliases).sort().join(", ")}`);
  if (/sonnet/i.test(model)) throw new Error("Sonnet is not used (Joel, 2026-10-03); use sol or opus");
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
  const candidates = runnable.filter((route) => !/sonnet/i.test(route) && route.slice(route.indexOf("/") + 1).startsWith(id));
  return candidates.sort((a, b) => {
    const rank = (route: string) => (id.startsWith("claude-") && route.startsWith("claude-bridge/") ? 0 : 2)
      + (route.slice(route.indexOf("/") + 1) === id ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  }).slice(0, 3);
}

export const checkRunnableModel = (model: string, cwd: string) => Effect.gen(function* () {
  const proc = yield* Proc;
  const listing = yield* proc.run("pi", ["--list-models"], { cwd, timeoutMs: 20_000 }).pipe(
    Effect.map((result) => result.code === 0
      ? { models: parseRunnableModels(result.stdout), reason: "empty or unrecognized model list" }
      : { models: [] as string[], reason: result.stderr.trim() || `pi --list-models exited ${result.code}` }),
    Effect.catch((error) => Effect.succeed({ models: [] as string[], reason: error.message })),
  );
  if (listing.models.length === 0) return `model check skipped: ${listing.reason}`;
  if (listing.models.includes(model)) return null;
  const routes = workingRoutes(model, listing.models);
  const alias = Object.entries(DEFAULT_ALIASES).find(([, route]) => route === routes[0])?.[0];
  return yield* new InputError({ message: `${model} has no auth here; ${routes.length ? `use ${routes.join(", ")}${alias ? ` (alias ${alias})` : ""}` : "no working route found in pi --list-models"}` });
});

export const MODEL_ERROR_PATTERNS = [
  { pattern: /No API key found/i, severity: "error" },
  { pattern: /\b401\b/i, severity: "error" },
  { pattern: /Unauthorized/i, severity: "error" },
  { pattern: /invalid api key/i, severity: "error" },
  { pattern: /authentication/i, severity: "error" },
  { pattern: /Model .* not found/i, severity: "error" },
  { pattern: /Unknown model/i, severity: "error" },
  { pattern: /No models available/i, severity: "error" },
  { pattern: /rate limit exceeded/i, severity: "warning" },
] as const;
export function modelOutputIssue(output: string) {
  const matches = output.split(/\r?\n/).flatMap((line) => {
    const match = MODEL_ERROR_PATTERNS.find(({ pattern }) => pattern.test(line));
    return match ? [{ line: line.trim().slice(0, 1500), severity: match.severity }] : [];
  });
  return matches.find((match) => match.severity === "error") ?? matches.at(-1) ?? null;
}
