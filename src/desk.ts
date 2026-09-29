import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import type { DeskItem, DeskKind } from "./domain.ts";
import { DeskItem as DeskItemSchema } from "./domain.ts";

/**
 * The desk queue is dark-wizard's `herdr/desk` format: one JSON line per item
 * in `~/.local/state/herdr-desk/<project>.jsonl`. The desk extension shows new
 * lines on Joel's own turns. Nothing is ever pushed into the desk pane.
 */
export function queuePath(slug: string, home: string): string {
  return join(home, ".local", "state", "herdr-desk", `${slug}.jsonl`);
}

const decodeItem = Schema.decodeUnknownOption(DeskItemSchema);

/** Malformed or foreign lines are skipped: one torn line must not hide the queue. */
export function readDesk(path: string): DeskItem[] {
  if (!existsSync(path)) return [];
  const items: DeskItem[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const decoded = decodeItem(JSON.parse(line));
      if (decoded._tag === "Some") items.push(decoded.value);
    } catch {
      // Torn line.
    }
  }
  return items;
}

export interface DeskPost {
  readonly from: string;
  readonly kind: DeskKind;
  readonly title: string;
  readonly body?: string | undefined;
  readonly refs?: readonly string[] | undefined;
  readonly resolves?: string | undefined;
}

export function deskRecord(post: DeskPost, id: string, now: Date): DeskItem {
  const title = post.title.trim().replace(/\s+/g, " ");
  if (!title) throw new Error("desk title is required");
  if (!post.from.trim()) throw new Error("desk from is required");
  return {
    id,
    ts: now.toISOString(),
    from: post.from.trim(),
    kind: post.kind,
    title,
    ...(post.body?.trim() ? { body: post.body.trim() } : {}),
    ...(post.refs?.length ? { refs: [...post.refs] } : {}),
    ...(post.resolves ? { resolves: post.resolves } : {}),
  };
}

export function appendDesk(path: string, item: DeskItem): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(item)}\n`, "utf8");
}
