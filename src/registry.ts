import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import type { Project } from "./domain.ts";
import { MusterEnv } from "./runtime.ts";

/**
 * The project list: a line whenever a project write shows a new slug, dir, or
 * space; newest wins per slug. Muster projects live inside their own repos, so
 * without it nothing can name them all.
 */
export const registryPath = (home: string) => join(home, ".local", "state", "muster", "projects.jsonl");

export interface RegistryEntry {
  readonly slug: string;
  readonly dir: string;
  readonly spaceId: string | null;
  readonly ts: string;
}

export function readRegistry(home: string): Map<string, RegistryEntry> {
  const path = registryPath(home);
  const entries = new Map<string, RegistryEntry>();
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line) as RegistryEntry;
      if (typeof entry?.slug === "string" && typeof entry.dir === "string") entries.set(entry.slug, entry);
    } catch {
      // Torn or blank line.
    }
  }
  return entries;
}

/** Appends only when the slug is new or moved, so repeated opens do not grow the file. */
export const registerProject = (project: Pick<Project, "slug" | "dir" | "spaceId" | "ephemeral">) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    if (project.ephemeral) return;
    const known = readRegistry(env.home).get(project.slug);
    if (known && known.dir === project.dir && known.spaceId === project.spaceId) return;
    const path = registryPath(env.home);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ slug: project.slug, dir: project.dir, spaceId: project.spaceId, ts: env.now().toISOString() })}\n`);
  });

