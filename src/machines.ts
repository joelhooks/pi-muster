import { Effect } from "effect";
import { createMachine, transition, types } from "xstate";
import type { AnyStateMachine, EventObject, TypeSchema } from "xstate";

import type { AgentState, LaneState, LaneDelivery, ProjectState, LaunchJobState, PacketState } from "./domain.ts";
import { IllegalTransition, InputError } from "./errors.ts";

/**
 * Lifecycles. Each machine is context-free: the persisted snapshot is the state
 * value, stored on the row. Guards read facts carried on the event, so a
 * transition is a pure function of (state, event).
 *
 * XState 6 (rat-stack parity, Joel 2026-11-14: "i do want everybody at ratstack parity version wise"): targets are
 * `{ target }` objects, a guard is a transition function that returns undefined to refuse, and event types are
 * type-only schemas, one per event type, holding the payload without `type`.
 */
const eventSchemas = <E extends { readonly type: string }>(...names: readonly E["type"][]) =>
  Object.fromEntries(names.map(name => [name, types<unknown>()])) as { [K in E["type"]]: TypeSchema<Omit<Extract<E, { type: K }>, "type">> };
const to = <T extends string>(target: T) => ({ target }) as const;

/** Job finalization has no waiting, admission or timers. */
export const heavyJobMachine = createMachine({
  schemas: { events: eventSchemas<{ type: "FINISH" | "LOSE" }>("FINISH", "LOSE") },
  initial: "running",
  states: { running: { on: { FINISH: to("finished"), LOSE: to("lost") } }, finished: { type: "final" }, lost: { type: "final" } },
});

/** Desk phone outbox: persist intent before send, feedback before resolution, and update receipts last. */
export const deskPhoneMachine = createMachine({
  schemas: { events: eventSchemas<{ type: "SENT" | "ANSWER" | "RESOLVE" | "UPDATE" }>("SENT", "ANSWER", "RESOLVE", "UPDATE") },
  initial: "sending",
  states: {
    sending: { on: { SENT: to("pending") } },
    pending: { on: { ANSWER: to("answered"), RESOLVE: to("resolved") } },
    answered: { on: { RESOLVE: to("resolved") } },
    resolved: { on: { UPDATE: to("closed") } },
    closed: { type: "final" },
  },
});
export const stepDeskPhone = (from: import("./domain.ts").DeskPhoneEntry["state"], event: { type: "SENT" | "ANSWER" | "RESOLVE" | "UPDATE" }, to: import("./domain.ts").DeskPhoneEntry["state"]) => {
  const snapshot = deskPhoneMachine.resolveState({ value: from });
  if (!snapshot.can(event) || transition(deskPhoneMachine, snapshot, event)[0].value !== to) return Effect.fail(new InputError({ message: `desk phone: ${event.type} cannot move ${from} to ${to}` }));
  return Effect.void;
};

export type AgentEvent =
  | { type: "QUEUE_RESTORE" }
  | { type: "LAUNCH" }
  | { type: "STARTED" }
  | { type: "ADOPT" }
  | { type: "LAUNCH_FAILED" }
  | { type: "SILENT" }
  | { type: "NUDGE" }
  | { type: "RESTART" }
  | { type: "RESTARTED" }
  | { type: "ACTIVE" }
  | { type: "REPORT"; readonly paneLive?: boolean }
  | { type: "VERIFY" }
  | { type: "REWORK" }
  | { type: "LAND" }
  | { type: "PANE_GONE" }
  | { type: "RESTORE" }
  | { type: "CLOSE" }
  | { type: "FAIL" };

const CLOSABLE = {
  CLOSE: to("closed"),
} as const;

const WORKING = {
  RESTARTED: to("running"),
  REPORT: to("reported"),
  PANE_GONE: to("interrupted"),
  FAIL: to("failed"),
  CLOSE: to("closed"),
} as const;

/** A report after review moves a row back to reported only while its pane is live. */
const reportWhilePaneLive = ({ event }: { event: AgentEvent }) =>
  event.type === "REPORT" && event.paneLive === true ? to("reported") : undefined;

