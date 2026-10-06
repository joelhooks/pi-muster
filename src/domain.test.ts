import { describe, expect, it } from "vitest";

import { Schema } from "effect";
import { GateReceipt, decodeAgentName, decodeDeskItem, decodeProject, isTempPath } from "./domain.ts";

const project = {
  version: 1,
  slug: "probe",
  label: "probe",
  dir: "/p",
  outcome: "o",
  reviewTrigger: "r",
  criticalPath: [],
  nextAction: "n",
  mode: "rift-merge",
  spaceId: "w1",
  sidebar: "owned",
  ephemeral: false,
  musterExtension: null,
  deskExtension: null,
  cadenceMinutes: 15,
  state: "active",
  lanes: [],
  agents: [
    {
      name: "w1",
      role: "worker",
      lane: "probe",
      cwd: "/c",
      clone: null,
      profile: { label: "w", model: "m", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: 1 },
      sessionId: "w1-1",
      sessionFile: null,
      parentSessionFile: null,
      pane: null,
      owner: "o",
      brief: null,
      state: "running",
      delivery: "proven",
      restarts: 0,
      restore: null,
      createdAt: "t",
      updatedAt: "t",
    },
  ],
  packets: [],
  reviews: [],
  createdAt: "t",
  updatedAt: "t",
};

describe("schemas", () => {
  it("decodes a valid project and catalog row", () => {
    expect(decodeProject(project).agents[0]?.state).toBe("running");
  });

  it("decodes old lanes and clone rows with no base as null", () => {
    const lane = {
      slug: "probe", kind: "work", label: "probe", goal: "g", writeScope: [],
      repo: null, generated: [], tabId: null, root: null, state: "proposed",
      archived: false, createdAt: "t", updatedAt: "t",
    };
    const old = { ...project, lanes: [lane], agents: [{ ...project.agents[0], clone: { source: "/p", branch: "worker/w1" } }] };
    const decoded = decodeProject(old);
    expect(decoded.lanes[0]?.base).toBeNull();
    expect(decoded.agents[0]?.clone?.base).toBeNull();
    expect(decodeProject({ ...old, lanes: [{ ...lane, base: "release" }] }).lanes[0]?.base).toBe("release");
    expect(() => decodeProject({ ...old, lanes: [{ ...lane, base: 42 }] })).toThrow();
  });

  it("defaults an old project file's board type and decodes a custom type", () => {
    expect(decodeProject(project).boardType).toBe("project");
    expect(decodeProject({ ...project, boardType: "report" }).boardType).toBe("report");
    expect(() => decodeProject({ ...project, boardType: 42 })).toThrow();
  });

  it("defaults supersedes in old catalogs and decodes a follow-up link", () => {
    const packet = {
      id: "abc", kind: "commit", lane: "probe", agent: "w1", artifact: null,
      report: "/report.md", checks: [], state: "verified", verification: null,
      landedAs: null, reportedAt: "t", updatedAt: "t",
    };
    expect(decodeProject({ ...project, packets: [packet] }).packets[0]?.supersedes).toBeNull();
    expect(decodeProject({ ...project, packets: [packet] }).packets[0]?.gate).toBeNull();
    expect(decodeProject({ ...project, packets: [{ ...packet, supersedes: "earlier" }] }).packets[0]?.supersedes).toBe("earlier");
    expect(() => decodeProject({ ...project, packets: [{ ...packet, supersedes: 42 }] })).toThrow();
  });

  it("rejects bad names, states, and roles at the boundary", () => {
    expect(() => decodeAgentName("Bad Name")).toThrow(/agent name/);
    expect(() => decodeProject({ ...project, agents: [{ ...project.agents[0], state: "idle" }] })).toThrow();
    expect(() => decodeProject({ ...project, agents: [{ ...project.agents[0], role: "king" }] })).toThrow();
    expect(() => decodeProject({ ...project, slug: "Has Space" })).toThrow(/slug/);
    expect(() => decodeProject({ ...project, version: 2 })).toThrow();
  });

  it("decodes desk items in the dark-wizard queue format", () => {
    expect(decodeDeskItem({ id: "a1", ts: "t", from: "hawk", kind: "decision", title: "x", resolves: "b2" }).resolves).toBe("b2");
    expect(() => decodeDeskItem({ id: "a1", ts: "t", from: "hawk", kind: "gossip", title: "x" })).toThrow();
  });

  it("flags temp dirs", () => {
    expect(isTempPath("/tmp/x")).toBe(true);
    expect(isTempPath("/tmp")).toBe(true);
    expect(isTempPath("/private/var/folders/ab/T/x")).toBe(true);
    expect(isTempPath("/Users/me/Code/x")).toBe(false);
    expect(isTempPath("/tmpfoo")).toBe(false);
    expect(isTempPath("/Volumes/gate-tmp")).toBe(true);
    expect(isTempPath("/Volumes/gate-tmp/run-123-abc/project")).toBe(true);
    expect(isTempPath("/Volumes/gate-tmpx")).toBe(false);
  });
});

describe("GateReceipt", () => {
  it("accepts fleet-compute's superset receipt with a null slot and keeps only the known fields", () => {
    const decoded = Schema.decodeUnknownSync(GateReceipt)({
      runId: "r1", host: "flagg", tree: "t", exit: 0, slot: null, durationMs: 5,
      repo: "pi-muster", head: "h", branch: "b", startedAt: "2026-10-02T16:00:00.000Z", lease: null,
      queuedMs: 1, slotHeld: true, peakLoad1: 30.5, minAvailableGB: 40,
    });
    expect(decoded).toEqual({ runId: "r1", host: "flagg", tree: "t", exit: 0, slot: null, durationMs: 5 });
  });
});
