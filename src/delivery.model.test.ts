import { getShortestPaths } from "xstate/graph";
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { transition } from "xstate";

import { deliveryMachine, stepDelivery } from "./machines.ts";

const STATES = ["none", "landed", "deployed", "proven", "waived"] as const;
type S = (typeof STATES)[number];
type E = { type: "landed" | "deployed" | "proven" | "waived" };
const EVENTS: E[] = [{ type: "landed" }, { type: "deployed" }, { type: "proven" }, { type: "waived" }];

const at = (value: S) => deliveryMachine.resolveState({ value, context: {} });
const next = (from: S, event: E) => transition(deliveryMachine, at(from), event)[0].value as S;
const accepted = (from: S) => EVENTS.filter(event => at(from).can(event)).map(event => event.type);

describe("delivery machine model", () => {
  it("reaches every declared state from none through the graph", () => {
    const reached = new Set(getShortestPaths(deliveryMachine, { events: EVENTS }).map(path => path.state.value));
    expect([...reached].sort()).toEqual([...STATES].sort());
  });

  it("replays each shortest path and agrees with stepDelivery at every step", () => {
    for (const path of getShortestPaths(deliveryMachine, { events: EVENTS })) {
      let state: S = "none";
      for (const step of path.steps.filter(s => (s.event.type as string) !== "xstate.init")) {
        const event = step.event as E;
        const expected = next(state, event);
        expect(Effect.runSync(stepDelivery("l1", state, event.type))).toBe(expected);
        state = expected;
      }
      expect(state).toBe(path.state.value);
    }
  });

  it("proves nothing without landing or waiving first: none accepts only landed and waived", () => {
    expect(accepted("none")).toEqual(["landed", "waived"]);
    expect(at("none").can({ type: "proven" })).toBe(false);
    expect(at("none").can({ type: "deployed" })).toBe(false);
  });

  it("treats proven as terminal: it accepts no event and stays proven", () => {
    expect(accepted("proven")).toEqual([]);
    for (const event of EVENTS) expect(next("proven", event)).toBe("proven");
  });

  it("lets a waived delivery be upgraded to proven and nothing else", () => {
    expect(accepted("waived")).toEqual(["proven"]);
    expect(next("waived", { type: "proven" })).toBe("proven");
  });

  it("never moves backwards: landed cannot be re-landed and deployed cannot go back to landed", () => {
    expect(at("landed").can({ type: "landed" })).toBe(false);
    expect(at("deployed").can({ type: "landed" })).toBe(false);
    expect(at("deployed").can({ type: "deployed" })).toBe(false);
  });

  it("lets landed go on to deployed, proven or waived", () => {
    expect(accepted("landed")).toEqual(["deployed", "proven", "waived"]);
    expect(next("landed", { type: "deployed" })).toBe("deployed");
  });

  it("surfaces a refused stage as an IllegalTransition failure from stepDelivery", () => {
    expect(Exit.isFailure(Effect.runSyncExit(stepDelivery("l1", "proven", "landed")))).toBe(true);
    expect(Exit.isFailure(Effect.runSyncExit(stepDelivery("l1", "none", "proven")))).toBe(true);
    expect(Exit.isSuccess(Effect.runSyncExit(stepDelivery("l1", "landed", "deployed")))).toBe(true);
  });
});