export const agentMachine = createMachine({
  schemas: { events: eventSchemas<AgentEvent>("QUEUE_RESTORE", "LAUNCH", "STARTED", "ADOPT", "LAUNCH_FAILED", "SILENT", "NUDGE", "RESTART",
    "RESTARTED", "ACTIVE", "REPORT", "VERIFY", "REWORK", "LAND", "PANE_GONE", "RESTORE", "CLOSE", "FAIL") },
  id: "agent",
  initial: "planned",
  states: {
    planned: { on: { LAUNCH: to("launching"), ...CLOSABLE } },
    launching: { on: { STARTED: to("running"), ADOPT: to("running"), LAUNCH_FAILED: to("failed"), PANE_GONE: to("interrupted"), ...CLOSABLE } },
    running: { on: { SILENT: to("silent"), ...WORKING } },
    silent: { on: { NUDGE: to("nudged"), ACTIVE: to("running"), ...WORKING } },
    nudged: { on: { RESTART: to("restarted"), ACTIVE: to("running"), ...WORKING } },
    restarted: { on: { ACTIVE: to("running"), SILENT: to("silent"), ...WORKING } },
    reported: { on: { REPORT: reportWhilePaneLive, RESTARTED: to("running"), VERIFY: to("verified"), REWORK: to("running"), LAND: to("landed"), PANE_GONE: to("interrupted"), ...CLOSABLE } },
    verified: { on: { REPORT: reportWhilePaneLive, LAND: to("landed"), PANE_GONE: to("interrupted"), RESTARTED: to("running"), REWORK: to("running"), ...CLOSABLE } },
    landed: { on: { REPORT: reportWhilePaneLive, PANE_GONE: to("interrupted"), RESTARTED: to("running"), REWORK: to("running"), ...CLOSABLE } },
    interrupted: { on: { QUEUE_RESTORE: to("launching"), ADOPT: to("running"), LAUNCH: to("launching"), RESTORE: to("restoring"), ...CLOSABLE } },
    restoring: { on: { STARTED: to("running"), LAUNCH_FAILED: to("failed"), PANE_GONE: to("interrupted") } },
    failed: { on: { QUEUE_RESTORE: to("launching"), LAUNCH: to("launching"), RESTORE: to("restoring"), ADOPT: to("running"), ...CLOSABLE } },
    closed: { on: { QUEUE_RESTORE: to("launching"), RESTORE: to("restoring") } },
  },
});

export type LaneEvent =
  | { type: "OPEN" }
  | { type: "DRAIN" }
  | { type: "REOPEN" }
  | { type: "OPEN_FAILED"; readonly prior: "proposed" | "draining" | "closed" }
  | { type: "CLOSE"; readonly liveAgents: number; readonly openPackets: number; readonly discard?: boolean };

const nothingLive = (event: LaneEvent) =>
  event.type === "CLOSE" && event.liveAgents === 0 && event.openPackets === 0;
const closeWhenNothingLive = ({ event }: { event: LaneEvent }) => nothingLive(event) ? to("closed") : undefined;

export const laneMachine = createMachine({
  schemas: { events: eventSchemas<LaneEvent>("OPEN", "DRAIN", "REOPEN", "OPEN_FAILED", "CLOSE") },
  id: "lane",
  initial: "proposed",
  states: {
    proposed: { on: {
      OPEN: to("open"),
      CLOSE: ({ event }) => nothingLive(event) && event.type === "CLOSE" && event.discard === true ? to("closed") : undefined,
    } },
    open: { on: {
      DRAIN: to("draining"), CLOSE: closeWhenNothingLive,
      // A failed open puts the lane back where it was.
      OPEN_FAILED: ({ event }) => event.type === "OPEN_FAILED" ? to(event.prior) : undefined,
    } },
    draining: { on: { REOPEN: to("open"), CLOSE: closeWhenNothingLive } },
    closed: { on: { REOPEN: to("open") } },
  },
});

/** Delivery is separate from tab lifecycle: closing a tab never proves a deploy. */
export const deliveryMachine = createMachine({
  schemas: { events: eventSchemas<{ type: "landed" | "deployed" | "proven" | "waived" }>("landed", "deployed", "proven", "waived") },
  initial: "none",
  states: {
    none: { on: { landed: to("landed"), waived: to("waived") } },
    landed: { on: { deployed: to("deployed"), proven: to("proven"), waived: to("waived") } },
    deployed: { on: { proven: to("proven"), waived: to("waived") } },
    proven: {},
    waived: { on: { proven: to("proven") } },
  },
});
export const stepDelivery = (id: string, from: LaneDelivery, stage: "landed" | "deployed" | "proven" | "waived") =>
  step(deliveryMachine, "lane", id, from, { type: stage });

