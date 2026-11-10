import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { agentEnv } from "./argv.ts";
import { decodePolicy, decodeRoster, effectivePolicy, roleDefaults, rosterIgnoredKeys } from "./domain.ts";
import { launchDefaults } from "./fleet-steer.ts";
import { agentLaunchForeground, laneOpen, projectOpen } from "./ops.ts";
import { load } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

afterEach(() => { vi.unstubAllEnvs(); });

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

// Tin-Tin, #87 review: roleDefaults used to return the roster's env, tools and appendSystemPrompt, so prove no launch read them.
it("launches a worker with the same argv and env whether or not the roster sets tools, appendSystemPrompt and env", async () => {
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  vi.stubEnv("MUSTER_PROJECT", "");
  const launchWith = async (worker: Record<string, unknown>) => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    const rosterFile = join(h.home, "roster.json");
    writeFileSync(rosterFile, JSON.stringify({ version: 1, roles: { worker: { model: "opus", ...worker } } }));
    vi.stubEnv("MUSTER_ROSTER", rosterFile);
    await runWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "weekly", nextAction: "n", criticalPath: [], space: "w1", ephemeral: true, musterExtension: "/muster", deskExtension: null }));
    await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "g" }));
    const result = await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "worker", role: "worker", lane: "probe", label: "🔨 worker", cwd: dir }));
    const project = await runWith(h, load(dir));
    const env = agentEnv(project, result.row);
    const strip = (args: readonly string[]) => args.map(arg => arg.replaceAll(dir, "<dir>").replaceAll(h.root, "<root>").replace(/worker-\d{8}T\d{6}-[0-9a-f]{8}/g, "<session>"));
    return { argv: strip(result.argv), env: Object.keys(env).sort(), policy: result.row.profile.policy ?? null, notes: result.notes };
  };
  const plain = await launchWith({});
  const loaded = await launchWith({ tools: ["read", "bash"], env: { LEAN_PROBE: "1" }, appendSystemPrompt: ["/srv/names.txt"] });
  expect(loaded.argv).toEqual(plain.argv);
  expect(loaded.env).toEqual(plain.env);
  expect(loaded.policy).toEqual(plain.policy);
  expect(loaded.argv).not.toContain("--tools");
  expect(loaded.argv).not.toContain("/srv/names.txt");
  expect(loaded.env).not.toContain("LEAN_PROBE");
  expect(loaded.notes.join("\n")).toContain("⚠ roster worker tools, appendSystemPrompt, env not applied");
});
