import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { NetworkComms } from "./comms.ts";
import { networkConfigPath, networkIdentityPath, readNetworkIdentities } from "./comms-network.ts";
import { networkReceiptPath } from "./comms-fallback.ts";
import { decodeMachines, type AgentRow } from "./domain.ts";
import { projectOpen, projectUpdate } from "./ops.ts";
import { deliverOwnerItem } from "./owner-queue.ts";
import { MusterEnv, Proc, liveProc, noEmitPaneClose, type CommsDelivery } from "./runtime.ts";
import { load, mutate } from "./store.ts";
import { FakeHerdr, harness, runWith, type Harness } from "./test-support.ts";

const reference = (agent: string) => {
  const did = `did:web:${agent}.example.invalid`;
  return { did, secret: `entry_${agent}`, document: { id: did, verificationMethod: [], authentication: [], keyAgreement: [] } };
};
const privateFile = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data), { mode: 0o600 }); };
const script = (path: string, body: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path; };

/** A worker row bound to a Muster-opened pane, launched before the project went network. */
async function fixture(options: { machine?: string; comms?: "intercom" | "network"; provision?: "ok" | "fail" } = {}) {
  const h = harness();
  const dir = join(h.home, "alpha"); mkdirSync(dir, { recursive: true });
  await runWith(h, projectOpen({ dir, slug: "alpha", outcome: "route", reviewTrigger: "review", nextAction: "send", ephemeral: true, createSpace: true }));
  const remote = new FakeHerdr(h.home);
  const herdr = options.machine ? remote : h.herdr;
  const pane = herdr.addPane("w1", "t1", dir);
  pane.agent = "pi"; pane.name = "worker"; pane.agent_status = "idle";
  const row: AgentRow = { name: "worker", role: "worker", lane: "alpha", machine: options.machine ?? "local", cwd: dir, clone: null, side: null, sessionId: "worker-session",
    pane: { paneId: pane.pane_id, terminalId: pane.terminal_id, tabId: "t1", openedByMuster: true }, state: "running",
    profile: { label: "worker", model: "sol", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: null },
    sessionFile: null, parentSessionFile: null, owner: "owner-session", brief: null, delivery: "proven", restarts: 0,
    restore: { cwd: dir, argv: ["pi"], env: { MUSTER_AGENT: "worker", ...(options.comms ? { MUSTER_COMMS: options.comms } : {}) } },
    createdAt: h.now.toISOString(), updatedAt: h.now.toISOString() };
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, policy: { ...p.policy, comms: "network" as const }, agents: [row] }, undefined] as const)));
  const provisionWrapper = script(join(h.root, "bin/provision"), options.provision === "fail" ? "exit 1"
    : `printf '{"did":"%s","secret":"entry_%s","document":{"id":"%s","verificationMethod":[],"authentication":[],"keyAgreement":[]}}' "$5" "$3" "$5"`);
  const secretsCommand = script(join(h.root, "bin/secrets"), `printf '{"did":"leased"}'`);
  privateFile(networkConfigPath(h.home), { endpoint: "https://mailbox.example.invalid", serviceDid: "did:web:mailbox.example.invalid", provisionWrapper, didTemplate: "did:web:{agent}.example.invalid", secretsCommand });
  const relay = vi.fn((_to: unknown, _message: string) => Effect.succeed<CommsDelivery>({ status: "failed", detail: "target_not_found" }));
  // Effects are lazy: count runs, not constructions.
  const networkSends = vi.fn();
  const postOwner = () => Effect.sync((): CommsDelivery => { networkSends(); return { status: "failed", detail: "NetworkComms unknown recipient: worker; provision it first" }; });
  const comms = { ...NetworkComms, mode: () => Effect.succeed("network" as const), postOwner, relay };
  const ssh: string[] = [];
  const machines = decodeMachines({ pennywise: { herdr: "pennywise", ssh: "pennywise", paths: {}, musterExtension: "/muster", workerWorktree: h.workerWorktree, env: {}, wrap: [], comms: { config: "/remote/network.json" } } });
  const run = <A, E>(effect: Effect.Effect<A, E, MusterEnv | Proc>) => runWith(h, effect.pipe(
    Effect.provideService(MusterEnv, { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: h.workerWorktree, createId: () => "id", sleep: () => Effect.void, emitPaneClose: noEmitPaneClose, machines, remoteHerdr: () => Effect.succeed(remote.client()) }),
    // SSH is faked: the key copy reports "added", the public peer seed succeeds.
    Effect.provideService(Proc, { run: (command, args, opts) => command === "ssh"
      ? Effect.sync(() => { ssh.push(args.at(-1)!); return { code: 0, stdout: args.at(-1)!.includes("muster-key") ? "added\n" : "", stderr: "" }; })
      : liveProc.run(command, args, opts) }),
  ));
  const reply = (session = "owner-session", owner = "worker-session") => run(deliverOwnerItem({ owner, home: h.home, session, project: dir,
    item: { author: session, kind: "fyi", title: "go ahead", body: "line one\nline two", mention: owner }, comms, send: () => Effect.die("network mode never uses send") }));
  const receipts = () => readFileSync(networkReceiptPath(h.home), "utf8").trim().split("\n").map(line => JSON.parse(line) as { path: string; to: string });
  return { h, dir, row, pane, local: h.herdr, remote, relay, postOwner: networkSends, reply, receipts, ssh, run };
}
const prompts = (herdr: Harness["herdr"]) => herdr.calls.filter(call => call.method === "agent.prompt");

