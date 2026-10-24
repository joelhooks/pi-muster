import { getShortestPaths } from "xstate/graph";
import { describe, expect, it } from "vitest";
import { transition } from "xstate";

import { agentMachine } from "./machines.ts";
import type { AgentEvent } from "./machines.ts";

const STATES = ["planned", "launching", "running", "silent", "nudged", "restarted", "reported", "verified", "landed", "interrupted", "restoring", "failed", "closed"] as const;
type S = (typeof STATES)[number];

const EVENTS: AgentEvent[] = [
  { type: "QUEUE_RESTORE" }, { type: "LAUNCH" }, { type: "STARTED" }, { type: "ADOPT" }, { type: "LAUNCH_FAILED" }, { type: "SILENT" },
  { type: "NUDGE" }, { type: "RESTART" }, { type: "RESTARTED" }, { type: "ACTIVE" }, { type: "REPORT", paneLive: true }, { type: "VERIFY" },
  { type: "REWORK" }, { type: "LAND" }, { type: "PANE_GONE" }, { type: "RESTORE" }, { type: "CLOSE" }, { type: "FAIL" },
];

const at = (value: S) => agentMachine.resolveState({ value, context: {} });
const next = (from: S, event: AgentEvent) => transition(agentMachine, at(from), event)[0].value as S;
const accepted = (from: S) => EVENTS.filter(event => at(from).can(event));
const paths = () => getShortestPaths(agentMachine, { events: EVENTS });

describe("agent machine model", () => {
  it("reaches every declared state from planned through the graph", () => {
    const reached = new Set(paths().map(path => path.state.value as S));
    expect([...reached].sort()).toEqual([...STATES].sort());
  });

  it("replays each shortest path event by event and lands where the graph says", () => {
    for (const path of paths()) {
      let state: S = "planned";
      for (const step of path.steps.filter(s => (s.event.type as string) !== "xstate.init")) state = next(state, step.event as AgentEvent);
      expect(state).toBe(path.state.value);
    }
  });

  it("guards REPORT on a live pane only where a report already happened, so a dead pane cannot re-report", () => {
    for (const state of ["reported", "verified", "landed"] as const) {
      expect(at(state).can({ type: "REPORT", paneLive: false }), state).toBe(false);
      expect(at(state).can({ type: "REPORT" }), state).toBe(false);
    }
    for (const state of ["running", "silent", "nudged", "restarted"] as const) expect(at(state).can({ type: "REPORT" }), state).toBe(true);
    for (const state of ["planned", "launching", "interrupted", "restoring", "failed", "closed"] as const) expect(at(state).can({ type: "REPORT", paneLive: true }), state).toBe(false);
  });

  it("moves a running agent to reported on REPORT", () => {
    expect(next("running", { type: "REPORT" })).toBe("reported");
  });

  it("lets verified, landed and reported agents re-report only with a live pane", () => {
    for (const state of ["reported", "verified", "landed"] as const) {
      expect(next(state, { type: "REPORT", paneLive: true })).toBe("reported");
    }
  });

  it("closes from every live or restorable state except the transient restoring and the already closed", () => {
    for (const state of STATES.filter(s => s !== "restoring" && s !== "closed")) {
      expect(next(state, { type: "CLOSE" }), state).toBe("closed");
    }
  });

  it("refuses CLOSE from restoring until it settles, and from closed", () => {
    expect(at("restoring").can({ type: "CLOSE" })).toBe(false);
    expect(at("closed").can({ type: "CLOSE" })).toBe(false);
  });

  it("lets a closed agent leave only by QUEUE_RESTORE or RESTORE", () => {
    expect(accepted("closed").map(event => event.type).sort()).toEqual(["QUEUE_RESTORE", "RESTORE"]);
    expect(next("closed", { type: "QUEUE_RESTORE" })).toBe("launching");
    expect(next("closed", { type: "RESTORE" })).toBe("restoring");
  });

  it("leaves the state unchanged for every event the machine refuses", () => {
    for (const state of STATES) {
      for (const event of EVENTS.filter(e => !at(state).can(e))) {
        const [after] = transition(agentMachine, at(state), event);
        expect(after.value, `${state} + ${event.type}`).toBe(state);
      }
    }
  });

  it("cannot jump from planned or restoring straight to reported, verified or landed", () => {
    for (const state of ["planned", "restoring"] as const) {
      for (const target of ["reported", "verified", "landed"]) {
        expect(accepted(state).map(event => next(state, event)), state).not.toContain(target);
      }
    }
  });

  it("only moves forward through the report chain: reported to verified to landed, never backwards", () => {
    expect(next("reported", { type: "VERIFY" })).toBe("verified");
    expect(next("verified", { type: "LAND" })).toBe("landed");
    expect(at("verified").can({ type: "VERIFY" })).toBe(false);
    expect(at("landed").can({ type: "VERIFY" })).toBe(false);
    expect(at("landed").can({ type: "LAND" })).toBe(false);
    expect(at("reported").can({ type: "LAND" })).toBe(true);
  });

  it("sends rework from reported work back to running, and refuses it from planned work", () => {
    for (const state of ["reported", "verified", "landed"] as const) expect(next(state, { type: "REWORK" })).toBe("running");
    expect(at("planned").can({ type: "REWORK" })).toBe(false);
    expect(at("running").can({ type: "REWORK" })).toBe(false);
  });

  it("walks silence through nudge and restart and back to running on ACTIVE", () => {
    expect(next("running", { type: "SILENT" })).toBe("silent");
    expect(next("silent", { type: "NUDGE" })).toBe("nudged");
    expect(next("nudged", { type: "RESTART" })).toBe("restarted");
    for (const state of ["silent", "nudged", "restarted"] as const) expect(next(state, { type: "ACTIVE" })).toBe("running");
  });

  it("lets a failed or interrupted agent restore, relaunch or be adopted, but never report directly", () => {
    for (const state of ["failed", "interrupted"] as const) {
      expect(next(state, { type: "RESTORE" })).toBe("restoring");
      expect(next(state, { type: "LAUNCH" })).toBe("launching");
      expect(next(state, { type: "ADOPT" })).toBe("running");
      expect(at(state).can({ type: "REPORT", paneLive: true })).toBe(false);
    }
  });

  it("fails a launch only from launching or restoring", () => {
    const failing = STATES.filter(state => at(state).can({ type: "LAUNCH_FAILED" }));
    expect(failing.sort()).toEqual(["launching", "restoring"]);
    for (const state of failing) expect(next(state, { type: "LAUNCH_FAILED" })).toBe("failed");
  });
});
