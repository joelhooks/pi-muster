import { describe, expect, it } from "vitest";
import { agentEnv, buildArgv, profileFor } from "./argv.ts";
import { decodePolicy, roleLaunch, withRoleLaunch, type AgentRow, type Project } from "./domain.ts";
import { requiredWriterSchema } from "./store.ts";

// Lean Loadout (Joel, desk page sb-desk-20261022c: "the per-role tool setting in pi-muster").
const base = profileFor("judge", { label: "judge", noSkills: true });
const lean = decodePolicy({ roles: { judge: { tools: ["read", "bash", "codemode", "packet_report"], env: { LEAN_LOADOUT_READONLY: "1" }, appendSystemPrompt: ["/brain/skill-names.txt"] } } });
const argv = (profile = base) => buildArgv({ kind: "launch", sessionId: "s", sessionFile: null, parentSessionFile: null, profile, musterExtension: null, prompt: "go" });

describe("role launch policy", () => {
  it("emits no tool flag without a policy, and --tools plus the prompt files with one, before the prompt", () => {
    expect(argv()).not.toContain("--tools");
    const args = argv(withRoleLaunch(base, lean, "judge"));
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "read,bash,codemode,packet_report"]);
    expect(args.indexOf("--tools")).toBeLessThan(args.indexOf("--"));
    expect(args).toEqual(expect.arrayContaining(["--append-system-prompt", "/brain/skill-names.txt"]));
    expect(argv(withRoleLaunch(base, lean, "worker"))).not.toContain("--tools");
  });

  it("still refuses any other tool-registry flag", () => {
    expect(() => argv({ ...base, skills: ["--no-tools"] })).toThrow(/would parse as a flag|tool-registry/);
    expect(() => argv({ ...base, extensions: ["-nt"] })).toThrow();
  });

  it("refuses a tool, env key or prompt path that could parse as a flag or is not absolute", () => {
    for (const roles of [{ judge: { tools: ["-x"] } }, { judge: { tools: ["read,bash"] } }, { judge: { env: { "A-B": "1" } } }, { judge: { appendSystemPrompt: ["names.txt"] } }])
      expect(() => roleLaunch(decodePolicy({ roles }), "judge")).toThrow("policy.roles.judge");
  });

  it("a cleared or empty policy drops what an older profile carried", () => {
    const applied = withRoleLaunch(base, lean, "judge");
    expect(applied.policy?.tools).toHaveLength(4);
    expect(withRoleLaunch(applied, decodePolicy({ roles: { judge: { tools: null, env: {}, appendSystemPrompt: [] } } }), "judge").policy).toBeUndefined();
    expect(withRoleLaunch(applied, undefined, "judge").policy).toBeUndefined();
  });

  it("policy env reaches the agent, and the row's own env wins over it", () => {
    const profile = withRoleLaunch({ ...base, env: { LEAN_LOADOUT_READONLY: "0" } }, decodePolicy({ roles: { judge: { env: { LEAN_LOADOUT_READONLY: "1", LEAN_LOADOUT_WRITE_ALLOW: "/reports" } } } }), "judge");
    const env = agentEnv({ slug: "p", dir: "/p" } as Project, { name: "j", role: "judge", lane: "l", owner: "o", profile } as unknown as AgentRow);
    expect(env).toMatchObject({ LEAN_LOADOUT_READONLY: "0", LEAN_LOADOUT_WRITE_ALLOW: "/reports" });
  });

  it("stamps the catalog so an older writer cannot drop a role's tool policy", () => {
    const project = { lanes: [], agents: [], policy: undefined } as unknown as Project;
    expect(requiredWriterSchema(project)).toBe(1);
    expect(requiredWriterSchema({ ...project, policy: lean })).toBe(5);
    expect(requiredWriterSchema({ ...project, agents: [{ profile: withRoleLaunch(base, lean, "judge") }] } as unknown as Project)).toBe(5);
  });
});
