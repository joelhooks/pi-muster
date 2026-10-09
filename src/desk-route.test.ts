import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { catalogCommsSender, createComms, NetworkComms } from "./comms.ts";
import { consumeNetworkMailbox, networkConfigPath, networkIdentityPath, networkDeskIdentityPath, networkPeersPath, networkDeskPeersPath, networkCursorPath, networkProvisionName, networkRecipient, provisionNetworkAgent, seedNetworkIdentities, seedNetworkPeers, readNetworkIdentities, readNetworkPeers } from "./comms-network.ts";
import { AgentName, CommsIdentityReference, SessionId, decodeDeskRouteReceipt, decodeNetworkPeerReferences, decodeNetworkCursors } from "./domain.ts";
import { networkCatalogPeer, networkCatalogPeers, networkPeerEnvironment, resolveDeskRoute, sendDesk } from "./desk-route.ts";
import { laneOpen, projectOpen } from "./ops.ts";
import { deliverOwnerItem, readOwnerQueue } from "./owner-queue.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { registryPath } from "./registry.ts";
import { load, mutate } from "./store.ts";
import { harness, runWith } from "./test-support.ts";

const config = { endpoint: "https://mailbox.example.invalid", serviceDid: "did:web:mailbox.example.invalid", provisionWrapper: "/private/wrapper", didTemplate: "did:web:{agent}.example.invalid" };
const reference = (agent: string) => {
  const did = config.didTemplate.replace("{agent}", agent);
  return { did, secret: `entry_${agent}`, document: { id: did, verificationMethod: [], authentication: [], keyAgreement: [] } };
};
function privateFile(path: string, data: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data), { mode: 0o600 }); }
async function fixture() {
  const h = harness();
  const dir = join(h.home, "alpha"); mkdirSync(dir, { recursive: true });
  await runWith(h, projectOpen({ dir, slug: "alpha", outcome: "route", reviewTrigger: "review", nextAction: "send", ephemeral: true, createSpace: true }));
  const row = { name: "desk", role: "desk" as const, lane: "desk", machine: "local", cwd: dir, clone: null, side: null, sessionId: "alpha-session", pane: null, state: "running" as const, profile: { label: "desk", model: "sol", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: null }, sessionFile: null, parentSessionFile: null, owner: "owner", brief: null, delivery: "proven" as const, restarts: 0, restore: null, createdAt: h.now.toISOString(), updatedAt: h.now.toISOString() };
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: [row] }, undefined] as const)));
  const peer = join(h.home, "beta"); mkdirSync(peer, { recursive: true });
  await runWith(h, projectOpen({ dir: peer, slug: "beta", outcome: "route", reviewTrigger: "review", nextAction: "receive", ephemeral: true, createSpace: true }));
  await runWith(h, mutate(peer, p => Effect.succeed([{ ...p, agents: [{ ...row, cwd: peer, sessionId: "beta-session" }] }, undefined] as const)));
  privateFile(networkConfigPath(h.home), config);
  mkdirSync(dirname(registryPath(h.home)), { recursive: true });
  writeFileSync(registryPath(h.home), `${JSON.stringify({ slug: "beta", dir: peer })}\n`);
  return { h, dir, peer };
}

