import { describe, expect, it } from "vitest";
import { effectivePolicy, mergePolicy, placeAgent } from "./domain.ts";

// Switchboard, 2026-10-26: rubicon's committed fixtures hold real athlete data, so its policy denies pennywise.
describe("placeAgent", () => {
  const policy = { machines: { deny: ["pennywise"] } };
  it("keeps today's order with no policy: explicit, row, clone default, local", () => {
    expect(placeAgent("p", undefined, "launch", "pennywise", "local", "other")).toEqual({ machine: "pennywise" });
    expect(placeAgent("p", undefined, "restore", undefined, "pennywise", undefined)).toEqual({ machine: "pennywise" });
    expect(placeAgent("p", undefined, "launch", undefined, undefined, "pennywise")).toEqual({ machine: "pennywise" });
    expect(placeAgent("p", undefined, "launch", undefined, undefined, undefined)).toEqual({ machine: "local" });
  });
  it("refuses a denied explicit machine and points at local", () => {
    expect(placeAgent("rubicon", policy, "launch", "pennywise", undefined, undefined))
      .toEqual({ refusal: "project rubicon policy machines.deny refuses pennywise; use machine: local" });
  });
  it.each(["restore", "fork", "restart"])("refuses to %s a row on a denied machine, saying it cannot move", action => {
    expect(placeAgent("rubicon", policy, action, undefined, "pennywise", undefined)).toMatchObject({ refusal: expect.stringContaining("cannot move machines, so close it and launch again with machine: local") });
  });
  it("falls back to local with a note when only the clone default is denied", () => {
    expect(placeAgent("rubicon", policy, "launch", undefined, undefined, "pennywise"))
      .toEqual({ machine: "local", note: "clone default pennywise is denied by project rubicon policy machines.deny; launching on local" });
  });
  it("leaves other machines alone", () => {
    expect(placeAgent("rubicon", policy, "launch", "local", undefined, undefined)).toEqual({ machine: "local" });
    expect(placeAgent("rubicon", policy, "launch", "blaine", undefined, undefined)).toEqual({ machine: "blaine" });
  });
  it("merges a deny list whole, clears with [] and shows it in the policy in force", () => {
    expect(mergePolicy({ machines: { deny: ["a"] }, wipLimit: 2 }, { machines: { deny: ["b"] } })).toEqual({ machines: { deny: ["b"] }, wipLimit: 2 });
    expect(mergePolicy(policy, { machines: { deny: [] } }).machines).toEqual({ deny: [] });
    expect(mergePolicy(policy, { wipLimit: 1 }).machines).toEqual(policy.machines);
    expect(effectivePolicy(undefined, policy).machines).toEqual({ deny: ["pennywise"] });
    expect(effectivePolicy(undefined, undefined).machines).toEqual({ deny: [] });
  });
});