describe("network sends to rows launched before comms: network", () => {
  it("provisions a pre-flip local row, then prompts its pane and says to restart it, instead of a bare refusal", async () => {
    const f = await fixture();
    let identityAtPrompt: unknown;
    const handle = f.local.handle.bind(f.local);
    f.local.handle = (method, params) => { if (method === "agent.prompt") identityAtPrompt = readNetworkIdentities(f.h.home).worker; return handle(method, params); };
    const result = await f.reply();
    expect(result.delivery.detail).not.toContain("provision it first");
    expect(result.delivery.detail).toContain("worker has no mailbox reader (launched before comms: network); delivered via herdr-prompt; restart the row to open its mailbox");
    expect(result.delivery.status).toBe("delivered"); expect(result.path).toBe("herdr-prompt");
    // The mint finished before any text was typed.
    expect(readNetworkIdentities(f.h.home).worker?.did).toBe("did:web:worker.example.invalid"); expect(identityAtPrompt).toBeDefined();
    expect(prompts(f.local)).toHaveLength(1);
    expect(String(prompts(f.local)[0]!.params.text)).toMatch(/go ahead ⏎ line one ⏎ line two.*not Joel\.\]$/u);
    expect(f.relay).not.toHaveBeenCalled(); expect(f.postOwner).not.toHaveBeenCalled();
    expect(f.receipts().at(-1)).toMatchObject({ path: "herdr-prompt", to: "worker-session" });
  });

  it("fails clearly and sends nothing when provisioning does not finish: no intercom, no typing", async () => {
    const f = await fixture({ provision: "fail" });
    const result = await f.reply();
    expect(result.delivery.status).toBe("failed");
    expect(result.delivery.detail).toContain("provisioning did not finish");
    expect(result.delivery.detail).toContain("nothing sent, no intercom fallback");
    expect(prompts(f.local)).toHaveLength(0); expect(f.relay).not.toHaveBeenCalled(); expect(f.postOwner).not.toHaveBeenCalled();
    expect(f.receipts().at(-1)).toMatchObject({ path: "network" });
  });

  it("serializes concurrent first sends to one row: one mint, no lost entry, both delivered", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.reply(), f.reply()]);
    expect([a.delivery.status, b.delivery.status]).toEqual(["delivered", "delivered"]);
    expect(Object.keys(JSON.parse(readFileSync(networkIdentityPath(f.h.home), "utf8")))).toEqual(["worker"]);
    expect(prompts(f.local)).toHaveLength(2);
  });

  it("provisions a pre-flip remote row with its key copy first, then prompts its bound pane through that machine's Herdr", async () => {
    const f = await fixture({ machine: "pennywise", comms: "intercom" });
    let copiedAtPrompt = false;
    const handle = f.remote.handle.bind(f.remote);
    f.remote.handle = (method, params) => { if (method === "agent.prompt") copiedAtPrompt = f.ssh.some(line => line.includes("muster-key")); return handle(method, params); };
    const result = await f.reply();
    expect(result.delivery.detail).toContain("worker has no mailbox reader (launched before comms: network); delivered via herdr-prompt");
    expect(copiedAtPrompt).toBe(true);
    expect(prompts(f.remote)).toHaveLength(1); expect(prompts(f.remote)[0]!.params.target).toBe(f.pane.pane_id);
    expect(prompts(f.local)).toHaveLength(0);
    expect(f.relay).not.toHaveBeenCalled();
    expect(f.receipts().at(-1)).toMatchObject({ path: "herdr-prompt" });
  });

  it("sends a provisioned remote row's failed network notice through Herdr, not the unreachable intercom broker", async () => {
    const f = await fixture({ machine: "pennywise", comms: "network" });
    privateFile(networkIdentityPath(f.h.home), { worker: reference("worker") });
    const result = await f.reply();
    expect(f.postOwner).toHaveBeenCalledOnce();
    expect(result.delivery.status).toBe("delivered"); expect(result.delivery.detail).toContain("herdr-prompt: delivered");
    expect(result.delivery.detail).not.toContain("no mailbox reader");
    expect(prompts(f.remote)).toHaveLength(1); expect(f.relay).not.toHaveBeenCalled(); expect(f.ssh).toEqual([]);
    expect(f.receipts().at(-1)).toMatchObject({ path: "herdr-prompt" });
  });

  it("refuses the Herdr path to a session that does not own the row", async () => {
    const f = await fixture({ machine: "pennywise", comms: "intercom" });
    const result = await f.reply("intruder-session");
    expect(result.delivery.status).toBe("failed");
    expect(result.delivery.detail).toContain("herdr-prompt refused: session intruder-session does not own worker; no text typed");
    expect(prompts(f.remote)).toHaveLength(0); expect(prompts(f.local)).toHaveLength(0); expect(f.relay).not.toHaveBeenCalled();
  });

  it("never types into a pane Muster did not open", async () => {
    const f = await fixture();
    await runWith(f.h, mutate(f.dir, p => Effect.succeed([{ ...p, agents: p.agents.map(row => ({ ...row, pane: row.pane && { ...row.pane, openedByMuster: false } })) }, undefined] as const)));
    const result = await f.reply();
    expect(result.delivery.detail).toContain("Muster did not open a pane for worker");
    expect(prompts(f.local)).toHaveLength(0);
  });

  it("still refuses an unknown recipient that is not a catalog row, with the existing message", async () => {
    const f = await fixture();
    const result = await f.reply("owner-session", "stranger-session");
    expect(result.delivery.status).toBe("failed");
    expect(result.delivery.detail).toContain("NetworkComms unknown recipient: worker; provision it first");
    expect(f.relay).toHaveBeenCalledOnce();
    expect(prompts(f.local)).toHaveLength(0); expect(readNetworkIdentities(f.h.home)).toEqual({});
  });

  it("project_update switching to network lists the live rows that need a restart", async () => {
    const f = await fixture();
    await runWith(f.h, mutate(f.dir, p => Effect.succeed([{ ...p, policy: { ...p.policy, comms: "intercom" as const }, agents: [...p.agents,
      { ...f.row, name: "fresh", sessionId: "fresh-session", restore: { cwd: f.dir, argv: ["pi"], env: { MUSTER_COMMS: "network" } } },
      { ...f.row, name: "gone", sessionId: "gone-session", state: "closed" as const }] }, undefined] as const)));
    const result = await runWith(f.h, projectUpdate(f.dir, { policy: { comms: "network" } }));
    expect(result.notes).toContain("comms: network. Restart these rows to open their mailboxes (launched before comms: network): worker.");
    const again = await runWith(f.h, projectUpdate(f.dir, { headline: "steady" }));
    expect(again.notes.join("\n")).not.toContain("Restart these rows");
    expect((await runWith(f.h, load(f.dir))).policy?.comms).toBe("network");
  });
});
