import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import { decodeRoster } from "./domain.ts";
import type { Roster } from "./domain.ts";
import { InputError } from "./errors.ts";
import { MusterEnv } from "./runtime.ts";

export const rosterPath = (home: string) => process.env.MUSTER_ROSTER ?? join(home, ".config", "muster", "roster.json");

/**
 * Read at call time, never cached, so an edited or freshly synced roster
 * applies to the next launch. No file means built-in defaults; a bad file is
 * an error, because launching on silently wrong models is worse than stopping.
 */
export const loadRoster = Effect.gen(function* () {
  const env = yield* MusterEnv;
  const path = rosterPath(env.home);
  if (!existsSync(path)) return { roster: undefined as Roster | undefined, path: null as string | null };
  const roster = yield* Effect.try({
    try: () => decodeRoster(JSON.parse(readFileSync(path, "utf8"))),
    catch: (error) => new InputError({ message: `roster ${path} is invalid: ${error instanceof Error ? error.message : String(error)}` }),
  });
  return { roster: roster as Roster | undefined, path: path as string | null };
});
