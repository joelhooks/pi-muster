import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { commsDoctor, doctorReport, ratkingStateProbe, ratkingStatus } from "./comms-doctor.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";
import { projectOpen } from "./ops.ts";
import { mutate } from "./store.ts";
import * as remote from "./remote.ts";

const json = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); };
describe("pi-ratking doctor", () => {
  it("reports canonical claims, directory DID and cursor from custom configured state, never legacy fences", () => {
    const h = harness(); const state = join(h.home, "rk-state"); const config = join(h.home, "pi.json");
    json(config, { state }); json(join(state, "claims.json"), { "pilot/worker": { pid: process.pid, session: "worker-session" } });
    json(join(state, "directory.json"), { "pilot/worker": { did: "did:web:worker.example.invalid" } });
    json(join(state, "cursors/pilot.worker.json"), { afterSeq: 17 });
    const probe = ratkingStateProbe(h.home, "pilot/worker", config);
    expect(doctorReport("pilot/worker", "worker-session", "local", probe)).toMatchObject({ mismatch: false, did: "did:web:worker.example.invalid", claim: { afterSeq: 17, alive: true } });
  });
  it.each(["wrong-session", "dead-pid", "missing"])("flags %s and recommends restart without minting or pushing", mode => {
    const h = harness(); const state = join(h.home, ".local/state/rat-king/pi");
    if (mode !== "missing") json(join(state, "claims.json"), { "pilot/worker": { pid: mode === "dead-pid" ? 2147483647 : process.pid, session: mode === "wrong-session" ? "someone-else" : "worker-session" } });
    const report = doctorReport("pilot/worker", "worker-session", "local", ratkingStateProbe(h.home, "pilot/worker"));
    expect(report.mismatch).toBe(true); expect(report.verdict).toContain("restart");
    expect(report).not.toHaveProperty("fixes");
  });
  it("calls an env-given name with a cursor but no claim unknown, not mismatch", () => {
    const h = harness(); const state = join(h.home, ".local/state/rat-king/pi");
    json(join(state, "cursors/pilot.worker.json"), { afterSeq: 4 });
    const report = doctorReport("pilot/worker", "worker-session", "local", ratkingStateProbe(h.home, "pilot/worker"));
    expect(report).toMatchObject({ mismatch: false, claim: { session: null, afterSeq: 4 } });
    expect(report.verdict).toMatch(/^unknown:/);
  });
  it("takes in-process status when available and flags an expected-versus-claimed name mismatch", async () => {
    const events = createEventBus(); const h = harness();
    events.on("ratking/status", value => events.emit("ratking/status:result", { ...(value as object), name: "wrong-name", did: "did:web:wrong.example.invalid", reader: "running", lease: { expiresAt: "later" } }));
    const live = await Effect.runPromise(ratkingStatus(events, "request"));
    const probe = { name: "pilot/worker", did: null, session: "worker-session", pid: process.pid, alive: true, afterSeq: 0 };
    expect(doctorReport("pilot/worker", "worker-session", "local", probe, live)).toMatchObject({ mismatch: true, claimed: "wrong-name", reader: "running", lease: { expiresAt: "later" } });
  });
  it("bounds an older pi-ratking with no status event and unregisters its listener", async () => {
    const events = createEventBus();
    expect(await Effect.runPromise(ratkingStatus(events, "old-extension", 5))).toBeUndefined();
  });
  it("reads a remote row's pi-ratking state on its own machine", async () => {
    const h = harness(); const dir = makeRepo(join(h.root, "repo"));
    await runWith(h, projectOpen({ dir, slug: "pilot", outcome: "doctor", nextAction: "test", reviewTrigger: "weekly", ephemeral: true, sidebar: false }));
    const { AgentRow, Schema } = await import("./domain.ts").then(async domain => ({ AgentRow: domain.AgentRow, Schema: (await import("effect")).Schema }));
    const row = Schema.decodeUnknownSync(AgentRow)({ name: "worker", role: "worker", lane: "work", state: "running", owner: h.sessionId, sessionId: "remote-session", machine: "remote", cwd: "/remote/repo", branch: null, clone: null, brief: null, createdAt: h.now.toISOString(), sessionFile: null, parentSessionFile: null, pane: null, restarts: 0, nudgedAt: null, lastActivityAt: null, restore: null, profile: { model: "sol", thinking: "medium", label: "worker", noSkills: true, appendSystemPrompt: [], skills: [], extensions: [], env: {}, compactAt: null }, delivery: "none", updatedAt: h.now.toISOString() });
    await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: [row] }, undefined] as const)));
    const machine = vi.spyOn(remote, "machineConfig").mockReturnValue(Effect.succeed({ ssh: "remote", socket: "/sock", musterExtension: "/remote/muster", workerWorktree: "/helper", paths: {}, env: {}, wrap: [], maxPanes: 10, providers: {} } as never));
    const node = vi.spyOn(remote, "remoteNode").mockReturnValue(Effect.succeed(JSON.stringify({ name: "pilot/worker", did: "did:web:remote.example.invalid", session: "remote-session", pid: 42, alive: true, afterSeq: 3 })));
    try {
      const report = await runWith(h, commsDoctor({ home: h.home, dir, session: h.sessionId, row: "worker", env: {}, events: createEventBus() }));
      expect(report).toMatchObject({ machine: "remote", mismatch: false, did: "did:web:remote.example.invalid" });
      expect(node).toHaveBeenCalledWith("remote", expect.anything(), expect.stringContaining("ratkingStateProbe"), ["/remote/muster/src/comms-probe.ts", "pilot/worker", ""]);
    } finally { machine.mockRestore(); node.mockRestore(); }
  });
});
