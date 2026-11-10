import { Effect } from "effect";
import { expect, it } from "vitest";
import { decodePolicy, decodeRoster, effectivePolicy, roleDefaults, rosterIgnoredKeys } from "./domain.ts";
import { launchDefaults } from "./fleet-steer.ts";

// lean-loadout, 2026-11-10: roster tools, appendSystemPrompt and env decoded, showed as in force, and never reached a launch.
const roster = decodeRoster({
  version: 1,
  roles: {
    worker: { model: "claude-bridge/claude-opus-5-5", tools: ["read", "bash"], env: { LEAN: "1" }, appendSystemPrompt: ["/srv/names.txt"] },
    judge: { model: "claude-bridge/claude-opus-5-5", env: { JUDGE: "1" } },
  },
});

it("never shows roster tools, appendSystemPrompt or env as in force", () => {
  const worker = roleDefaults(roster, undefined, "worker");
  expect(worker).not.toHaveProperty("tools");
  expect(worker).not.toHaveProperty("env");
  expect(worker).not.toHaveProperty("appendSystemPrompt");
  expect(effectivePolicy(roster, undefined).roles.worker).not.toHaveProperty("tools");
});

it("names the roster keys a launch ignores, unless project policy sets them", () => {
  expect(rosterIgnoredKeys(roster, undefined, "worker")).toEqual(["tools", "appendSystemPrompt", "env"]);
  expect(rosterIgnoredKeys(roster, undefined, "judge")).toEqual(["env"]);
  expect(rosterIgnoredKeys(roster, undefined, "desk")).toEqual([]);
  const policy = decodePolicy({ roles: { worker: { tools: ["read"] } } });
  expect(rosterIgnoredKeys(roster, policy, "worker")).toEqual(["appendSystemPrompt", "env"]);
  expect(roleDefaults(roster, policy, "worker")).toMatchObject({ tools: ["read"] });
});

it("warns at launch for any role, so a roster edit is not believed shipped", () => {
  const run = (role: "worker" | "judge" | "desk") =>
    Effect.runSync(launchDefaults({ home: "/nonexistent", now: 0, action: "fork", roster, role }));
  expect(run("worker").notes).toContain("⚠ roster worker tools, appendSystemPrompt, env not applied: Muster sends these only from project policy (project_update policy.roles.worker) or a lane's workerTools (lane_open)");
  expect(run("judge").notes).toContain("⚠ roster judge env not applied: Muster sends these only from project policy (project_update policy.roles.judge)");
  expect(run("desk").notes.some(note => note.startsWith("⚠ roster"))).toBe(false);
});
