import { describe, expect, it } from "vitest";

import { FORBIDDEN_FLAGS, buildArgv, mintSessionId, profileFor, sessionDirFor, sessionIdFromFile, shellPrelude } from "./argv.ts";
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
    expect(profileFor("hawk", { label: "🦅 hawk" })).toMatchObject({ model: "claude-bridge/claude-opus-5-5", thinking: "high", noSkills: false, compactAt: 450000 });
    expect(profileFor("worker", { label: "w" }).noSkills).toBe(true);
    expect(profileFor("judge", { label: "j", compactAt: null, thinking: null }).compactAt).toBeNull();
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
