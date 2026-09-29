import { silenceLimits } from "./domain.ts";
import type { AgentState, SilenceLimits } from "./domain.ts";
import type { AgentEvent } from "./machines.ts";

export type SilenceAction = "none" | "nudge" | "restart";

export interface SilenceDecision {
  readonly events: readonly AgentEvent[];
  readonly action: SilenceAction;
}

const NONE: SilenceDecision = { events: [], action: "none" };

/**
 * The silence check. A pane can show `working` while one tool call hangs, so
 * the evidence is the session file's age, not the screen. At the nudge limit
 * (default 30 minutes) the owner sends `esc` and a note; at the restart limit
 * (default 60, or never) it starts a fresh session and re-prompts from the
 * brief. Fresh activity returns a silent row to running.
 */
export function silenceDecision(state: AgentState, silentForMs: number, limits: SilenceLimits = silenceLimits(undefined)): SilenceDecision {
  const quiet = silentForMs >= limits.nudgeMs;
  switch (state) {
    case "running":
    case "restarted":
      return quiet ? { events: [{ type: "SILENT" }, { type: "NUDGE" }], action: "nudge" } : NONE;
    case "silent":
      return quiet ? { events: [{ type: "NUDGE" }], action: "nudge" } : { events: [{ type: "ACTIVE" }], action: "none" };
    case "nudged":
      if (limits.restartMs !== null && silentForMs >= limits.restartMs) return { events: [{ type: "RESTART" }], action: "restart" };
      return quiet ? NONE : { events: [{ type: "ACTIVE" }], action: "none" };
    default:
      return NONE;
  }
}

export function nudgeNote(silentForMs: number): string {
  const minutes = Math.floor(silentForMs / 60_000);
  return `Muster: your session has written nothing for ${minutes} minutes. If a tool call is hung, name it in one line, then continue or report the block to your owner.`;
}

/** The first words of the capture refresh; a failure right after it is not refreshed again. */
export const CAPTURE_REFRESH_MARK = "Muster capture refresh:";

export function captureRefreshNote(): string {
  return `${CAPTURE_REFRESH_MARK} your last wake failed before it reached the model, because the Claude bridge held an older prompt. This message refreshes it. Act on the message you were woken with, then carry on.`;
}
