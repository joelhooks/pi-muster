import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as versionSkew from "./version-skew.ts";

import muster from "../extensions/pi-muster.ts";

function fakePi() {
  const tools: string[] = [];
  const defs = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
  let thinking = "high";
  const flags: string[] = [];
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const handlers: string[] = [];
  const emitted: string[] = [];
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => {
      tools.push(tool.name);
      defs.set(tool.name, tool);
    },
    getThinkingLevel: () => thinking,
    // Like a model that has no xhigh: it clamps to high.
    setThinkingLevel: (level: string) => {
      thinking = level === "xhigh" ? "high" : level;
    },
    registerFlag: (name: string) => flags.push(name),
    registerCommand: (name: string) => commands.push(name),
    registerShortcut: (key: string) => shortcuts.push(key),
    on: (event: string) => handlers.push(event),
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    appendEntry: () => {},
    events: {
      emit: (event: string) => emitted.push(event),
      on: () => () => {},
    },
  };
  return { pi, tools, defs, flags, commands, shortcuts, handlers, emitted };
}

const saved = { ...process.env };
beforeEach(() => {
  for (const key of ["MUSTER_ROLE", "MUSTER_AGENT", "MUSTER_PROJECT", "MUSTER_OWNER"]) delete process.env[key];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ["MUSTER_ROLE", "MUSTER_AGENT", "MUSTER_PROJECT", "MUSTER_OWNER"]) delete process.env[key];
  Object.assign(process.env, saved);
});

const OWNER_TOOLS = [
  "thinking_set",
  "desk_inbox",
  "desk_answer",
  "desk_report",
  "desk_rulings",
  "project_open",
  "project_move",
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
    expect(fake.tools).toEqual(["skill_find", ...OWNER_TOOLS]);
    expect(fake.defs.get("project_status")).toMatchObject({ parameters: { properties: { takeover: { type: "boolean" } } } });
    expect(fake.flags).toEqual(["compact-at", "switchboard"]);
    expect(fake.commands).toEqual(["compact-at", "switchboard"]);
    expect(fake.shortcuts).toEqual(["alt+s"]);
    expect(fake.emitted).toEqual([]);
  });

  it("gives a worker packet_report and skill_find: no desk, no path to Joel", () => {
    Object.assign(process.env, { MUSTER_ROLE: "worker", MUSTER_AGENT: "w1", MUSTER_PROJECT: "/p", MUSTER_OWNER: "boss" });
    const fake = fakePi();
    muster(fake.pi as never);
    expect(fake.tools).toEqual(["packet_report", "skill_find"]);
  });

  it("gives a boss both sides: it reports up and owns its workers", () => {
    Object.assign(process.env, { MUSTER_ROLE: "boss", MUSTER_AGENT: "b1", MUSTER_PROJECT: "/p", MUSTER_OWNER: "hawk" });
    const fake = fakePi();
    muster(fake.pi as never);
    expect(fake.tools).toEqual(["packet_report", "skill_find", ...OWNER_TOOLS]);
  });
});

describe("registered tool version skew", () => {
  it("appends the warning to the real thinking_set tool through extension registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "muster-extension-skew-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    git("commit", "-q", "--allow-empty", "-m", "loaded");
    const loaded = git("rev-parse", "HEAD");
    const skew = versionSkew.createVersionSkew({ root });
    vi.spyOn(versionSkew, "createVersionSkew").mockReturnValue(skew);
    const fake = fakePi();
    muster(fake.pi as never);
    git("commit", "-q", "--allow-empty", "-m", "updated");
    const disk = git("rev-parse", "HEAD");
    const result = await fake.defs.get("thinking_set")?.execute("id", { level: "low" });
    expect(result?.content[0]?.text).toBe(`Thinking high → low, from the next model call.\n⚠ Muster tools are stale: loaded ${loaded.slice(0, 7)}, on disk ${disk.slice(0, 7)} (1 commits). Restart this session (or /reload) to load them.`);
  });
});

describe("thinking_set", () => {
  it("changes the session's own thinking level and says when the model clamps it", async () => {
    const fake = fakePi();
    muster(fake.pi as never);
    const tool = fake.defs.get("thinking_set");
    expect((await tool?.execute("id", { level: "low" }))?.content[0]?.text).toBe("Thinking high → low, from the next model call.");
    expect((await tool?.execute("id", { level: "xhigh" }))?.content[0]?.text).toContain("this model clamps xhigh to high");
  });
});
