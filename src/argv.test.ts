import { describe, expect, it } from "vitest";

import { FORBIDDEN_FLAGS, buildArgv, mintSessionId, profileFor, sessionDirFor, sessionIdFromFile, shellPrelude, slimProblem } from "./argv.ts";
import { roleDefaults } from "./domain.ts";

const profile = profileFor("worker", {
  label: "🔨 store",
  appendSystemPrompt: ["/b/brief.md"],
  skills: ["/s/tdd"],
  extensions: ["/e/extra.ts"],
});

describe("buildArgv", () => {
  it.each(["desk", "boss", "hawk", "judge"] as const)("%s loads package muster once unless noSkills", role => {
    const p = profileFor(role, { label: role, noSkills: false });
    expect(p.skills.some(s => s.endsWith("/skills/muster"))).toBe(true);
    const duplicate = profileFor(role, { label: role, noSkills: false, skills: p.skills });
    expect(duplicate.skills).toEqual(p.skills);
    expect(profileFor(role, { label: role, noSkills: false, skills: ["muster", ...p.skills.map(s => s + "/SKILL.md")] }).skills).toEqual(p.skills);
    const argv = buildArgv({ kind: "launch", sessionId: role, sessionFile: null, parentSessionFile: null, musterExtension: null, profile: p });
    expect(argv.filter(a => a === "--skill")).toHaveLength(1);
    expect(argv).toContain(p.skills[0]);
    expect(profileFor(role, { label: role, noSkills: true }).skills).toEqual([]);
    expect(profileFor("worker", { label: "worker" }).skills).toEqual([]);
  });
  it("builds the exact launch argv with role defaults", () => {
    expect(buildArgv({ kind: "launch", sessionId: "w1-1", sessionFile: null, parentSessionFile: null, profile, musterExtension: "/muster" })).toEqual([
      "--session-id", "w1-1",
      "--name", "🔨 store",
      "--model", "openai-codex/gpt-6.1-sol:medium",
      "--append-system-prompt", "/b/brief.md",
      "-ns",
      "--skill", "/s/tdd",
      "-e", "/muster",
      "-e", "/e/extra.ts",
      "--compact-at", "200000",
      "--approve",
    ]);
  });

  it("forks from the parent file and restores from the session file", () => {
    const fork = buildArgv({ kind: "fork", sessionId: "kid", sessionFile: null, parentSessionFile: "/s/boss.jsonl", profile, musterExtension: null });
    expect(fork.slice(0, 4)).toEqual(["--fork", "/s/boss.jsonl", "--session-id", "kid"]);
    const restore = buildArgv({ kind: "restore", sessionId: "kid", sessionFile: "/s/x_kid.jsonl", parentSessionFile: null, profile, musterExtension: null });
    expect(restore.slice(0, 2)).toEqual(["--session", "/s/x_kid.jsonl"]);
    expect(restore).not.toContain("--fork");
    expect(() => buildArgv({ kind: "fork", sessionId: "kid", sessionFile: null, parentSessionFile: null, profile, musterExtension: null })).toThrow(/parent/);
  });

  it("never emits a tool-registry flag", () => {
    for (const role of ["desk", "hawk", "boss", "worker", "judge"] as const) {
      const argv = buildArgv({ kind: "launch", sessionId: "a", sessionFile: null, parentSessionFile: null, profile: profileFor(role, { label: "x" }), musterExtension: "/m" });
      expect(argv.filter((arg) => FORBIDDEN_FLAGS.includes(arg))).toEqual([]);
    }
    expect(() =>
      buildArgv({ kind: "launch", sessionId: "a", sessionFile: null, parentSessionFile: null, profile: { ...profile, skills: ["--tools"] }, musterExtension: null }),
    ).toThrow(/would parse as a flag/);
  });

  it("keeps roles distinct: owners keep skills, workers trim the prefix", () => {
    expect(profileFor("hawk", { label: "🦅 hawk" })).toMatchObject({ model: "claude-bridge/claude-opus-5-5", thinking: "high", noSkills: false, compactAt: 400000 });
    expect(profileFor("worker", { label: "w" }).noSkills).toBe(true);
    expect(profileFor("judge", { label: "j", compactAt: null, thinking: null }).compactAt).toBeNull();
  });
});

