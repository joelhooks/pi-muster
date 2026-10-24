import { getShortestPaths } from "xstate/graph";
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { transition } from "xstate";

import { projectMachine, stepProject } from "./machines.ts";
import type { ProjectEvent } from "./machines.ts";

const STATES = ["setup", "active", "reviewing", "archived"] as const;
type S = (typeof STATES)[number];
const EVENTS: ProjectEvent[] = [
  { type: "ACTIVATE" }, { type: "REVIEW" }, { type: "REVIEWED" },
  { type: "ARCHIVE", openLanes: 0 }, { type: "ARCHIVE", openLanes: 2 },
];

const at = (value: S) => projectMachine.resolveState({ value, context: {} });
const next = (from: S, event: ProjectEvent) => transition(projectMachine, at(from), event)[0].value as S;

describe("project machine model", () => {
  it("reaches every declared state from setup through the graph", () => {
    const reached = new Set(getShortestPaths(projectMachine, { events: EVENTS }).map(path => path.state.value));
    expect([...reached].sort()).toEqual([...STATES].sort());
  });

  it("replays each shortest path and agrees with stepProject at every step", () => {
    for (const path of getShortestPaths(projectMachine, { events: EVENTS })) {
      let state: S = "setup";
      for (const step of path.steps.filter(s => (s.event.type as string) !== "xstate.init")) {
        const event = step.event as ProjectEvent;
        const expected = next(state, event);
        expect(Effect.runSync(stepProject("p1", state, event))).toBe(expected);
        state = expected;
      }
      expect(state).toBe(path.state.value);
    }
  });

  it("archives only from reviewing and only when no lane is open", () => {
    expect(next("reviewing", { type: "ARCHIVE", openLanes: 0 })).toBe("archived");
    expect(at("reviewing").can({ type: "ARCHIVE", openLanes: 1 })).toBe(false);
    for (const state of ["setup", "active"] as const) expect(at(state).can({ type: "ARCHIVE", openLanes: 0 }), state).toBe(false);
  });

  it("treats archived as terminal: it accepts no event and stays archived", () => {
    expect(EVENTS.filter(event => at("archived").can(event))).toEqual([]);
    for (const event of EVENTS) expect(next("archived", event)).toBe("archived");
  });

  it("cannot skip activation: setup accepts only ACTIVATE", () => {
    expect(EVENTS.filter(event => at("setup").can(event))).toEqual([{ type: "ACTIVATE" }]);
  });

  it("cycles active to reviewing and back on REVIEWED, but cannot review from setup", () => {
    expect(next("active", { type: "REVIEW" })).toBe("reviewing");
    expect(next("reviewing", { type: "REVIEWED" })).toBe("active");
    expect(at("setup").can({ type: "REVIEW" })).toBe(false);
    expect(at("active").can({ type: "REVIEWED" })).toBe(false);
  });

  it("leaves the state unchanged for every event the machine refuses", () => {
    for (const state of STATES) {
      for (const event of EVENTS.filter(e => !at(state).can(e))) {
        expect(next(state, event), `${state} + ${event.type}`).toBe(state);
      }
    }
  });

  it("surfaces a refused event as an IllegalTransition failure from stepProject", () => {
    expect(Exit.isFailure(Effect.runSyncExit(stepProject("p1", "archived", { type: "ACTIVATE" })))).toBe(true);
    expect(Exit.isFailure(Effect.runSyncExit(stepProject("p1", "reviewing", { type: "ARCHIVE", openLanes: 3 })))).toBe(true);
  });
});
