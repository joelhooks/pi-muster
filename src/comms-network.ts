import { Effect } from "effect";

/**
 * Transitional. pi-muster before fb2b29b loads this module lazily, and its restart path (the remote
 * binding push) imports it before checking the project's comms. Those Pis must still restart onto
 * current code, so the module stays as an inert stand-in until the restart wave retires them.
 * Current code never imports it. Delete it with the phone slice.
 */
export const liveRows = (): readonly never[] => [];

export const provisionLiveRows = (): Effect.Effect<readonly string[]> => Effect.succeed([]);