describe("slim profile", () => {
  it("loads only the named extensions: no discovery, no context files, no Muster extension or skill, no tool flags", () => {
    const profile = profileFor("hawk", { label: "🗂️ EA", model: "claude-bridge/claude-haiku-5-5", thinking: "low", slim: true, noSkills: true, extensions: ["/pi-ratking"] });
    expect(profile).toMatchObject({ slim: true, skills: [], extensions: ["/pi-ratking"] });
    const argv = buildArgv({ kind: "launch", sessionId: "ea", sessionFile: null, parentSessionFile: null, profile, musterExtension: "/muster" });
    expect(argv).toEqual(expect.arrayContaining(["-ne", "-nc", "-ns", "-e", "/pi-ratking"]));
    expect(argv).not.toContain("/muster");
    expect(argv.filter(arg => FORBIDDEN_FLAGS.includes(arg))).toEqual([]);
    // --compact-at is the Muster extension's flag; a slim Pi rejects it at startup.
    expect(argv).not.toContain("--compact-at");
    expect(slimProblem(profile)).toContain("herdr-agent-state.ts");
    expect(slimProblem({ ...profile, extensions: ["/pi-ratking", "/h/.pi/agent/extensions/herdr-agent-state.ts"] })).toBeNull();
    // Restore keeps the stored profile, so the row stays slim.
    expect(buildArgv({ kind: "restore", sessionId: "ea", sessionFile: "/s/ea.jsonl", parentSessionFile: null, profile, musterExtension: "/muster" })).toContain("-ne");
  });
  it("leaves ordinary profiles untouched", () => {
    const argv = buildArgv({ kind: "launch", sessionId: "d", sessionFile: null, parentSessionFile: null, profile: profileFor("desk", { label: "d" }), musterExtension: "/muster" });
    expect(argv).not.toContain("-ne"); expect(argv).not.toContain("-nc"); expect(argv).toContain("/muster");
    expect(argv).toContain("--compact-at");
  });
});

describe("helpers", () => {
  it("says off for a null compact-at and takes project role defaults", () => {
    const off = profileFor("judge", { label: "j", compactAt: null });
    const argv = buildArgv({ kind: "launch", sessionId: "a", sessionFile: null, parentSessionFile: null, profile: off, musterExtension: null });
    expect(argv[argv.indexOf("--compact-at") + 1]).toBe("off");
    const tuned = profileFor("worker", { label: "w" }, roleDefaults(undefined, { roles: { worker: { model: "openai-codex/gpt-6-luna", compactAt: 200_000 } } }, "worker"));
    expect(tuned).toMatchObject({ model: "openai-codex/gpt-6-luna", thinking: "medium", compactAt: 200_000, noSkills: true });
  });

  it("quotes the shell prelude and rejects bad env names", () => {
    expect(shellPrelude("/w/it's", { MUSTER_AGENT: "w1" })).toBe("cd '/w/it'\\''s' && export MUSTER_AGENT='w1'");
    expect(() => shellPrelude("/w", { "bad-name": "x" })).toThrow(/invalid env/);
    expect(shellPrelude("/w", { MUSTER_AGENT: "w1" }, "/m/bin")).toBe(`cd '/w' && export MUSTER_AGENT='w1' && export PATH='/m/bin':"$PATH"`);
  });

  it("reads session ids from Pi file names", () => {
    expect(sessionIdFromFile("/s/2026-09-29T05-06-52-517Z_muster-20260929T0506.jsonl")).toBe("muster-20260929T0506");
    expect(sessionIdFromFile("/s/2026-09-29T05-06-52-517Z_0123abcd-ef01-2345.jsonl")).toBe("0123abcd-ef01-2345");
    expect(sessionIdFromFile("/s/nope.txt")).toBeNull();
    expect(mintSessionId("probe_1", new Date("2026-09-29T04:49:07Z"))).toBe("probe_1-20260929T044907");
    expect(sessionDirFor("/Users/me/Code/x", "/h")).toBe("/h/.pi/agent/sessions/--Users-me-Code-x--");
  });
});

// Joel, 2026-10-12: Claude compacts by 400k; rows launched at 450k keep that value in their stored profile.
it("caps --compact-at at 400k for Claude rows, whatever the stored profile says, and leaves other models and off alone", () => {
  const at = (model: string, compactAt: number | null) => { const argv = buildArgv({ kind: "launch", sessionId: "s", sessionFile: null, parentSessionFile: null, musterExtension: "/muster", profile: { ...profileFor("desk", { label: "d" }), model, compactAt } }); return argv[argv.indexOf("--compact-at") + 1]; };
  expect(at("claude-bridge/claude-opus-5-5", 450_000)).toBe("400000");
  expect(at("claude-bridge/claude-opus-5-5", 300_000)).toBe("300000");
  expect(at("claude-bridge/claude-opus-5-5", null)).toBe("off");
  expect(at("openai-codex/gpt-6.1-sol", 450_000)).toBe("450000");
});
