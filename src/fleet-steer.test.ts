import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { agentLaunchForeground, laneOpen, projectOpen, projectUpdate } from "./ops.ts";

const sol = "openai-codex/gpt-6.1-sol";
const opus = "claude-bridge/claude-opus-5-5";
const fresh = { at: "2026-09-29T05:00:00Z", validUntil: "2026-09-29T07:00:00Z", workerDefault: "opus" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function launch(raw: string | undefined, options: { model?: string; pin?: string; role?: "worker" | "desk"; roster?: string } = {}) {
  vi.stubEnv("MUSTER_FLEET_COMPUTE", "off");
  vi.stubEnv("MUSTER_PROJECT", "");
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  const roster = join(h.home, "roster.json");
  writeFileSync(roster, JSON.stringify({ version: 1, roles: { worker: { model: options.roster ?? "sol" } } }));
  vi.stubEnv("MUSTER_ROSTER", roster);
  const path = join(h.home, ".local/state/muster/fleet-steer.json");
  mkdirSync(dirname(path), { recursive: true });
  if (raw !== undefined) writeFileSync(path, raw);
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "steer launches", reviewTrigger: "weekly", nextAction: "launch", criticalPath: [], space: "w1", ephemeral: true, cadenceMinutes: 15, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "🧪 probe", goal: "test steer" }));
  if (options.pin) await runWith(h, projectUpdate(dir, { policy: { roles: { worker: { model: options.pin } } } }));
  return runWith(h, agentLaunchForeground(dir, { action: "launch", name: "worker", role: options.role ?? "worker", lane: "probe", label: "🔨 worker", cwd: dir, ...(options.model ? { model: options.model } : {}) }));
}

describe("fleet steer launch integration", () => {
  it.each([["opus", opus, "sol"], ["sol", sol, "opus"]])("fresh %s overrides the roster", async (model, route, roster) => {
    const result = await launch(JSON.stringify({ ...fresh, workerDefault: model }), { roster });
    expect(result.row.profile.model).toBe(route);
    expect(result.notes.join("\n")).toContain(`worker model: ${route} from fleet steer at ${fresh.at}`);
  });
  it.each([
    { ...fresh, validUntil: "2026-09-29T06:00:00Z" },
    { ...fresh, at: "2026-09-29T03:00:00Z" },
  ])("stale steer falls back with a receipt: %j", async steer => {
    const result = await launch(JSON.stringify(steer));
    expect(result.row.profile.model).toBe(sol);
    expect(result.notes.join("\n")).toContain("fleet steer stale");
  });
  it("explicit model beats fresh steer", async () => {
    const result = await launch(JSON.stringify(fresh), { model: "sol" });
    expect(result.row.profile.model).toBe(sol);
    expect(result.notes).toContain(`worker model: ${sol} from explicit model`);
  });
  it("project pin beats fresh steer", async () => {
    const result = await launch(JSON.stringify(fresh), { pin: "sol" });
    expect(result.row.profile.model).toBe(sol);
    expect(result.notes).toContain(`worker model: ${sol} from project policy`);
  });
  it("desk ignores fresh steer", async () => {
    // Positive control: prove the same steer affects workers, not just that both desks match.
    const control = await launch(JSON.stringify({ ...fresh, workerDefault: "sol" }), { roster: "opus" });
    expect(control.row.profile.model).toBe(sol);
    const steered = await launch(JSON.stringify({ ...fresh, workerDefault: "sol" }), { role: "desk" });
    const unsteered = await launch(undefined, { role: "desk" });
    expect(steered.row.profile.model).toBe(unsteered.row.profile.model);
    expect(steered.notes.some(note => note.includes("fleet steer"))).toBe(false);
  });
  it("missing file falls back with a receipt", async () => {
    const result = await launch(undefined);
    expect(result.row.profile.model).toBe(sol);
    expect(result.notes).toContain("fleet steer missing; roster default");
  });
  it("garbage JSON falls back without throwing", async () => {
    const result = await launch("{garbage");
    expect(result.row.profile.model).toBe(sol);
    expect(result.notes).toContain("fleet steer undecodable; roster default");
  });
});

describe("fleet steer contract", () => {
  it("decodes the writer contract, ignoring extra fields", async () => {
    const { decodeFleetSteer, steerChoice } = await import("./domain.ts");
    expect(decodeFleetSteer({ ...fresh, extra: true, claude: { pace: 1 }, codex: { pace: 0.5 }, source: "test" })).not.toHaveProperty("extra");
    expect(steerChoice(decodeFleetSteer(fresh), Date.parse("2026-09-29T06:00:00Z")).model).toBe("opus");
    expect(() => decodeFleetSteer({ ...fresh, workerDefault: "bogus" })).toThrow();
    expect(() => decodeFleetSteer({ ...fresh, at: "invalid" })).toThrow();
  });
  it("does not read steer for restore, fork or non-worker roles", async () => {
    const { launchDefaults } = await import("./fleet-steer.ts");
    for (const action of ["restore", "fork"]) {
      const result = await Effect.runPromise(launchDefaults({ home: "/missing", now: 0, action, role: "worker", model: "sol" }));
      expect(result.defaults.model).toBe(sol);
      expect(result.notes).toEqual([]);
    }
    for (const role of ["desk", "hawk", "boss", "judge"] as const) {
      expect((await Effect.runPromise(launchDefaults({ home: "/missing", now: 0, action: "launch", role }))).notes).toEqual([]);
    }
  });
});
