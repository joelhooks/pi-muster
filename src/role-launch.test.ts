import { describe, expect, it } from "vitest";
import { agentEnv, buildArgv, profileFor } from "./argv.ts";
import { codemodeNote, decodePolicy, roleLaunch, withRoleLaunch, type AgentRow, type Project } from "./domain.ts";
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
    // Tin-Tin, #22 review: MUSTER_OWNER_NAME is set only for some rows, so a policy value would redirect reports.
    for (const key of ["MUSTER_OWNER_NAME", "MUSTER_COMMS", "RATKING_NAME", "HERDR_DESK_PROJECT", "PI_OFFLINE"])
      expect(() => roleLaunch(decodePolicy({ roles: { judge: { env: { [key]: "x" } } } }), "judge")).toThrow(`env "${key}" (reserved`);
    for (const roles of [{ judge: { tools: ["-x"] } }, { judge: { tools: ["read,bash"] } }, { judge: { env: { "A-B": "1" } } }, { judge: { appendSystemPrompt: ["names.txt"] } }])
      expect(() => roleLaunch(decodePolicy({ roles }), "judge")).toThrow("policy.roles.judge");
  });

  // Joel, desk page sb-desk-live 2026-10-26, card cffe0ce0: desks may launch lean on p8 through Pi's codemode switches.
  it("lets exactly Pi's two codemode switches through, with checked values, into the agent env and the receipt", () => {
    const codemode = decodePolicy({ roles: { desk: { env: { PI_CODEMODE_MODE: "only", PI_CODEMODE_DECLARE: "read,bash,owner_inbox" } } } });
    const profile = withRoleLaunch(profileFor("desk", { label: "desk" }), codemode, "desk");
    const env = agentEnv({ slug: "p", dir: "/p" } as Project, { name: "d", role: "desk", lane: "l", owner: "o", profile } as unknown as AgentRow);
    expect(env).toMatchObject({ PI_CODEMODE_MODE: "only", PI_CODEMODE_DECLARE: "read,bash,owner_inbox" });
    expect(codemodeNote(profile.policy)).toBe("codemode (role policy): mode only, declare read, bash, owner_inbox");
    expect(codemodeNote(withRoleLaunch(base, lean, "judge").policy)).toBeNull();
    expect(roleLaunch(decodePolicy({ roles: { desk: { env: { PI_CODEMODE_MODE: "on" } } } }), "desk")?.env).toEqual({ PI_CODEMODE_MODE: "on" });
    for (const [key, value] of <[string, string][]>[["PI_CODEMODE_MODE", "off"], ["PI_CODEMODE_MODE", "--tools"], ["PI_CODEMODE_DECLARE", ""], ["PI_CODEMODE_DECLARE", "read, bash"], ["PI_CODEMODE_DECLARE", "-x"], ["PI_CODEMODE_DECLARE", "read,,bash"]])
      expect(() => roleLaunch(decodePolicy({ roles: { desk: { env: { [key]: value } } } }), "desk")).toThrow(`env ${key} ${JSON.stringify(value)}`);
    for (const key of ["PI_CODEMODE", "PI_CODEMODE_MODES", "PI_SKIP_VERSION_CHECK"])
      expect(() => roleLaunch(decodePolicy({ roles: { desk: { env: { [key]: "on" } } } }), "desk")).toThrow(`env "${key}" (reserved`);
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
    expect(requiredWriterSchema({ ...project, agents: [{ state: "running", profile: withRoleLaunch(base, lean, "judge") }] } as unknown as Project)).toBe(5);
    // Tin-Tin, #22 review: once the lean rows close and the policy clears, older writers are let back in.
    expect(requiredWriterSchema({ ...project, agents: [{ state: "closed", profile: withRoleLaunch(base, lean, "judge") }] } as unknown as Project)).toBe(1);
  });
});
