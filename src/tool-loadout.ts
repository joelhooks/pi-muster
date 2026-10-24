import { NAME_SHIM } from "./argv.ts";
import { forEachJsonlLine } from "./restart-snapshot.ts";

/**
 * Pi's `--tools` drops a name it doesn't know without a word, so a role policy's typo or a renamed extension tool launches
 * an agent that can't call it: a judge without packet_report runs blind (Tin-Tin and Switchboard, #22 review). The
 * session journal is the truth. Its system messages carry `toolsRemoved` and `toolsAdded`, which pi-ai's getCurrentTools
 * folds in order and a resume restores from, so Muster folds the same lines after proof of life.
 */
export interface ToolLoadout { readonly declared: boolean; readonly tools: readonly string[] }

/** One journal line's tool delta, or null when the line is not a system message. Stringified into the remote script. */
export const toolDelta = (line: string): { removed: string[]; added: string[] } | null => {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  const message = typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "message" ? (entry as { message?: unknown }).message : null;
  if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "system") return null;
  const names = (list: unknown): string[] => Array.isArray(list)
    ? list.flatMap(tool => typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string" ? [(tool as { name: string }).name] : [])
    : [];
  const { toolsRemoved, toolsAdded } = message as { toolsRemoved?: unknown; toolsAdded?: unknown };
  return { removed: names(toolsRemoved), added: names(toolsAdded) };
};

/** Fold one delta as getCurrentTools does: removals first, then additions. A session that never adds a tool declares none. */
export const applyToolDelta = (state: { declared: boolean; tools: Set<string> }, delta: { removed: string[]; added: string[] }) => {
  for (const name of delta.removed) state.tools.delete(name);
  for (const name of delta.added) state.tools.add(name);
  if (delta.added.length > 0) state.declared = true;
};

/**
 * Streams, so a large restored journal stays in bounded memory. Linear journals only: a fresh launch or a restart
 * snapshot, where file order is branch order. A live journal after agent_rewind keeps abandoned branches in file order.
 */
export function readToolLoadout(path: string): ToolLoadout {
  const state = { declared: false, tools: new Set<string>() };
  forEachJsonlLine(path, line => { const delta = toolDelta(line); if (delta) applyToolDelta(state, delta); });
  return { declared: state.declared, tools: [...state.tools] };
}

export const TOOL_LOADOUT_READ_SCRIPT = `
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
${NAME_SHIM}
const toolDelta = ${toolDelta.toString()};
const applyToolDelta = ${applyToolDelta.toString()};
const state = { declared: false, tools: new Set() };
for await (const line of createInterface({ input: createReadStream(process.argv[1]), crlfDelay: Infinity })) {
  const delta = toolDelta(line);
  if (delta) applyToolDelta(state, delta);
}
process.stdout.write(JSON.stringify({ declared: state.declared, tools: [...state.tools] }));
`;

/**
 * A listed tool missing from the session is a failure. Active tools beyond the list are an alarm only: codemode and
 * Pi's own additions may declare more. A session that declares no tools leaves the check unchecked, not failed.
 */
export function toolLoadoutVerdict(requested: readonly string[], loadout: ToolLoadout): { failure: string | null; note: string | null } {
  if (!loadout.declared) return { failure: null, note: "⚠ tool loadout unchecked: the session journal declares no tools" };
  const active = new Set(loadout.tools);
  const missing = requested.filter(name => !active.has(name));
  const listed = new Set(requested);
  const extra = loadout.tools.filter(name => !listed.has(name));
  return {
    failure: missing.length ? `tool loadout: ${missing.join(", ")} not active (Pi's --tools drops unknown names silently); active: ${loadout.tools.join(", ") || "none"}` : null,
    note: extra.length ? `⚠ tool loadout: active beyond the role policy: ${extra.join(", ")}` : null,
  };
}

type OwnTool = { readonly name: string; readonly exposure?: string; readonly sourceInfo?: { readonly path?: string } };

/**
 * calendar-app lime, 2026-10-24: a Pi resumed by hand without MUSTER_ROLE skipped the worker tools, the journal recorded
 * them as removed, and Pi restores a fork's active set from its journal, so `agent_launch restart` registered owner_note,
 * packet_report and context_mark but left them inactive. Muster's own tools that register active are reactivated at
 * session start. The extension's path comes from an always-registered tool; a `--tools` allowlist already hides unlisted
 * tools from getAllTools, so a lean row's choice stands.
 */
export function inactiveOwnTools(all: readonly OwnTool[], active: readonly string[], anchor = "owner_inbox"): string[] {
  const path = all.find(tool => tool.name === anchor)?.sourceInfo?.path;
  if (!path) return [];
  const on = new Set(active);
  return all.filter(tool => tool.sourceInfo?.path === path && (tool.exposure === "direct" || tool.exposure === "model-only") && !on.has(tool.name))
    .map(tool => tool.name);
}
