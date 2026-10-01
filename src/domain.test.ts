import { describe, expect, it } from "vitest";

import { decodeAgentName, decodeDeskItem, decodeProject, isTempPath } from "./domain.ts";

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

  it("defaults an old project file's board type and decodes a custom type", () => {
    expect(decodeProject(project).boardType).toBe("project");
    expect(decodeProject({ ...project, boardType: "report" }).boardType).toBe("report");
    expect(() => decodeProject({ ...project, boardType: 42 })).toThrow();
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
  });
});
