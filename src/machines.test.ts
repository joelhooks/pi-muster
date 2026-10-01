import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import type { AgentState } from "./domain.ts";
import type { AgentEvent } from "./machines.ts";
import { stepAgent, stepLane, stepProject } from "./machines.ts";

const walk = (from: AgentState, events: AgentEvent[]) =>
  Effect.runSync(
    Effect.gen(function* () {
      let state = from;
      for (const event of events) state = yield* stepAgent("w1", state, event);
      return state;
    }),
  );

const illegal = <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = Effect.runSyncExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  return JSON.stringify(exit);
};

describe("agent machine", () => {
  it("runs the happy path to closed", () => {
    expect(walk("planned", [{ type: "LAUNCH" }, { type: "STARTED" }, { type: "REPORT" }, { type: "VERIFY" }, { type: "LAND" }, { type: "CLOSE" }])).toBe("closed");
  });

  it("walks silence to a restart and back to running", () => {
    expect(walk("running", [{ type: "SILENT" }, { type: "NUDGE" }, { type: "RESTART" }, { type: "ACTIVE" }])).toBe("running");
  });

  it("interrupts on a gone pane and restores", () => {
    expect(walk("running", [{ type: "PANE_GONE" }, { type: "RESTORE" }, { type: "STARTED" }])).toBe("running");
    expect(walk("closed", [{ type: "RESTORE" }, { type: "LAUNCH_FAILED" }])).toBe("failed");
  });

  it("adopts only failed and launching agents", () => {
    expect(walk("failed", [{ type: "ADOPT" }, { type: "REPORT" }])).toBe("reported");
    expect(walk("launching", [{ type: "ADOPT" }])).toBe("running");
    for (const state of ["planned", "running", "silent", "nudged", "restarted", "reported", "verified", "landed", "interrupted", "restoring", "closed"] as const) {
      illegal(stepAgent("w1", state, { type: "ADOPT" }));
    }
  });

  it("sends rejected work back to running", () => {
    expect(walk("verified", [{ type: "REWORK" }])).toBe("running");
  });

  it("lets live verified, landed and reported workers report their next packet", () => {
    expect(walk("verified", [{ type: "REPORT", paneLive: true }])).toBe("reported");
    illegal(stepAgent("w1", "verified", { type: "REPORT", paneLive: false }));
    illegal(stepAgent("w1", "verified", { type: "REPORT" }));
    expect(walk("landed", [{ type: "REPORT", paneLive: true }])).toBe("reported");
    expect(walk("reported", [{ type: "REPORT", paneLive: true }])).toBe("reported");
    illegal(stepAgent("w1", "landed", { type: "REPORT", paneLive: false }));
    illegal(stepAgent("w1", "reported", { type: "REPORT" }));
  });

  it("rejects illegal transitions as typed errors", () => {
    const text = illegal(stepAgent("w1", "planned", { type: "REPORT" }));
    expect(text).toContain("IllegalTransition");
    expect(text).toContain("REPORT is not allowed from planned");
    illegal(stepAgent("w1", "running", { type: "LAND" }));
    illegal(stepAgent("w1", "closed", { type: "CLOSE" }));
    illegal(stepAgent("w1", "launching", { type: "CLOSE" }));
  });
});

describe("lane machine", () => {
  it("closes only when nothing is live", () => {
    expect(Effect.runSync(stepLane("a", "open", { type: "CLOSE", liveAgents: 0, openPackets: 0 }))).toBe("closed");
    illegal(stepLane("a", "open", { type: "CLOSE", liveAgents: 1, openPackets: 0 }));
    illegal(stepLane("a", "draining", { type: "CLOSE", liveAgents: 0, openPackets: 2 }));
    expect(Effect.runSync(stepLane("a", "open", { type: "DRAIN" }))).toBe("draining");
    expect(Effect.runSync(stepLane("a", "draining", { type: "REOPEN" }))).toBe("open");
    illegal(stepLane("a", "proposed", { type: "DRAIN" }));
  });
});

describe("project machine", () => {
  it("reviews back to active or archives with no open lane", () => {
    expect(Effect.runSync(stepProject("p", "setup", { type: "ACTIVATE" }))).toBe("active");
    expect(Effect.runSync(stepProject("p", "reviewing", { type: "REVIEWED" }))).toBe("active");
    expect(Effect.runSync(stepProject("p", "reviewing", { type: "ARCHIVE", openLanes: 0 }))).toBe("archived");
    illegal(stepProject("p", "reviewing", { type: "ARCHIVE", openLanes: 1 }));
    illegal(stepProject("p", "active", { type: "ARCHIVE", openLanes: 0 }));
    illegal(stepProject("p", "archived", { type: "REVIEW" }));
  });
});