describe("qualified desk routing", () => {
  it("keeps new provisioning writes readable by the exact legacy identity schema", async () => {
    const { h } = await fixture();
    const run = async (_file: string, args: readonly string[]) => JSON.stringify(reference(args[2]!));
    await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent: "worker", run }));
    await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent: "alpha/desk", run }));
    const legacy = Schema.decodeUnknownSync(Schema.Record(AgentName, CommsIdentityReference));
    const raw = JSON.parse(readFileSync(networkIdentityPath(h.home), "utf8"));
    expect(legacy(raw)).toEqual(raw); // Record decoding can discard non-matching keys; lossless decode proves isolation.
    expect(Object.keys(raw)).toEqual(["worker"]);
  });
  it("isolates identity, peer and cursor writes while exact legacy schemas decode every shared file losslessly", async () => {
    const { h, dir } = await fixture();
    const run = async (_file: string, args: readonly string[]) => JSON.stringify(reference(args[2]!));
    await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent: "worker", run }));
    const before = readFileSync(networkIdentityPath(h.home), "utf8");
    await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent: "alpha/desk", run }));
    seedNetworkIdentities(h.home, { "beta/desk": reference(networkProvisionName("beta/desk")) });
    expect(readFileSync(networkIdentityPath(h.home), "utf8")).toBe(before);
    const merged = readNetworkIdentities(h.home);
    expect(Object.keys(merged).sort()).toEqual(["alpha/desk", "beta/desk", "worker"]);
    seedNetworkPeers(h.home, { "worker-session": "worker", "alpha-session": "alpha/desk" });
    const peerBefore = readFileSync(networkPeersPath(h.home), "utf8");
    seedNetworkPeers(h.home, { "beta-session": "beta/desk" });
    expect(readFileSync(networkPeersPath(h.home), "utf8")).toBe(peerBefore);
    expect(readNetworkPeers(h.home)).toEqual({ "worker-session": "worker", "alpha-session": "alpha/desk", "beta-session": "beta/desk" });
    const { Main } = await import("./vendor/rat-king-lexicon/runtime.lease.ts");
    for (const agent of ["worker", "alpha/desk"]) {
      const lease = Schema.decodeUnknownSync(Main)({ did: merged[agent]!.did, leaseId: "3jzfcijpj2z2b", generation: 1, expiresAt: "2026-10-07T00:00:00Z", harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: `${networkProvisionName(agent)}-session` } });
      await Effect.runPromise(consumeNetworkMailbox({ home: h.home, agent, session: `${networkProvisionName(agent)}-session`,
        mailbox: { lease: { acquire: () => Effect.succeed(lease), renew: () => Effect.succeed(lease), resolve: () => Effect.succeed(lease), release: () => Effect.void },
          watch: () => Stream.succeed({ events: [], throughSeq: 7 }), open: () => Effect.die("no messages"), deliver: () => Effect.die("no messages"), ack: () => Effect.die("no messages") },
        senderAgent: () => Effect.die("no messages"), receive: () => Effect.die("no messages"),
      }));
    }
    const oldIdentities = Schema.decodeUnknownSync(Schema.Record(AgentName, CommsIdentityReference));
    const oldPeers = Schema.decodeUnknownSync(Schema.Record(SessionId, AgentName));
    const oldCursors = Schema.decodeUnknownSync(Schema.Record(AgentName, Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))));
    const identityRaw = JSON.parse(readFileSync(networkIdentityPath(h.home), "utf8"));
    const peersRaw = JSON.parse(readFileSync(networkPeersPath(h.home), "utf8"));
    expect(oldIdentities(identityRaw)).toEqual(identityRaw); expect(Object.keys(identityRaw)).toEqual(["worker"]);
    expect(oldPeers(peersRaw)).toEqual(peersRaw);
    const cursorDir = dirname(networkCursorPath(h.home, "worker"));
    expect(readdirSync(cursorDir)).toEqual(["worker.json"]);
    for (const name of readdirSync(cursorDir)) {
      const raw = JSON.parse(readFileSync(join(cursorDir, name), "utf8"));
      expect(oldCursors(raw)).toEqual(raw); expect(decodeNetworkCursors(raw)).toEqual({ worker: 7 });
    }
    for (const path of [networkDeskIdentityPath(h.home), networkDeskPeersPath(h.home), networkCursorPath(h.home, "alpha/desk")]) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(networkCursorPath(h.home, "alpha/desk"), "utf8"))).toEqual({ "alpha/desk": 7 });
    const project = await runWith(h, load(dir));
    const env = networkPeerEnvironment(project, [...project.agents, { ...project.agents[0]!, name: "worker", role: "worker", sessionId: "worker-session" }]);
    const oldEnv = JSON.parse(env.MUSTER_NETWORK_PEERS);
    expect(oldPeers(oldEnv)).toEqual(oldEnv); expect(oldEnv).toEqual({ "alpha-session": "desk", "worker-session": "worker" });
    expect(JSON.parse(env.MUSTER_NETWORK_DESK_PEERS)).toEqual({ "alpha-session": "alpha/desk" });
  });
  it("reports and records intercom fallback for a failed network owner notification", async () => {
    const { h } = await fixture();
    const relay = vi.fn(() => Effect.succeed({ status: "delivered" as const }));
    const result = await Effect.runPromise(deliverOwnerItem({ owner: "owner-session", home: h.home, session: "worker-session", project: "alpha",
      item: { author: "worker-session", kind: "action", title: "Packet ready", refs: ["report"] },
      comms: { ...NetworkComms, mode: () => Effect.succeed("network" as const), postOwner: () => Effect.succeed({ status: "failed" as const, detail: "NetworkComms send failed: LeaseMismatch" }), relay },
      send: () => Effect.die("must use explicit intercom relay, not network again"),
    }));
    expect(result.delivery.status).toBe("delivered"); expect(result.delivery.detail).toContain("intercom fallback");
    expect(result.delivery.detail).toContain("LeaseMismatch"); expect(result.delivery.detail).toContain("receipt:");
    expect(relay).toHaveBeenCalledOnce(); expect(readOwnerQueue("owner-session", h.home).items).toHaveLength(1);
  });
  it("routes aliases through the call-time network adapter and defaults a desk with no comms policy to network", async () => {
    const { h, dir } = await fixture();
    let adapter: Parameters<typeof import("./comms-network.ts").createNetworkComms>[0] | undefined;
    vi.doMock("./comms-network.ts", () => ({
      readNetworkConfig: () => config, seedNetworkPeers, readNetworkPeers,
      provisionNetworkAgent: () => Effect.succeed(reference("desk")),
      createNetworkComms: (options: NonNullable<typeof adapter>) => { adapter = options; return { ...NetworkComms, mode: () => Effect.succeed("network" as const) }; },
    }));
    const options = { home: h.home, projectDir: dir, events: { emit() {}, on() {} }, createId: () => "id", adapterEnv: () => undefined, networkSender: () => ({ agent: "desk", session: "alpha-session" }) };
    try {
      // The real extension uses catalogCommsSender; legacy injected bare context is qualified too.
      const service = createComms({ ...options, networkSender: () => catalogCommsSender(dir, "alpha-session") });
      expect(await Effect.runPromise(service.mode!())).toBe("network");
      expect(adapter?.sender()).toEqual({ agent: "alpha/desk", session: "alpha-session" });
      expect(await Effect.runPromise(adapter!.recipient("beta/desk"))).toBe("beta/desk");
      expect(await Effect.runPromise(adapter!.recipient("beta-session"))).toBe("beta/desk");
      expect(await Effect.runPromise(adapter!.session!("beta/desk"))).toBe("beta-session");
      await expect(Effect.runPromise(adapter!.recipient("foreign/desk"))).rejects.toThrow();
      expect(await Effect.runPromise(createComms({ ...options, adapterEnv: () => "intercom" }).mode!())).toBe("intercom");
      service.dispose();
      const remote = createComms({ ...options, projectDir: join(h.home, "no-local-catalog"), adapterEnv: () => "network",
        networkSender: () => ({ agent: "worker", session: "worker-session" }),
        networkPeers: () => decodeNetworkPeerReferences({ "worker-session": "worker", "alpha-session": "alpha/desk" }),
      });
      await Effect.runPromise(remote.mode!());
      expect(adapter?.sender()).toEqual({ agent: "worker", session: "worker-session" });
      expect(await Effect.runPromise(adapter!.recipient("worker-session"))).toBe("worker");
      expect(await Effect.runPromise(adapter!.recipient("alpha-session"))).toBe("alpha/desk");
      remote.dispose();
      const fromFiles = createComms({ ...options, projectDir: join(h.home, "no-local-catalog"), adapterEnv: () => "network", networkSender: () => ({ agent: "worker", session: "worker-session" }) });
      await Effect.runPromise(fromFiles.mode!());
      expect(await Effect.runPromise(adapter!.recipient("worker-session"))).toBe("worker");
      expect(await Effect.runPromise(adapter!.recipient("alpha-session"))).toBe("alpha/desk");
      fromFiles.dispose();
    } finally { vi.doUnmock("./comms-network.ts"); }
  });
  it("uses only an exact provision-name DID override and ignores unrelated keys", async () => {
    const { h } = await fixture();
    const did = "did:web:switchboard.fleet.example.invalid";
    privateFile(networkConfigPath(h.home), { ...config, didOverrides: { switchboard: did, "unknown/key": "did:web:unused.example.invalid" } });
    const run = vi.fn(async (_file: string, args: readonly string[]) => {
      const ref = reference(args[2]!); return JSON.stringify({ ...ref, did: args[4], document: { ...ref.document, id: args[4] } });
    });
    const result = await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent: "switchboard/desk", run }));
    expect(result.did).toBe(did);
    expect(run).toHaveBeenCalledWith(config.provisionWrapper, ["provision", "--agent", "switchboard", "--did", did]);
    expect((await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent: "worker", run }))).did).toBe(reference("worker").did);
    expect((await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent: "switchboard-worker", run }))).did).toBe(reference("switchboard-worker").did);
  });
  it("provisions distinct desk identities without migrating bare names; Switchboard stays stable", async () => {
    const { h } = await fixture();
    const run = vi.fn(async (_file: string, args: readonly string[]) => JSON.stringify(reference(args[2]!)));
    for (const agent of ["alpha/desk", "beta/desk", "desk", "switchboard/switchboard"]) {
      await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent, run }));
      await Effect.runPromise(provisionNetworkAgent({ home: h.home, agent, run }));
    }
    expect(run).toHaveBeenCalledTimes(4);
    expect(networkRecipient(h.home, "alpha/desk").did).not.toBe(networkRecipient(h.home, "beta/desk").did);
    expect(networkRecipient(h.home, "desk").did).toBe(reference("desk").did);
    expect(networkProvisionName("switchboard/switchboard")).toBe("switchboard");
    expect(() => networkRecipient(h.home, "unknown/desk")).toThrow("unknown recipient");
  });
  it("lets a live row win over a dead duplicate and fails only the ambiguous session", async () => {
    const { h, dir, peer } = await fixture();
    // A renamed desk leaves its old row interrupted with the same session id (seen on pennywise and computer-use).
    await runWith(h, mutate(peer, p => Effect.succeed([{ ...p, agents: [...p.agents, { ...p.agents[0]!, name: "old-desk", state: "interrupted" as const }] }, undefined] as const)));
    expect(networkCatalogPeers(h.home, dir)).toEqual({ "alpha-session": "alpha/desk", "beta-session": "beta/desk" });
    // Two live rows that disagree make only that session ambiguous; other sessions still resolve.
    await runWith(h, mutate(peer, p => Effect.succeed([{ ...p, agents: p.agents.map(r => ({ ...r, state: "running" as const })) }, undefined] as const)));
    expect(() => networkCatalogPeer(h.home, dir, "beta-session")).toThrow("ambiguous peer session beta-session");
    expect(networkCatalogPeer(h.home, dir, "alpha-session")).toBe("alpha/desk");
  });
  it("resolves registered aliases and peers at call time, refuses foreign aliases and non-desks", async () => {
    const { h, dir, peer } = await fixture();
    expect(resolveDeskRoute(h.home, dir, "beta/desk").identity).toBe("beta/desk");
    expect(catalogCommsSender(dir, "alpha-session")).toEqual({ agent: "alpha/desk", session: "alpha-session" });
    expect(networkCatalogPeers(h.home, dir)).toEqual({ "alpha-session": "alpha/desk", "beta-session": "beta/desk" });
    expect(() => resolveDeskRoute(h.home, dir, "foreign/desk")).toThrow();
    expect(() => resolveDeskRoute(h.home, dir, "beta/missing")).toThrow();
    expect(() => resolveDeskRoute(h.home, dir, "beta-session")).toThrow();
    await runWith(h, mutate(peer, p => Effect.succeed([{ ...p, agents: p.agents.map(r => ({ ...r, role: "worker" as const })) }, undefined] as const)));
    expect(() => resolveDeskRoute(h.home, dir, "beta/desk")).toThrow("desk or role");
    await runWith(h, laneOpen(peer, { slug: "desk", label: "Desk role", goal: "role", kind: "role" }));
    expect(() => resolveDeskRoute(h.home, dir, "beta/desk")).toThrow("desk or role"); // Role lanes do not grant workers desk authority.
    await runWith(h, mutate(peer, p => Effect.succeed([{ ...p, agents: p.agents.map(r => ({ ...r, role: "judge" as const })) }, undefined] as const)));
    expect(resolveDeskRoute(h.home, dir, "beta/desk").row.role).toBe("judge");
    writeFileSync(registryPath(h.home), `${JSON.stringify({ slug: "foreign", dir: peer })}\n`);
    expect(() => resolveDeskRoute(h.home, dir, "foreign/desk")).toThrow("foreign");
  });
  it("records every fallback, without sending unknown aliases or retrying an accepted message", async () => {
    const { h, dir } = await fixture(); const relay = vi.fn(() => Effect.succeed({ status: "delivered" as const, id: "muster-outbox-fixture" }));
    // A provisioned desk: one with no identity is provisioned first and never falls back to intercom.
    seedNetworkIdentities(h.home, { "beta/desk": reference(networkProvisionName("beta/desk")) });
    const send = vi.fn(() => Effect.succeed({ status: "failed" as const, detail: "network unavailable" }));
    const opts = { home: h.home, dir, to: "beta/desk", text: "One concrete ask.", sender: "alpha-session", id: "receipt-1", at: "2026-10-06T20:00:00Z", comms: { ...NetworkComms, send, relay } };
    const result = await runWith(h, sendDesk(opts));
    expect(result.path).toBe("intercom-fallback"); expect(result.network.detail).toBe("network unavailable");
    expect(decodeDeskRouteReceipt(JSON.parse(readFileSync(result.receipt, "utf8").trim()))).toMatchObject({ id: "receipt-1", fallback: { status: "delivered", id: "muster-outbox-fixture" } });
    await expect(runWith(h, sendDesk({ ...opts, to: "foreign/desk" }))).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce(); expect(relay).toHaveBeenCalledOnce();
    const accepted = await runWith(h, sendDesk({ ...opts, id: "receipt-2", comms: { ...opts.comms, send: () => Effect.succeed({ status: "accepted" as const }) } }));
    expect(accepted.path).toBe("network"); expect(relay).toHaveBeenCalledOnce();
  });
  it("provisions an unregistered desk before any send; a failed mint sends nothing and never falls back to intercom", async () => {
    // 2026-10-07: 24 of 25 fallbacks were sends to an unregistered DID.
    const { h, dir } = await fixture(); const relay = vi.fn(() => Effect.succeed({ status: "delivered" as const }));
    const send = vi.fn(() => Effect.succeed({ status: "accepted" as const }));
    const result = await runWith(h, sendDesk({ home: h.home, dir, to: "beta/desk", text: "ask", sender: "alpha-session", id: "receipt-3", at: "2026-10-09T00:00:00Z", comms: { ...NetworkComms, send, relay } }));
    expect(result.path).toBe("network"); expect(result.delivery.status).toBe("failed");
    expect(result.delivery.detail).toContain("provisioning did not finish"); expect(result.delivery.detail).toContain("no intercom fallback");
    expect(send).not.toHaveBeenCalled(); expect(relay).not.toHaveBeenCalled();
  });
  it.each(["alpha/desk", "worker"])("receives %s through the real consumer callback, including legacy bare worker authentication", async senderKey => {
    const { h } = await fixture();
    const alpha = reference(networkProvisionName(senderKey)); const beta = reference(networkProvisionName("beta/desk"));
    seedNetworkIdentities(h.home, { [senderKey]: alpha, "beta/desk": beta });
    const { Output } = await import("./vendor/rat-king-lexicon/mailbox.list.ts");
    const { Main } = await import("./vendor/rat-king-lexicon/runtime.lease.ts");
    const raw = JSON.parse(readFileSync(new URL("./vendor/rat-king-fixtures/list.output.json", import.meta.url), "utf8").replaceAll("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", alpha.did));
    const events = Schema.decodeUnknownSync(Output)(raw).events;
    const defs = await import("./vendor/rat-king-lexicon/defs.ts");
    const receipt = Schema.decodeUnknownSync(Schema.toType(defs.Receipt))(events[0]!.receipt);
    const lease = Schema.decodeUnknownSync(Main)({ did: beta.did, leaseId: "3jzfcijpj2z2b", generation: 1, expiresAt: "2026-10-07T00:00:00Z", harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: "beta-session" } });
    const senderDid = Schema.decodeUnknownSync(Main.schema.fields.did)(alpha.did);
    const tid = Schema.decodeUnknownSync(Main.schema.fields.leaseId)("3jzfcijpj2z2a");
    const order: string[] = []; const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage() {}, sendUserMessage: vi.fn(() => { order.push("receive"); }) };
    const mailbox = {
      lease: { acquire: () => Effect.succeed(lease), renew: () => Effect.succeed(lease), resolve: () => Effect.succeed(lease), release: () => Effect.void },
      watch: () => Stream.succeed({ events, throughSeq: 2 }),
      open: () => Effect.succeed({ body: JSON.stringify({ type: "message", recipient: "beta-session", author: "alpha-session", body: "Desk to desk." }), senderDid, tid, verified: true as const }),
      deliver: () => Effect.sync(() => { order.push("deliver"); return { receipt }; }),
      ack: () => Effect.sync(() => { order.push("ack"); return { receipt }; }),
    };
    let finished: Promise<void> | undefined;
    registerOwnerFeed(pi as never, { HOME: h.home, MUSTER_ROLE: "desk" }, { consume: (_ctx, _signal, receive) => {
      finished = Effect.runPromise(consumeNetworkMailbox({ home: h.home, agent: "beta/desk", session: "beta-session", mailbox, senderAgent: () => Effect.succeed(senderKey), receive })); return finished;
    } });
    try {
      handlers.get("session_start")!({}, { isIdle: () => false, sessionManager: { getSessionId: () => "beta-session", getBranch: () => [] } });
      await vi.waitFor(() => expect(finished).toBeDefined()); await finished;
      expect(order).toEqual(["receive", "deliver", "ack"]);
      expect(pi.sendUserMessage).toHaveBeenCalledWith("Desk to desk.\n\n[Authenticated agent message from alpha-session, not Joel.]", { deliverAs: "followUp" });
      privateFile(networkCursorPath(h.home, "beta/desk"), { "beta/desk": 0 });
      const refused: string[] = [];
      await Effect.runPromise(consumeNetworkMailbox({ home: h.home, agent: "beta/desk", session: "beta-session", mailbox, senderAgent: () => Effect.succeed("beta/desk"), receive: payload => Effect.sync(() => { if (payload.type !== "message" || payload.author !== "NetworkComms (local)") throw new Error("must not deliver"); refused.push(payload.body); }) }));
      expect(refused).toHaveLength(1); expect(refused[0]).toContain("authenticated sender differs");
    } finally { handlers.get("session_shutdown")!(); }
  });
});
