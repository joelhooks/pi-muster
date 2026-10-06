import { Effect } from "effect";
import { setup, transition } from "xstate";
import type { AnyStateMachine, EventObject } from "xstate";

import type { AgentState, LaneState, LaneDelivery, ProjectState, LaunchJobState, PacketState } from "./domain.ts";
import { IllegalTransition, InputError } from "./errors.ts";

/**
 * Lifecycles. Each machine is context-free: the persisted snapshot is the state
 * value, stored on the row. Guards read facts carried on the event, so a
 * transition is a pure function of (state, event).
 */

/** Job finalization has no waiting, admission or timers. */
export const heavyJobMachine = setup({ types: { events: {} as { type: "FINISH" | "LOSE" } } }).createMachine({
  initial: "running",
  states: { running: { on: { FINISH: "finished", LOSE: "lost" } }, finished: { type: "final" }, lost: { type: "final" } },
});

/** Owner feeds hold arrivals while a turn runs; polls never wake silent items. */
export const ownerFeedMachine = setup({ types: { events: {} as { type: "START" | "END" } } }).createMachine({
  initial: "idle",
  states: { idle: { on: { START: "busy" } }, busy: { on: { END: "idle" } } },
});

/** Session-scoped transport ownership, separate from the feed's idle/busy lifecycle. */
export const networkConsumerMachine = setup({ types: { events: {} as { type: "NETWORK" | "INTERCOM" | "FAILURE" | "STOP" } } }).createMachine({
  initial: "off",
  on: { STOP: ".stopped" },
  states: {
    off: { on: { NETWORK: "running", FAILURE: "failed" } },
    running: { on: { INTERCOM: "off", FAILURE: "failed" } },
    failed: { on: { INTERCOM: "off" } },
    stopped: { type: "final" },
  },
});

/** Desk phone outbox: persist intent before send, feedback before resolution, and update receipts last. */
export const deskPhoneMachine = setup({ types: { events: {} as { type: "SENT" | "ANSWER" | "RESOLVE" | "UPDATE" } } }).createMachine({
  initial: "sending",
  states: {
    sending: { on: { SENT: "pending" } },
    pending: { on: { ANSWER: "answered", RESOLVE: "resolved" } },
    answered: { on: { RESOLVE: "resolved" } },
    resolved: { on: { UPDATE: "closed" } },
    closed: { type: "final" },
  },
});
export const stepDeskPhone = (from: import("./domain.ts").DeskPhoneEntry["state"], event: { type: "SENT" | "ANSWER" | "RESOLVE" | "UPDATE" }, to: import("./domain.ts").DeskPhoneEntry["state"]) => {
  const snapshot = deskPhoneMachine.resolveState({ value: from, context: {} });
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
  CLOSE: "closed",
} as const;

const WORKING = {
  RESTARTED: "running",
  REPORT: "reported",
  PANE_GONE: "interrupted",
  FAIL: "failed",
  CLOSE: "closed",
} as const;

export const agentMachine = setup({
  types: { events: {} as AgentEvent },
  guards: { paneLive: ({ event }) => event.type === "REPORT" && event.paneLive === true },
}).createMachine({
  id: "agent",
  initial: "planned",
  states: {
    planned: { on: { LAUNCH: "launching", ...CLOSABLE } },
    launching: { on: { STARTED: "running", ADOPT: "running", LAUNCH_FAILED: "failed", PANE_GONE: "interrupted" } },
    running: { on: { SILENT: "silent", ...WORKING } },
    silent: { on: { NUDGE: "nudged", ACTIVE: "running", ...WORKING } },
    nudged: { on: { RESTART: "restarted", ACTIVE: "running", ...WORKING } },
    restarted: { on: { ACTIVE: "running", SILENT: "silent", ...WORKING } },
    reported: { on: { REPORT: { target: "reported", guard: "paneLive" }, RESTARTED: "running", VERIFY: "verified", REWORK: "running", LAND: "landed", PANE_GONE: "interrupted", ...CLOSABLE } },
    verified: { on: { REPORT: { target: "reported", guard: "paneLive" }, LAND: "landed", RESTARTED: "running", REWORK: "running", ...CLOSABLE } },
    landed: { on: { REPORT: { target: "reported", guard: "paneLive" }, PANE_GONE: "interrupted", RESTARTED: "running", REWORK: "running", ...CLOSABLE } },
    interrupted: { on: { QUEUE_RESTORE: "launching", ADOPT: "running", LAUNCH: "launching", RESTORE: "restoring", ...CLOSABLE } },
    restoring: { on: { STARTED: "running", LAUNCH_FAILED: "failed", PANE_GONE: "interrupted" } },
    failed: { on: { QUEUE_RESTORE: "launching", LAUNCH: "launching", RESTORE: "restoring", ADOPT: "running", ...CLOSABLE } },
    closed: { on: { QUEUE_RESTORE: "launching", RESTORE: "restoring" } },
  },
});

