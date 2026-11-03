import { readFileSync, watch } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { Effect } from "effect";

import { decodeReport, REPORT_SCHEMA } from "./desk-report.ts";

export type CallsSummary =
  | { readonly kind: "ready"; readonly count: number; readonly titles: readonly string[]; readonly url?: string }
  | { readonly kind: "unreadable"; readonly basename: string };

/** Reuse the page decoder and its group/item order, not the fleet's urgency order. */
export function readCalls(path: string, url?: string): CallsSummary {
  try {
    if (!isAbsolute(path)) throw new Error("Calls path must be absolute");
    const report = Effect.runSync(Effect.try(() => JSON.parse(readFileSync(path, "utf8"))).pipe(Effect.flatMap(decodeReport)));
    if (report.schema !== REPORT_SCHEMA) throw new Error("Unknown report schema");
    const titles = report.groups.flatMap(group => report.items.filter(item => item.group === group.key)).slice(0, 3).map(item => item.title);
    return { kind: "ready", count: report.items.length, titles, url };
  } catch {
    return { kind: "unreadable", basename: basename(path) };
  }
}

/** Activation only. No env means no read, watcher or timer. Never polls or pages the model. */
export function watchCalls(env: Readonly<Record<string, string | undefined>>, changed: (summary: CallsSummary) => void): (() => void) | undefined {
  const path = env.MUSTER_SWITCHBOARD_CALLS;
  if (!path) return undefined;
  const load = () => changed(readCalls(path, env.MUSTER_SWITCHBOARD_CALLS_URL));
  load();
  if (!isAbsolute(path)) return undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  try {
    // Directory watch survives atomic replacement and observes a missing file's creation.
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename !== null && String(filename) !== basename(path)) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = undefined; load(); }, 200);
    });
    watcher.on("error", () => { watcher.close(); });
    return () => { watcher.close(); if (pending) clearTimeout(pending); };
  } catch {
    // The initial read already supplies the fallback when the parent is missing.
    return undefined;
  }
}
