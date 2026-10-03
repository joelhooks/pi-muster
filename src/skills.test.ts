import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSkills, resolveSkills, skillIndex } from "./skills.ts";
import { decodeRoster, roleDefaults } from "./domain.ts";
import { buildArgv, profileFor } from "./argv.ts";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "muster-skills-")));
  const agentDir = join(cwd, "agent");
  function skill(base: string, name: string, description: string, disabled = false) {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: ${disabled}\n---\n# Instructions\n`);
    return path;
  }
  const exact = skill(join(agentDir, "skills"), "testing", "Run checks");
  skill(join(agentDir, "skills"), "builder", "Build with testing and fixtures");
  skill(join(agentDir, "skills"), "hidden", "testing", true);
  for (let i = 0; i < 12; i++) skill(join(agentDir, "skills"), `extra-${i}`, "testing " + "x".repeat(250));
  return { cwd, agentDir, skill, exact };
}

describe("skill discovery", () => {
  it("ranks exact names before description hits, skips disabled skills, bounds results", () => {
    const f = fixture();
    const skills = skillIndex(f);
    const matches = findSkills({ skills, query: "testing" });
    expect(matches).toHaveLength(5);
    expect(matches[0]?.name).toBe("testing");
    expect(matches.some((s) => s.name === "builder")).toBe(true);
    expect(skills.some((s) => s.name === "hidden")).toBe(false);
    expect(findSkills({ skills, query: "zebra" })).toEqual([]);
    expect(findSkills({ skills, query: "testing", limit: 99 })).toHaveLength(10);
    expect(findSkills({ skills, query: "fixtures", limit: 1 })[0]?.name).toBe("builder");
    expect(matches.every((s) => s.description.length <= 200)).toBe(true);
  });

  it("reads both settings paths relative to their settings dirs and follows agentDir env", () => {
    const f = fixture();
    f.skill(join(f.agentDir, "custom"), "global-extra", "global");
    f.skill(join(f.cwd, ".pi", "custom"), "local-extra", "local");
    mkdirSync(join(f.cwd, ".pi"), { recursive: true });
    writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ skills: ["custom"] }));
    writeFileSync(join(f.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["custom"] }));
    symlinkSync(join(f.agentDir, "skills", "testing"), join(f.agentDir, "custom", "alias"));
    vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDir);
    const skills = skillIndex({ cwd: f.cwd });
    expect(skills.map((s) => s.name)).toEqual(expect.arrayContaining(["global-extra", "local-extra"]));
    expect(skills.filter((s) => s.name === "testing")).toHaveLength(1);
  });

  it("merges roster, alternate, policy, launch in order and deduplicates real paths", () => {
    const f = fixture();
    const alt = f.skill(join(f.agentDir, "skills"), "alternate", "alternate");
    const policy = f.skill(join(f.agentDir, "skills"), "policy", "policy");
    const launch = f.skill(join(f.agentDir, "skills"), "launch", "launch");
    const alias = join(f.cwd, "alias.md");
    symlinkSync(f.exact, alias);
    const roster = decodeRoster({ version: 1, roles: { worker: {
      skills: ["testing"], alternates: [{ model: "other", skills: ["alternate", "testing"], useFor: [] }],
    } } });
    const defaults = roleDefaults(roster, { roles: { worker: { skills: ["policy"] } } }, "worker", "other");
    const profile = profileFor("worker", { label: "w", skills: ["launch", alias, "missing"] }, defaults);
    const result = resolveSkills({ skills: profile.skills, index: skillIndex(f) });
    expect(result.paths).toEqual([f.exact, alt, policy, launch].map((p) => realpathSync(p)));
    expect(result.notes).toEqual(['skill "missing" not found; skipped']);
    const argv = buildArgv({ kind: "launch", sessionId: "w", sessionFile: null, parentSessionFile: null,
      musterExtension: null, profile: { ...profile, skills: result.paths } });
    const start = argv.indexOf("-ns");
    expect(argv.slice(start, start + 9)).toEqual(["-ns", "--skill", f.exact, "--skill", alt, "--skill", policy, "--skill", launch]);
  });
});