export type LaneEvent =
  | { type: "OPEN" }
  | { type: "DRAIN" }
  | { type: "REOPEN" }
  | { type: "OPEN_FAILED"; readonly prior: "proposed" | "draining" | "closed" }
  | { type: "CLOSE"; readonly liveAgents: number; readonly openPackets: number; readonly discard?: boolean };

const nothingLive = ({ event }: { event: LaneEvent }) =>
  event.type === "CLOSE" && event.liveAgents === 0 && event.openPackets === 0;

export const laneMachine = setup({
  types: { events: {} as LaneEvent },
  guards: {
    nothingLive,
    discardProposed: ({ event }) => nothingLive({ event }) && event.type === "CLOSE" && event.discard === true,
    wasProposed: ({ event }) => event.type === "OPEN_FAILED" && event.prior === "proposed",
    wasDraining: ({ event }) => event.type === "OPEN_FAILED" && event.prior === "draining",
    wasClosed: ({ event }) => event.type === "OPEN_FAILED" && event.prior === "closed",
  },
}).createMachine({
  id: "lane",
  initial: "proposed",
  states: {
    proposed: { on: { OPEN: "open", CLOSE: { target: "closed", guard: "discardProposed" } } },
    open: { on: {
      DRAIN: "draining", CLOSE: { target: "closed", guard: "nothingLive" },
      OPEN_FAILED: [{ target: "proposed", guard: "wasProposed" }, { target: "draining", guard: "wasDraining" }, { target: "closed", guard: "wasClosed" }],
    } },
    draining: { on: { REOPEN: "open", CLOSE: { target: "closed", guard: "nothingLive" } } },
    closed: { on: { REOPEN: "open" } },
  },
});

/** Delivery is separate from tab lifecycle: closing a tab never proves a deploy. */
export const deliveryMachine = setup({
  types: { events: {} as { type: "landed" | "deployed" | "proven" | "waived" } },
}).createMachine({
  initial: "none",
  states: {
    none: { on: { landed: "landed", waived: "waived" } },
    landed: { on: { deployed: "deployed", proven: "proven", waived: "waived" } },
    deployed: { on: { proven: "proven", waived: "waived" } },
    proven: {},
    waived: { on: { proven: "proven" } },
  },
});
export const stepDelivery = (id: string, from: LaneDelivery, stage: "landed" | "deployed" | "proven" | "waived") =>
  step(deliveryMachine, "lane", id, from, { type: stage });

export type ProjectEvent =
  | { type: "ACTIVATE" }
  | { type: "REVIEW" }
  | { type: "REVIEWED" }
  | { type: "ARCHIVE"; readonly openLanes: number };

export const projectMachine = setup({
  types: { events: {} as ProjectEvent },
  guards: {
    noOpenLanes: ({ event }) => event.type === "ARCHIVE" && event.openLanes === 0,
  },
}).createMachine({
  id: "project",
  initial: "setup",
  states: {
    setup: { on: { ACTIVATE: "active" } },
    active: { on: { REVIEW: "reviewing" } },
    reviewing: { on: { REVIEWED: "active", ARCHIVE: { target: "archived", guard: "noOpenLanes" } } },
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
  const snapshot = machine.resolveState({ value: from, context: {} });
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
export const launchJobMachine = setup({ types: { events: {} as LaunchJobEvent } }).createMachine({
  id: "launch-job", initial: "queued", states: {
    queued: { on: { RUN: "running", FAIL: "failed" } },
    running: { on: { SUCCEED: "succeeded", FAIL: "failed" } },
    succeeded: {}, failed: {},
  },
});
export const stepLaunchJob = (id: string, from: LaunchJobState, event: LaunchJobEvent) => {
  const snapshot = launchJobMachine.resolveState({ value: from, context: {} });
  if (!snapshot.can(event)) return Effect.fail(new InputError({ message: `launch job ${id}: ${event.type} is not allowed from ${from}` }));
  const [next] = transition(launchJobMachine, snapshot, event);
  // XState returns one of this machine's four schema-owned states.
  return Effect.succeed(next.value as LaunchJobState);
};

/** A correction reopens a terminal packet, never an unlanded report. */
export const packetMachine = setup({ types: { events: {} as { type: "CORRECT" } } }).createMachine({
  initial: "reported",
  states: {
    reported: {}, verified: {},
    committed: { on: { CORRECT: "verified" } },
    rejected: { on: { CORRECT: "verified" } },
    no_changes: { on: { CORRECT: "verified" } },
  },
});
export const stepPacket = (id: string, from: PacketState, event: { type: "CORRECT" }) => {
  const snapshot = packetMachine.resolveState({ value: from, context: {} });
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
export const LIVE_STATES: readonly AgentState[] = [...PROCESS_STATES, "reported", "verified", "landed", "interrupted", "failed"];
