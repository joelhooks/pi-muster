import { getShortestPaths } from "xstate/graph";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { transition } from "xstate";

import { laneMachine, stepLane } from "./machines.ts";
import type { LaneEvent } from "./machines.ts";

const STATES = ["proposed", "open", "draining", "closed"] as const;
type S = (typeof STATES)[number];

const EMPTY = { type: "CLOSE", liveAgents: 0, openPackets: 0 } as const;
const DISCARD = { type: "CLOSE", liveAgents: 0, openPackets: 0, discard: true } as const;
const EVENTS: LaneEvent[] = [
  { type: "OPEN" }, { type: "DRAIN" }, { type: "REOPEN" }, EMPTY, DISCARD,
  { type: "CLOSE", liveAgents: 1, openPackets: 0, discard: true }, { type: "CLOSE", liveAgents: 0, openPackets: 1, discard: true },
  { type: "CLOSE", liveAgents: 2, openPackets: 3 },
  { type: "OPEN_FAILED", prior: "proposed" }, { type: "OPEN_FAILED", prior: "draining" }, { type: "OPEN_FAILED", prior: "closed" },
];

const at = (value: S) => laneMachine.resolveState({ value, context: {} });
const next = (from: S, event: LaneEvent) => transition(laneMachine, at(from), event)[0].value as S;

describe("lane machine model", () => {
  it("reaches every declared state from proposed through the graph", () => {
    const reached = new Set(getShortestPaths(laneMachine, { events: EVENTS }).map(path => path.state.value));
    expect([...reached].sort()).toEqual([...STATES].sort());
  });

  it("replays each shortest path through stepLane and lands where the graph says", () => {
    for (const path of getShortestPaths(laneMachine, { events: EVENTS })) {
      let state: S = "proposed";
      for (const step of path.steps.filter(s => (s.event.type as string) !== "xstate.init")) state = Effect.runSync(stepLane("l1", state, step.event as LaneEvent));
      expect(state).toBe(path.state.value);
    }
  });

  it("closes an open or draining lane only when no agent and no packet is live", () => {
    for (const state of ["open", "draining"] as const) {
      expect(next(state, EMPTY)).toBe("closed");
      for (const busy of [{ liveAgents: 1, openPackets: 0 }, { liveAgents: 0, openPackets: 1 }, { liveAgents: 2, openPackets: 3 }]) {
        expect(at(state).can({ type: "CLOSE", ...busy, discard: true }), `${state} ${JSON.stringify(busy)}`).toBe(false);
      }
    }
  });

  it("closes a proposed lane only as an explicit discard of an empty lane", () => {
    expect(next("proposed", DISCARD)).toBe("closed");
    expect(at("proposed").can(EMPTY)).toBe(false);
    expect(at("proposed").can({ type: "CLOSE", liveAgents: 1, openPackets: 0, discard: true })).toBe(false);
    expect(at("proposed").can({ type: "CLOSE", liveAgents: 0, openPackets: 0, discard: false })).toBe(false);
  });

  it("cannot drain or reopen a proposed lane before it opens", () => {
    expect(at("proposed").can({ type: "DRAIN" })).toBe(false);
    expect(at("proposed").can({ type: "REOPEN" })).toBe(false);
    expect(next("proposed", { type: "OPEN" })).toBe("open");
  });

  it("drains only from open, and reopens from draining or closed", () => {
    expect(next("open", { type: "DRAIN" })).toBe("draining");
    for (const state of ["proposed", "draining", "closed"] as const) expect(at(state).can({ type: "DRAIN" }), state).toBe(false);
    for (const state of ["draining", "closed"] as const) expect(next(state, { type: "REOPEN" })).toBe("open");
    for (const state of ["proposed", "open"] as const) expect(at(state).can({ type: "REOPEN" }), state).toBe(false);
  });

  it("rolls a failed open back to the prior state the event names, and only from open", () => {
    for (const prior of ["proposed", "draining", "closed"] as const) {
      expect(next("open", { type: "OPEN_FAILED", prior })).toBe(prior);
    }
    for (const state of ["proposed", "draining", "closed"] as const) {
      expect(at(state).can({ type: "OPEN_FAILED", prior: "proposed" }), state).toBe(false);
    }
  });

  it("never reopens a lane except through REOPEN, so closed is not final but only REOPEN leaves it", () => {
    const leaving = EVENTS.filter(event => at("closed").can(event));
    expect(leaving).toEqual([{ type: "REOPEN" }]);
  });

  it("refuses OPEN from every state but proposed", () => {
    for (const state of ["open", "draining", "closed"] as const) expect(at(state).can({ type: "OPEN" }), state).toBe(false);
  });
});
