import { mkdirSync, readdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findSkills, resolveSkills, skillIndex, withHiddenSkills } from "./skills.ts";
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
  it("ranks exact names before description hits, skips disabled skills, bounds results", async () => {
    const f = fixture();
    const skills = await skillIndex(f);
    const matches = findSkills({ skills, query: "testing" });
    expect(matches).toHaveLength(5);
    expect(matches[0]?.name).toBe("testing");
    expect(matches.some((s) => s.name === "builder")).toBe(true);
    expect(matches.some((s) => s.name === "hidden")).toBe(false);
    expect(findSkills({ skills, query: "hidden" })).toEqual([]);
    // A launch may still name a model-hidden skill, here through a symlinked skill directory (para-operator, 2026-10-11).
    const real = join(f.cwd, "elsewhere", "operator"); f.skill(join(f.cwd, "elsewhere"), "operator", "Hidden operator", true);
    symlinkSync(real, join(f.agentDir, "skills", "operator"));
    const linked = await skillIndex(f);
    const hiddenPaths = [realpathSync(join(f.agentDir, "skills", "hidden", "SKILL.md")), realpathSync(join(real, "SKILL.md"))];
    expect(resolveSkills({ skills: ["hidden", "operator", "testing"], index: linked })).toEqual({ paths: [...hiddenPaths, realpathSync(f.exact)], notes: [], hidden: hiddenPaths });
    // Pi keeps hidden skills out of the model's list even under --skill, so their SKILL.md joins the appended prompt once.
    expect(withHiddenSkills(["/brief.md", hiddenPaths[0]!], hiddenPaths)).toEqual(["/brief.md", ...hiddenPaths]);
    expect(findSkills({ skills, query: "zebra" })).toEqual([]);
    expect(findSkills({ skills, query: "testing", limit: 99 })).toHaveLength(10);
    expect(findSkills({ skills, query: "fixtures", limit: 1 })[0]?.name).toBe("builder");
    expect(matches.every((s) => s.description.length <= 200)).toBe(true);
  });

  it.each([
    ["write tests first red green", "tdd"],
    ["write a brief for an agent", "writing-for-agents"],
  ])("ranks task terms above common name words: %s", async (query, expected) => {
    const f = fixture();
    const base = join(f.agentDir, "skills");
    f.skill(base, "brain-first-workflow", "Use when agents write plans and tests");
    f.skill(base, "write-a-skill", "Use when an agent needs to write a skill");
    f.skill(base, "agent-browser", "Use an agent to browse");
    f.skill(base, "tdd", "Test-first development with red-green-refactor");
    f.skill(base, "writing-for-agents", "Create briefs consumed by agents");
    for (let i = 0; i < 20; i++) f.skill(base, `common-${i}`, "Use when agents write plans and tests for work");
    const skills = await skillIndex(f);
    // Frozen old scorer proves these fixtures reproduce the desk's regressions.
    const words = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const old = skills.map((skill) => {
      const name = new Set(skill.name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      const description = new Set(skill.description.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      let score = skill.name === query ? 100 : 0;
      for (const word of words) score += (name.has(word) ? 5 : 0) + (description.has(word) ? 1 : 0);
      return { name: skill.name, score };
    }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    expect(old[0]?.name).not.toBe(expected);
    expect(findSkills({ skills, query })[0]?.name).toBe(expected);
  });

  it("normalizes light suffixes, ignores stopwords and keeps stable ties", async () => {
    const f = fixture();
    const base = join(f.agentDir, "skills");
    f.skill(base, "alpha", "write test");
    f.skill(base, "beta", "writing tested");
    const skills = await skillIndex(f);
    expect(findSkills({ skills, query: "tested writing" }).slice(0, 2).map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(findSkills({ skills, query: "writing tests" }).slice(0, 2).map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(findSkills({ skills, query: "a an the for to of and with use when" })).toEqual([]);
  });

  it("reads both settings paths relative to their settings dirs and follows agentDir env", async () => {
    const f = fixture();
    f.skill(join(f.agentDir, "custom"), "global-extra", "global");
    f.skill(join(f.cwd, ".pi", "custom"), "local-extra", "local");
    mkdirSync(join(f.cwd, ".pi"), { recursive: true });
    writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ skills: ["custom"] }));
    writeFileSync(join(f.cwd, ".pi", "settings.json"), JSON.stringify({ skills: ["custom"] }));
    symlinkSync(join(f.agentDir, "skills", "testing"), join(f.agentDir, "custom", "alias"));
    vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDir);
    const skills = await skillIndex({ cwd: f.cwd });
    expect(skills.map((s) => s.name)).toEqual(expect.arrayContaining(["global-extra", "local-extra"]));
    expect(skills.filter((s) => s.name === "testing")).toHaveLength(1);
  });

  it("indexes skills shipped by settings packages and resolves a launch naming one", async () => {
    const f = fixture();
    const pkg = join(f.cwd, "pkg");
    f.skill(join(pkg, "skills"), "pkg-effect", "Effect source search");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pkg", pi: { skills: ["skills"] } }));
    writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    const skills = await skillIndex(f);
    expect(skills.map((s) => s.name)).toContain("pkg-effect");
    expect(findSkills({ skills, query: "effect source" })[0]?.name).toBe("pkg-effect");
    const resolved = resolveSkills({ skills: ["pkg-effect"], index: skills });
    expect(resolved.notes).toEqual([]);
    expect(resolved.paths).toHaveLength(1);
  });

  it("never installs a missing package and still indexes the rest", async () => {
    const f = fixture();
    writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:muster-test-not-installed@1.0.0", "git:github.com/none/not-installed"] }));
    const before = readdirSync(f.agentDir).sort();
    const skills = await skillIndex(f);
    expect(skills.map((s) => s.name)).toContain("testing");
    expect(readdirSync(f.agentDir).sort()).toEqual(before);
  });

  it("merges roster, alternate, policy, launch in order and deduplicates real paths", async () => {
    const f = fixture();
    const alt = f.skill(join(f.agentDir, "skills"), "alternate", "alternate");
    const policy = f.skill(join(f.agentDir, "skills"), "policy", "policy");
    const launch = f.skill(join(f.agentDir, "skills"), "launch", "launch");
    const alias = join(f.cwd, "alias.md");
    symlinkSync(f.exact, alias);
    const roster = decodeRoster({ version: 1, roles: { worker: {
      skills: ["testing"], alternates: [{ model: "test/other", skills: ["alternate", "testing"], useFor: [] }],
    } } });
    const defaults = roleDefaults(roster, { roles: { worker: { skills: ["policy"] } } }, "worker", "test/other");
    const profile = profileFor("worker", { label: "w", skills: ["launch", alias, "missing"] }, defaults);
    const result = resolveSkills({ skills: profile.skills, index: await skillIndex(f) });
    expect(result.paths).toEqual([f.exact, alt, policy, launch].map((p) => realpathSync(p)));
    expect(result.notes).toEqual(['skill "missing" not found; skipped']);
    const argv = buildArgv({ kind: "launch", sessionId: "w", sessionFile: null, parentSessionFile: null,
      musterExtension: null, profile: { ...profile, skills: result.paths } });
    const start = argv.indexOf("-ns");
    expect(argv.slice(start, start + 9)).toEqual(["-ns", "--skill", f.exact, "--skill", alt, "--skill", policy, "--skill", launch]);
  });
});
