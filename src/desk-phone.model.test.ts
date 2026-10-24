import { getShortestPaths } from "xstate/graph";
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { transition } from "xstate";

import { deskPhoneMachine, stepDeskPhone } from "./machines.ts";

const STATES = ["sending", "pending", "answered", "resolved", "closed"] as const;
type S = (typeof STATES)[number];
type E = { type: "SENT" | "ANSWER" | "RESOLVE" | "UPDATE" };
const EVENTS: E[] = [{ type: "SENT" }, { type: "ANSWER" }, { type: "RESOLVE" }, { type: "UPDATE" }];

const at = (value: S) => deskPhoneMachine.resolveState({ value, context: {} });
const next = (from: S, event: E) => transition(deskPhoneMachine, at(from), event)[0].value as S;
const accepted = (from: S) => EVENTS.filter(event => at(from).can(event)).map(event => event.type);
const ok = (from: S, event: E, to: S) => Exit.isSuccess(Effect.runSyncExit(stepDeskPhone(from, event, to)));

describe("desk phone machine model", () => {
  it("reaches every declared state from sending through the graph", () => {
    const reached = new Set(getShortestPaths(deskPhoneMachine, { events: EVENTS }).map(path => path.state.value));
    expect([...reached].sort()).toEqual([...STATES].sort());
  });

  it("replays each shortest path and stepDeskPhone accepts exactly the graph's moves", () => {
    for (const path of getShortestPaths(deskPhoneMachine, { events: EVENTS })) {
      let state: S = "sending";
      for (const step of path.steps.filter(s => (s.event.type as string) !== "xstate.init")) {
        const event = step.event as E;
        const to = next(state, event);
        expect(ok(state, event, to), `${state} + ${event.type}`).toBe(true);
        state = to;
      }
      expect(state).toBe(path.state.value);
    }
  });

  it("persists intent before send: sending accepts only SENT, so no answer or resolve skips the send", () => {
    expect(accepted("sending")).toEqual(["SENT"]);
    expect(next("sending", { type: "SENT" })).toBe("pending");
  });

  it("takes feedback before resolution but allows resolving a pending entry directly", () => {
    expect(accepted("pending")).toEqual(["ANSWER", "RESOLVE"]);
    expect(next("pending", { type: "ANSWER" })).toBe("answered");
    expect(next("pending", { type: "RESOLVE" })).toBe("resolved");
    expect(accepted("answered")).toEqual(["RESOLVE"]);
  });

  it("updates receipts last: UPDATE is accepted only from resolved", () => {
    for (const state of STATES) expect(at(state).can({ type: "UPDATE" }), state).toBe(state === "resolved");
    expect(next("resolved", { type: "UPDATE" })).toBe("closed");
  });

  it("treats closed as final: it accepts no event and stays closed", () => {
    expect(accepted("closed")).toEqual([]);
    for (const event of EVENTS) expect(next("closed", event)).toBe("closed");
  });

  it("never moves backwards: a resolved entry cannot be answered again", () => {
    expect(at("resolved").can({ type: "ANSWER" })).toBe(false);
    expect(at("answered").can({ type: "ANSWER" })).toBe(false);
    expect(at("pending").can({ type: "SENT" })).toBe(false);
  });

  it("rejects a stepDeskPhone claim that names a wrong target or a refused event", () => {
    expect(ok("pending", { type: "ANSWER" }, "resolved")).toBe(false);
    expect(ok("pending", { type: "ANSWER" }, "answered")).toBe(true);
    expect(ok("closed", { type: "UPDATE" }, "closed")).toBe(false);
    expect(ok("sending", { type: "RESOLVE" }, "resolved")).toBe(false);
  });
});