export type ProjectEvent =
  | { type: "ACTIVATE" }
  | { type: "REVIEW" }
  | { type: "REVIEWED" }
  | { type: "ARCHIVE"; readonly openLanes: number };

export const projectMachine = createMachine({
  schemas: { events: eventSchemas<ProjectEvent>("ACTIVATE", "REVIEW", "REVIEWED", "ARCHIVE") },
  id: "project",
  initial: "setup",
  states: {
    setup: { on: { ACTIVATE: to("active") } },
    active: { on: { REVIEW: to("reviewing") } },
    reviewing: { on: {
      REVIEWED: to("active"),
      ARCHIVE: ({ event }) => event.type === "ARCHIVE" && event.openLanes === 0 ? to("archived") : undefined,
    } },
    archived: {},
  },
});

function step<S extends string, E extends EventObject>(
  machine: AnyStateMachine,
  name: "agent" | "lane" | "project",
  id: string,
  from: S,
  event: E,
): Effect.Effect<S, IllegalTransition> {
  const snapshot = machine.resolveState({ value: from });
  if (!snapshot.can(event)) {
    return Effect.fail(
      new IllegalTransition({
        machine: name,
        id,
        from,
        event: event.type,
        message: `${name} ${id}: ${event.type} is not allowed from ${from}`,
      }),
    );
  }
  const [next] = transition(machine, snapshot, event);
  return Effect.succeed(next.value as S);
}

export type LaunchJobEvent = { type: "RUN" } | { type: "SUCCEED" } | { type: "FAIL" };
export const launchJobMachine = createMachine({
  schemas: { events: eventSchemas<LaunchJobEvent>("RUN", "SUCCEED", "FAIL") },
  id: "launch-job", initial: "queued", states: {
    queued: { on: { RUN: to("running"), FAIL: to("failed") } },
    running: { on: { SUCCEED: to("succeeded"), FAIL: to("failed") } },
    succeeded: {}, failed: {},
  },
});
export const stepLaunchJob = (id: string, from: LaunchJobState, event: LaunchJobEvent) => {
  const snapshot = launchJobMachine.resolveState({ value: from });
  if (!snapshot.can(event)) return Effect.fail(new InputError({ message: `launch job ${id}: ${event.type} is not allowed from ${from}` }));
  const [next] = transition(launchJobMachine, snapshot, event);
  // XState returns one of this machine's four schema-owned states.
  return Effect.succeed(next.value as LaunchJobState);
};

/** A correction reopens a terminal packet, never an unlanded report. */
export const packetMachine = createMachine({
  schemas: { events: eventSchemas<{ type: "CORRECT" }>("CORRECT") },
  initial: "reported",
  states: {
    reported: {}, verified: {},
    committed: { on: { CORRECT: to("verified") } },
    rejected: { on: { CORRECT: to("verified") } },
    no_changes: { on: { CORRECT: to("verified") } },
  },
});
export const stepPacket = (id: string, from: PacketState, event: { type: "CORRECT" }) => {
  const snapshot = packetMachine.resolveState({ value: from });
  if (!snapshot.can(event)) return Effect.fail(new InputError({ message: `packet ${id}: ${event.type} is not allowed from ${from}` }));
  const [next] = transition(packetMachine, snapshot, event);
  // The only permitted target is the schema-owned verified state.
  return Effect.succeed(next.value as PacketState);
};

export const stepAgent = (id: string, from: AgentState, event: AgentEvent) =>
  step(agentMachine, "agent", id, from, event);
export const stepLane = (id: string, from: LaneState, event: LaneEvent) =>
  step(laneMachine, "lane", id, from, event);
export const stepProject = (id: string, from: ProjectState, event: ProjectEvent) =>
  step(projectMachine, "project", id, from, event);

/** States with a live Pi process Muster expects to be working. */
export const PROCESS_STATES: readonly AgentState[] = ["launching", "running", "silent", "nudged", "restarted", "restoring"];
/** States where a row still holds a pane or a claim on work. */
/** States whose pane death a restore may record: a reported row can die mid-merge with work in its clone. */
export const PANE_GONE_STATES: readonly AgentState[] = [...PROCESS_STATES, "reported", "verified", "landed"];
export const LIVE_STATES: readonly AgentState[] = [...PROCESS_STATES, "reported", "verified", "landed", "interrupted", "failed"];
