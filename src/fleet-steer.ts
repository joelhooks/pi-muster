import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeFleetSteer, roleDefaults, steerChoice, WORK_TYPE } from "./domain.ts";
import type { FleetSteer, Policy, Role, Roster } from "./domain.ts";
import { InputError } from "./errors.ts";

export const fleetSteerPath = (home: string) => join(home, ".local/state/muster/fleet-steer.json");

/** Best-effort read on the owner, never on the worker's target machine. */
export const readFleetSteer = (home: string) => Effect.try({
  try: () => ({ steer: decodeFleetSteer(JSON.parse(readFileSync(fleetSteerPath(home), "utf8"))) as FleetSteer | undefined, note: undefined as string | undefined }),
  catch: error => new InputError({ message: typeof error === "object" && error !== null && "code" in error
    ? (error.code === "ENOENT" ? "fleet steer missing; roster default" : "fleet steer unreadable; roster default")
    : "fleet steer undecodable; roster default" }),
}).pipe(Effect.catch(error => Effect.succeed({ steer: undefined as FleetSteer | undefined, note: error.message as string | undefined })));

export const launchDefaults = (args: { home: string; now: number; action: string; roster?: Roster; policy?: Policy; role: Role; model?: string; slug?: string; workType?: string | undefined }) => Effect.gen(function* () {
  const applies = args.action === "launch" && args.role === "worker";
  if (args.workType !== undefined && !WORK_TYPE.test(args.workType)) return yield* new InputError({ message: `workType must match ${WORK_TYPE.source}` });
  if (args.workType !== undefined && !applies) return yield* new InputError({ message: "workType applies only to a worker launch" });
  const pinned = args.model !== undefined || args.policy?.roles?.worker?.model !== undefined;
  const read = applies && !pinned ? yield* readFleetSteer(args.home) : undefined;
  const choice = read ? steerChoice(read.steer, args.now, args.workType) : undefined;
  const defaults = yield* Effect.try({
    try: () => roleDefaults(args.roster, args.policy, args.role, args.model, args.slug, read?.steer, args.now, args.workType),
    catch: error => new InputError({ message: String(error instanceof Error ? error.message : error) }),
  });
  const reason = args.model !== undefined ? "explicit model" : args.policy?.roles?.worker?.model !== undefined ? "project policy" : choice?.model ? choice.note : args.roster?.roles.worker?.model !== undefined ? "roster default" : "ROLE_DEFAULTS";
  return { defaults, review: choice?.review === true, notes: applies ? [
    ...(!pinned && !choice?.model ? [read?.note ?? choice!.note] : []),
    ...(pinned && args.workType !== undefined ? [`work type ${args.workType}: route not used; ${reason} wins`] : []),
    `worker model: ${defaults.model}${choice?.route !== undefined ? ` (${defaults.thinking})` : ""} from ${reason}`,
    ...(choice?.review ? [`review: route ${choice.route} wants the owner to review the packet before packet_land`] : []),
  ] : [] };
});
