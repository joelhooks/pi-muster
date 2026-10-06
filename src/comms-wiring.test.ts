import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createComms, NetworkComms, remoteCommsEnvironment } from "./comms.ts";
import { networkConfigPath, networkIdentityPath } from "./comms-network.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { Comms } from "./runtime.ts";
import { load, mutate } from "./store.ts";
import { harness, runWith } from "./test-support.ts";

const config = { endpoint: "https://mailbox.example.invalid", serviceDid: "did:web:mailbox.example.invalid", provisionWrapper: "/private/wrapper", didTemplate: "did:web:{agent}.example.invalid" };
function reference(agent: string) {
  const did = `did:web:${agent}.example.invalid`;
  return { did, secret: `rat_king_agent_${agent}_identity`, document: { id: did, verificationMethod: ["atproto", "encryption"].map(key => ({ id: `${did}#${key}`, controller: did, publicKeyJwk: { kty: "EC", crv: "P-256", x: "public-x", y: "public-y" } })), authentication: [`${did}#atproto`], keyAgreement: [`${did}#encryption`] } };
}
function privateFile(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }

it("a network worker receives its full start brief over Comms, never argv or intercom", async () => {
  const h = harness(); const dir = join(h.home, "project"); mkdirSync(dir, { recursive: true });
  await runWith(h, projectOpen({ dir, slug: "pilot", outcome: "mailbox proof", reviewTrigger: "review", nextAction: "launch", ephemeral: true, createSpace: true }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "packet", repo: dir }));
  await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "work", label: "desk", cwd: dir, noSkills: true }));
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, policy: { ...project.policy, comms: "network" }, agents: project.agents.map(row => ({ ...row, sessionId: h.sessionId })) }, undefined] as const)));
  privateFile(networkConfigPath(h.home), config); privateFile(networkIdentityPath(h.home), { desk: reference("desk"), worker: reference("worker") });
  const messages: Array<{ to: string; body: string }> = [];
  const service = { ...NetworkComms, mode: () => Effect.succeed("network" as const), send: (to: unknown, body: string) => Effect.sync(() => {
    if (typeof to !== "string") throw new Error("expected session target");
    messages.push({ to, body });
    const pane = [...h.herdr.panes.values()].find(pane => pane.agent_session?.value.includes(to));
    if (!pane?.agent_session) throw new Error("recipient Pi not started");
    appendFileSync(pane.agent_session.value, `${JSON.stringify({ type: "message", message: { role: "user", content: body } })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: "working", stopReason: "stop" } })}\n`);
    return { status: "accepted" as const };
  }) };
  const result = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, noSkills: true, prompt: "Do the complete brief through the mailbox." }).pipe(Effect.provideService(Comms, service)));
  expect(messages).toEqual([{ to: result.row.sessionId, body: "Do the complete brief through the mailbox." }]);
  expect(result.argv.join(" ")).not.toContain("complete brief");
  expect(h.herdr.initialPrompts).toEqual([]); expect(h.sent).toEqual([]);
  expect(h.herdr.launcherScripts.at(-1)).toContain("MUSTER_COMMS='network'");
  expect(result.proof?.state).toBe("proven");
  expect((await runWith(h, load(dir))).agents.find(row => row.name === "worker")?.delivery).toBe("proven");
});

it("network aliases and remote intercom addresses bind to the real Pi session, not name@machine", async () => {
  const h = harness(); const dir = join(h.home, "project"); mkdirSync(dir, { recursive: true });
  await runWith(h, projectOpen({ dir, slug: "pilot", outcome: "alias", reviewTrigger: "review", nextAction: "launch", ephemeral: true, createSpace: true }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "alias", repo: dir }));
  await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, noSkills: true }));
  const row = (await runWith(h, load(dir))).agents[0];
  if (!row) throw new Error("worker missing");
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, policy: { ...project.policy, comms: "network" }, agents: project.agents.map(row => ({ ...row, intercomAddress: "worker@remote" })) }, undefined] as const)));
  let session: ((to: import("./runtime.ts").CommsTarget) => Effect.Effect<string, import("./runtime.ts").CommsError>) | undefined;
  vi.doMock("./comms-network.ts", () => ({ readNetworkConfig: () => config, createNetworkComms: (options: { session: typeof session }) => { session = options.session; return NetworkComms; } }));
  try {
    const service = createComms({ home: h.home, projectDir: dir, events: { emit() {}, on() {} }, createId: () => "id", adapterEnv: () => "network" });
    if (!service.mode) throw new Error("mode missing"); await Effect.runPromise(service.mode());
    if (!session) throw new Error("session mapper missing");
    for (const target of ["pilot/worker", "worker@remote", "worker", row.sessionId]) expect(await Effect.runPromise(session(target))).toBe(row.sessionId);
  } finally { vi.doUnmock("./comms-network.ts"); }
});

describe("launch guards", () => {
  it("remote env follows project policy: intercom ignores the block, network requires it and passes only its path", () => {
    expect(remoteCommsEnvironment({ policy: { comms: "intercom" } }, { comms: { config: "/private/network.json" } })).toEqual({ MUSTER_COMMS: "intercom" });
    expect(remoteCommsEnvironment({ policy: undefined }, {})).toEqual({ MUSTER_COMMS: "intercom" });
    expect(() => remoteCommsEnvironment({ policy: { comms: "network" } }, {})).toThrow("config block");
    expect(remoteCommsEnvironment({ policy: { comms: "network" } }, { comms: { config: "/private/network.json" } })).toEqual({ MUSTER_COMMS: "network", MUSTER_NETWORK_CONFIG: "/private/network.json" });
  });
  it("a network launch with no machine config refuses before opening a pane", async () => {
    const h = harness(); const dir = join(h.home, "project"); mkdirSync(dir, { recursive: true });
    await runWith(h, projectOpen({ dir, slug: "pilot", outcome: "proof", reviewTrigger: "review", nextAction: "launch", ephemeral: true, createSpace: true }));
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, policy: { ...project.policy, comms: "network" } }, undefined] as const)));
    await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "packet", repo: dir }));
    await expect(runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, noSkills: true }))).rejects.toThrow("network.json");
    expect(h.herdr.launcherScripts).toEqual([]);
  });
});
