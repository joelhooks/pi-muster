import { afterEach, describe, expect, it } from "vitest";

import muster from "../extensions/pi-muster.ts";

function fakePi() {
  const tools: string[] = [];
  const flags: string[] = [];
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const handlers: string[] = [];
  const emitted: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerFlag: (name: string) => flags.push(name),
    registerCommand: (name: string) => commands.push(name),
    registerShortcut: (key: string) => shortcuts.push(key),
    on: (event: string) => handlers.push(event),
    getFlag: () => undefined,
    appendEntry: () => {},
    events: {
      emit: (event: string) => emitted.push(event),
      on: () => () => {},
    },
  };
  return { pi, tools, flags, commands, shortcuts, handlers, emitted };
}

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["MUSTER_ROLE", "MUSTER_AGENT", "MUSTER_PROJECT", "MUSTER_OWNER"]) delete process.env[key];
  Object.assign(process.env, saved);
});

const OWNER_TOOLS = [
  "desk_inbox",
  "desk_answer",
  "project_open",
  "lane_open",
  "lane_close",
  "agent_launch",
  "agent_close",
  "packet_verify",
  "packet_land",
  "desk_post",
  "project_status",
  "project_update",
  "project_review",
];

describe("extension modes", () => {
  it("gives a plain session the owner tools and no worker tool, and starts nothing", () => {
    const fake = fakePi();
    muster(fake.pi as never);
    expect(fake.tools).toEqual(OWNER_TOOLS);
    expect(fake.flags).toEqual(["compact-at", "switchboard"]);
    expect(fake.commands).toEqual(["compact-at", "switchboard"]);
    expect(fake.shortcuts).toEqual(["alt+s"]);
    expect(fake.emitted).toEqual([]);
  });

  it("gives a worker only packet_report: no desk, no path to Joel", () => {
    Object.assign(process.env, { MUSTER_ROLE: "worker", MUSTER_AGENT: "w1", MUSTER_PROJECT: "/p", MUSTER_OWNER: "boss" });
    const fake = fakePi();
    muster(fake.pi as never);
    expect(fake.tools).toEqual(["packet_report"]);
  });

  it("gives a boss both sides: it reports up and owns its workers", () => {
    Object.assign(process.env, { MUSTER_ROLE: "boss", MUSTER_AGENT: "b1", MUSTER_PROJECT: "/p", MUSTER_OWNER: "hawk" });
    const fake = fakePi();
    muster(fake.pi as never);
    expect(fake.tools).toEqual(["packet_report", ...OWNER_TOOLS]);
  });
});
