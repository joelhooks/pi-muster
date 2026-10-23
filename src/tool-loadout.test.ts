import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen, projectUpdate } from "./ops.ts";
import { load } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { readToolLoadout, TOOL_LOADOUT_READ_SCRIPT, toolLoadoutVerdict } from "./tool-loadout.ts";

// Tin-Tin and Switchboard, #22 review: Pi's --tools drops unknown names silently; a judge that can't call
// packet_report must fail the launch, not run blind.
beforeEach(() => { vi.stubEnv("MUSTER_FLEET_COMPUTE", "off"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const system = (fields: object) => ({ type: "message", message: { role: "system", content: [], ...fields } });
const tools = (...names: string[]) => names.map(name => ({ name }));

describe("tool loadout", () => {
  it("folds system messages the way pi-ai does, locally and in the remote script", () => {
    const file = join(mkdtempSync(join(tmpdir(), "loadout-")), "s.jsonl");
    writeFileSync(file, [
      { type: "session", id: "s" }, system({ toolsAdded: tools("read", "bash", "edit") }), { type: "message", message: { role: "user", content: [] } },
      system({ toolsRemoved: tools("edit"), toolsAdded: tools("packet_report") }), system({ sections: { a: "b" } }),
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n{partial");
    expect(readToolLoadout(file)).toEqual({ declared: true, tools: ["read", "bash", "packet_report"] });
    expect(JSON.parse(execFileSync("node", ["--input-type=module", "-e", TOOL_LOADOUT_READ_SCRIPT, file], { encoding: "utf8" }))).toEqual(readToolLoadout(file));
  });

  it("fails on a missing listed tool, alarms on extras, and leaves an undeclared session unchecked", () => {
    expect(toolLoadoutVerdict(["read", "packet_report"], { declared: true, tools: ["read"] }).failure).toBe("tool loadout: packet_report not active (Pi's --tools drops unknown names silently); active: read");
    expect(toolLoadoutVerdict(["read"], { declared: true, tools: ["read", "codemode"] })).toEqual({ failure: null, note: "⚠ tool loadout: active beyond the role policy: codemode" });
    expect(toolLoadoutVerdict(["read"], { declared: true, tools: ["read"] })).toEqual({ failure: null, note: null });
    expect(toolLoadoutVerdict(["read"], { declared: false, tools: [] })).toEqual({ failure: null, note: "⚠ tool loadout unchecked: the session journal declares no tools" });
  });

  it("fails a launch whose session lacks a policy tool, marks the row failed and names the next call", async () => {
    const h = harness();
    const dir = makeRepo(join(h.root, "repo"));
    await runWith(h, projectOpen({ dir, slug: "loadout", outcome: "loadout", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
    await runWith(h, laneOpen(dir, { slug: "judge", label: "judge", goal: "test" }));
    await runWith(h, projectUpdate(dir, { policy: { roles: { judge: { tools: ["read", "bash", "packet_report"] } } } }));
    h.herdr.turnEntries = [system({ toolsAdded: tools("read", "bash") })];
    const failed = await runWith(h, agentLaunch(dir, { action: "launch", name: "judge", role: "judge", lane: "judge", label: "judge", cwd: dir, prompt: "start" }).pipe(Effect.flip));
    expect(failed).toMatchObject({ _tag: "GuardFailed", guard: "tool-loadout" });
    expect(failed.message).toContain("packet_report not active");
    expect(failed.message).toContain('agent_close "judge"');
    const row = (await runWith(h, load(dir))).agents.find(agent => agent.name === "judge")!;
    expect(row.state).toBe("failed");
    expect(row.events?.at(-1)).toMatchObject({ type: "TOOLS_MISSING" });

    h.herdr.turnEntries = [system({ toolsAdded: tools("read", "bash", "packet_report") })];
    await runWith(h, laneOpen(dir, { slug: "judge2", label: "judge2", goal: "test" }));
    const ok = await runWith(h, agentLaunch(dir, { action: "launch", name: "judge2", role: "judge", lane: "judge2", label: "judge2", cwd: dir, prompt: "start" }));
    expect(ok.row.state).toBe("running");
    expect(ok.notes.join("\n")).not.toContain("tool loadout");
  });

  // Tin-Tin, #24 review: a guard that doesn't run says so.
  it("says the check didn't run when the launch is still pending", async () => {
    const h = harness();
    h.startupLoad = { load: 0, cpus: 8 };
    h.herdr.startSessions = false;
    h.sleep = ms => { h.now = new Date(h.now.getTime() + ms); };
    const handle = h.herdr.handle.bind(h.herdr);
    vi.spyOn(h.herdr, "handle").mockImplementation((method, params) => method === "pane.read" ? { type: "pane_read", read: { text: "creating a new session…" } } : handle(method, params));
    const dir = makeRepo(join(h.root, "repo"));
    await runWith(h, projectOpen({ dir, slug: "loadout", outcome: "loadout", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
    await runWith(h, laneOpen(dir, { slug: "judge", label: "judge", goal: "test" }));
    await runWith(h, projectUpdate(dir, { policy: { roles: { judge: { tools: ["read", "packet_report"] } } } }));
    const pending = await runWith(h, agentLaunch(dir, { action: "launch", name: "judge", role: "judge", lane: "judge", label: "judge", cwd: dir, prompt: "start" }));
    expect(pending.row.state).toBe("launching");
    expect(pending.notes.join("\n")).toContain("⚠ tool loadout unchecked: launch pending");
  });
});
