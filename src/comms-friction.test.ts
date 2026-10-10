import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createComms, currentSuccessor, forkParentSession, isPredecessorSession, NetworkComms, recordSessionSuccessor } from "./comms.ts";
import { claimRefusalNotice, consumeNetworkMailbox, networkConfigPath, networkProvisionName, preflipNotice, provisionPreflipRow, REFUSAL_PREFIX, RETIRED_PREFIX, seedNetworkIdentities, seedNetworkPeers, readNetworkPeers } from "./comms-network.ts";
import { reportedNetworkSend } from "./comms-fallback.ts";
import { sendDesk } from "./desk-route.ts";
import { loudDelivery, remoteInboxPull, sessionCommsSender } from "./extension-main.ts";
import { commsKickPath, deliverOwnerItem, kickComms } from "./owner-queue.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { projectOpen } from "./ops.ts";
import { registryPath } from "./registry.ts";
import { load, mutate } from "./store.ts";
import { harness, runWith } from "./test-support.ts";
import type { NetworkPayload } from "./domain.ts";
import { CommsError } from "./runtime.ts";

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
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, agents: [row, { ...row, name: "worker", role: "worker" as const, lane: "work", sessionId: "worker-session" }] }, undefined] as const)));
  const peer = join(h.home, "beta"); mkdirSync(peer, { recursive: true });
  await runWith(h, projectOpen({ dir: peer, slug: "beta", outcome: "route", reviewTrigger: "review", nextAction: "receive", ephemeral: true, createSpace: true }));
  await runWith(h, mutate(peer, p => Effect.succeed([{ ...p, agents: [{ ...row, cwd: peer, sessionId: "beta-session" }] }, undefined] as const)));
  privateFile(networkConfigPath(h.home), config);
  mkdirSync(dirname(registryPath(h.home)), { recursive: true });
  writeFileSync(registryPath(h.home), `${JSON.stringify({ slug: "beta", dir: peer })}\n`);
  return { h, dir, peer };
}

/** One authenticated mailbox event whose opened body is `body`, signed by `senderDid`, for the real consumer. */
async function oneMessage(home: string, receiverDid: string, receiverSession: string, senderDid: string, body: unknown) {
  const { Output } = await import("./vendor/rat-king-lexicon/mailbox.list.ts");
  const { Main } = await import("./vendor/rat-king-lexicon/runtime.lease.ts");
  const raw = JSON.parse(readFileSync(new URL("./vendor/rat-king-fixtures/list.output.json", import.meta.url), "utf8").replaceAll("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", senderDid));
  const events = Schema.decodeUnknownSync(Output)(raw).events;
  const defs = await import("./vendor/rat-king-lexicon/defs.ts");
  const receipt = Schema.decodeUnknownSync(Schema.toType(defs.Receipt))(events[0]!.receipt);
  const lease = Schema.decodeUnknownSync(Main)({ did: receiverDid, leaseId: "3jzfcijpj2z2b", generation: 1, expiresAt: "2026-10-07T00:00:00Z", harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: receiverSession } });
  const did = Schema.decodeUnknownSync(Main.schema.fields.did)(senderDid);
  const tid = Schema.decodeUnknownSync(Main.schema.fields.leaseId)("3jzfcijpj2z2a");
  void home;
  return {
    lease: { acquire: () => Effect.succeed(lease), renew: () => Effect.succeed(lease), resolve: () => Effect.succeed(lease), release: () => Effect.void },
    watch: () => Stream.succeed({ events, throughSeq: 2 }),
    open: () => Effect.succeed({ body: JSON.stringify(body), senderDid: did, tid, verified: true as const }),
    deliver: () => Effect.succeed({ receipt }),
    ack: () => Effect.succeed({ receipt }),
  };
}

describe("comms friction: a failed send is loud", () => {
  it("network and fallback both failing returns lost, and the tool result is an error", async () => {
    const { h, dir } = await fixture();
    seedNetworkIdentities(h.home, { "beta/desk": reference(networkProvisionName("beta/desk")) });
    const relay = vi.fn(() => Effect.succeed({ status: "failed" as const, detail: "target_not_found" }));
    const result = await runWith(h, sendDesk({ home: h.home, dir, to: "beta/desk", text: "ask", sender: "alpha-session", id: "r1", at: "2026-10-09T15:00:00Z",
      comms: { ...NetworkComms, send: () => Effect.succeed({ status: "failed" as const, detail: "network unavailable" }), relay } }));
    expect(result.path).toBe("intercom-fallback");
    expect(result.lost).toBe(true);
    const tool = loudDelivery({ content: [{ type: "text" as const, text: "delivery: intercom-fallback" }] }, result.lost);
    expect(tool).toMatchObject({ isError: true });
    expect(tool.content[0]!.text).toMatch(/^NOT DELIVERED: the network send and its fallback both failed/);
  });

  it("a delivered fallback or network send is not lost", async () => {
    const send = (network: "failed" | "accepted", fallback: "failed" | "delivered") => Effect.runPromise(reportedNetworkSend({ home: harness().home, sender: "s", to: "t", id: "r", at: "2026-10-09T15:00:00Z",
      network: Effect.succeed({ status: network }), fallback: () => Effect.succeed({ status: fallback }) }));
    expect((await send("failed", "delivered")).lost).toBe(false);
    expect((await send("accepted", "failed")).lost).toBe(false);
    expect((await send("failed", "failed")).lost).toBe(true);
  });

  it("an owner notice whose network post and intercom relay both fail reports lost", async () => {
    const { h } = await fixture();
    const result = await Effect.runPromise(deliverOwnerItem({ owner: "owner-session", home: h.home, session: "worker-session", project: "alpha",
      item: { author: "worker-session", kind: "action", title: "Packet ready" },
      comms: { ...NetworkComms, mode: () => Effect.succeed("network" as const), postOwner: () => Effect.succeed({ status: "failed" as const, detail: "LeaseMismatch" }), relay: () => Effect.succeed({ status: "failed" as const, detail: "target_not_found" }) },
      send: () => Effect.die("network path only"),
    }));
    expect(result.lost).toBe(true);
  });
});

describe("comms friction: predecessors and rowless senders", () => {
  it("delivers mail addressed to a recorded predecessor and still refuses other sessions", async () => {
    const { h } = await fixture();
    const desk = reference(networkProvisionName("alpha/desk")); const worker = reference("worker");
    seedNetworkIdentities(h.home, { "alpha/desk": desk, worker });
    recordSessionSuccessor(h.home, { at: "2026-10-09T15:13:00Z", project: "alpha", row: "desk", from: "old-desk", to: "alpha-session" });
    expect(currentSuccessor(h.home, "old-desk")).toBe("alpha-session");
    const run = async (recipient: string) => {
      const mailbox = await oneMessage(h.home, desk.did, "alpha-session", worker.did, { type: "message", recipient, author: "worker-session", body: "Report." });
      const got: NetworkPayload[] = [];
      await Effect.runPromise(consumeNetworkMailbox({ home: h.home, agent: "alpha/desk", session: "alpha-session", mailbox,
        accepts: (addressed, session) => isPredecessorSession(h.home, addressed, session),
        senderAgent: () => Effect.succeed("worker"), receive: payload => Effect.sync(() => { got.push(payload); }) }));
      return got;
    };
    expect((await run("old-desk")).map(payload => payload.type === "message" ? payload.body : "")).toEqual(["Report."]);
    const stale = await run("stranger-session");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.type === "message" && stale[0]!.body).toContain("addressed to session stranger-session, not this session (stale delivery refused)");
  });

  it("a retired session's reader stops before its successor's mail instead of refusing it, leaving it for the successor", async () => {
    const { h } = await fixture();
    const desk = reference(networkProvisionName("alpha/desk")); const worker = reference("worker");
    seedNetworkIdentities(h.home, { "alpha/desk": desk, worker });
    recordSessionSuccessor(h.home, { at: "2026-10-09T20:40:00Z", project: "alpha", row: "desk", from: "old-desk", to: "new-desk" });
    const mailbox = await oneMessage(h.home, desk.did, "old-desk", worker.did, { type: "message", recipient: "new-desk", author: "worker-session", body: "For the successor." });
    const got: NetworkPayload[] = [];
    const result = await Effect.runPromise(Effect.result(consumeNetworkMailbox({ home: h.home, agent: "alpha/desk", session: "old-desk", mailbox,
      accepts: (addressed, session) => isPredecessorSession(h.home, addressed, session),
      succeededBy: (addressed, session) => isPredecessorSession(h.home, session, addressed),
      senderAgent: () => Effect.succeed("worker"), receive: payload => Effect.sync(() => { got.push(payload); }) })));
    expect(result._tag).toBe("Failure");
    expect(String(result._tag === "Failure" ? (result.failure as Error).message : "")).toContain(RETIRED_PREFIX);
    expect(got).toEqual([]);
    expect(existsSync(join(h.home, ".local/state/muster/network-quarantine"))
      ? readdirSync(join(h.home, ".local/state/muster/network-quarantine"), { recursive: true }).filter(name => String(name).endsWith(".json")) : []).toEqual([]);
  });

  it("names the mailbox error code and status when delivery fails, never a bare generic failure", async () => {
    const { h } = await fixture();
    const desk = reference(networkProvisionName("alpha/desk")); const worker = reference("worker");
    seedNetworkIdentities(h.home, { "alpha/desk": desk, worker });
    const base = await oneMessage(h.home, desk.did, "alpha-session", worker.did, { type: "message", recipient: "alpha-session", author: "worker-session", body: "Report." });
    const { MailboxClientError } = await import("./vendor/rat-king-mailbox-client/error.ts");
    const mailbox = { ...base, deliver: () => Effect.fail(new MailboxClientError({ error: "InvalidState", reason: "already delivered", status: 409 })) };
    const result = await Effect.runPromise(Effect.result(consumeNetworkMailbox({ home: h.home, agent: "alpha/desk", session: "alpha-session", mailbox: mailbox as never,
      senderAgent: () => Effect.succeed("worker"), receive: () => Effect.void })));
    expect(result._tag).toBe("Failure");
    const message = result._tag === "Failure" ? (result.failure as Error).message : "";
    expect(message).toContain("mailbox InvalidState (HTTP 409)");
    expect(message).not.toContain("already delivered");
  });

  it("reads a restart fork's parent from its journal header", () => {
    const h = harness();
    const parent = join(h.home, "restart-new.jsonl");
    writeFileSync(parent, `${JSON.stringify({ type: "session", id: "parent-session", timestamp: "2026-10-09T15:00:00Z" })}\n{"type":"message"}\n`);
    expect(forkParentSession({ parentSession: parent })).toBe("parent-session");
    expect(forkParentSession({})).toBeUndefined();
    expect(forkParentSession({ parentSession: join(h.home, "missing.jsonl") })).toBeUndefined();
  });

  it("wires predecessor acceptance and rowless authors into the network adapter", async () => {
    const { h, dir } = await fixture();
    let adapter: Parameters<typeof import("./comms-network.ts").createNetworkComms>[0] | undefined;
    const real = await import("./comms-network.ts");
    seedNetworkIdentities(h.home, { titan: reference("titan"), worker: reference("worker") });
    vi.doMock("./comms-network.ts", () => ({ ...real, provisionPreflipRow: () => Effect.void,
      createNetworkComms: (options: NonNullable<typeof adapter>) => { adapter = options; return { ...NetworkComms, mode: () => Effect.succeed("network" as const) }; } }));
    try {
      recordSessionSuccessor(h.home, { at: "2026-10-09T15:13:00Z", project: "alpha", row: "desk", from: "old-desk", to: "alpha-session" });
      const service = createComms({ home: h.home, projectDir: dir, events: { emit() {}, on() {} } as never, createId: () => "id", adapterEnv: () => "network",
        networkSender: () => ({ agent: "alpha/desk", session: "alpha-session" }), forkParent: () => "fork-parent" });
      expect(await Effect.runPromise(service.mode!())).toBe("network");
      expect(adapter!.accepts!("old-desk", "alpha-session")).toBe(true);
      expect(adapter!.accepts!("fork-parent", "alpha-session")).toBe(true);
      expect(adapter!.accepts!("stranger", "alpha-session")).toBe(false);
      // Titan owns rubicon-fitness with MUSTER_AGENT and no row: its authenticated DID names it.
      expect(await Effect.runPromise(adapter!.author!("titan-session", reference("titan").did))).toBe("titan");
      // A row's identity is bound to its session; an unknown session may not borrow it.
      await expect(Effect.runPromise(adapter!.author!("intruder-session", reference("worker").did))).rejects.toThrow("unknown recipient");
      // The retired session of a restart speaks as its successor's row.
      expect(await Effect.runPromise(adapter!.author!("old-desk", reference("x").did))).toBe("alpha/desk");
      service.dispose();
    } finally { vi.doUnmock("./comms-network.ts"); }
  });

  it("tells an unknown sender once that its message was refused, and never answers a refusal", async () => {
    const { h } = await fixture();
    const desk = reference(networkProvisionName("alpha/desk")); const titan = reference("titan");
    seedNetworkIdentities(h.home, { "alpha/desk": desk, titan });
    const refused = vi.fn(() => Effect.void);
    for (const body of ["Status?", `${REFUSAL_PREFIX} x (seq 1) to titan-session: ...`]) {
      const mailbox = await oneMessage(h.home, desk.did, "alpha-session", titan.did, { type: "message", recipient: "alpha-session", author: "titan-session", body });
      await Effect.runPromise(consumeNetworkMailbox({ home: h.home, agent: "alpha/desk", session: "alpha-session", mailbox,
        senderAgent: () => Effect.fail(new CommsError("unknown")), refused, receive: () => Effect.void }));
    }
    expect(refused).toHaveBeenCalledOnce();
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ kind: "unknown-author", senderDid: titan.did, author: "titan-session" }));
    const refusal = { kind: "unknown-author" as const, reason: "r", seq: 1, messageId: "m", senderDid: titan.did, author: "titan-session", recipient: "alpha-session" };
    expect(await Effect.runPromise(claimRefusalNotice(h.home, "alpha/desk", refusal))).toBeTruthy();
    expect(await Effect.runPromise(claimRefusalNotice(h.home, "alpha/desk", { ...refusal, seq: 2 }))).toBeUndefined();
    expect(await Effect.runPromise(claimRefusalNotice(h.home, "alpha/desk", { ...refusal, author: "titan-restarted" }))).toBeTruthy();
  });
});

describe("comms friction: restart brief sender", () => {
  it("a self-restarted session signs its handover brief as the row its successor holds", async () => {
    const { h, dir } = await fixture();
    expect(sessionCommsSender(dir, "old-desk", { HOME: h.home, MUSTER_AGENT: "desk" })).toBeUndefined();
    recordSessionSuccessor(h.home, { at: "2026-10-09T15:07:00Z", project: "alpha", row: "desk", from: "old-desk", to: "alpha-session" });
    expect(sessionCommsSender(dir, "old-desk", { HOME: h.home, MUSTER_AGENT: "desk" })).toEqual({ agent: "alpha/desk", session: "old-desk" });
    expect(sessionCommsSender(dir, "never-a-row", { HOME: h.home })).toBeUndefined();
  });
});

describe("comms friction: joining is prompt and worded honestly", () => {
  it("says about a minute, not 30 s", () => {
    expect(preflipNotice("worker", "not delivered")).toContain("within about a minute");
  });

  it("a local mint kicks the row's feed through its kick file", async () => {
    const { h, dir } = await fixture();
    const project = await runWith(h, load(dir));
    const row = project.agents.find(row => row.name === "worker")!;
    await Effect.runPromise(provisionPreflipRow({ home: h.home, target: { project, row, identity: "worker", peers: [] }, run: async (_file, args) => JSON.stringify(reference(args[2]!)) }));
    expect(existsSync(commsKickPath("worker-session", h.home))).toBe(true);
  });

  it("rejoin forgets a remembered miss, so a fix lands on the next selection", async () => {
    const h = harness();
    privateFile(networkConfigPath(h.home), config);
    seedNetworkIdentities(h.home, { worker: reference("worker") });
    seedNetworkPeers(h.home, { "worker-session": "worker" });
    expect(readNetworkPeers(h.home)["worker-session"]).toBe("worker");
    let keyPresent = false;
    const run = vi.fn(async () => keyPresent ? `[{"name": "entry_worker"}]` : "[]");
    const service = createComms({ home: h.home, projectDir: join(h.home, "none"), events: { emit() {}, on() {} } as never, createId: () => "id", adapterEnv: () => "intercom", remote: true, run,
      networkSender: () => ({ agent: "worker", session: "worker-session" }) });
    expect(await Effect.runPromise(service.mode!())).toBe("intercom");
    keyPresent = true; // The owner pushed the key.
    expect(await Effect.runPromise(service.mode!())).toBe("intercom"); // Remembered miss.
    service.rejoin();
    expect(await Effect.runPromise(service.mode!())).toBe("network");
    service.dispose();
  });

  it("the owner feed rejoins and rechecks when its kick file changes", async () => {
    const h = harness();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {} };
    const rejoin = vi.fn();
    const mode = vi.fn(async () => "intercom" as const);
    registerOwnerFeed(pi as never, { HOME: h.home }, { rejoin, mode, consume: async () => {} }, async () => false);
    try {
      handlers.get("session_start")!({}, { isIdle: () => false, sessionManager: { getSessionId: () => "kicked-session", getBranch: () => [] } });
      await vi.waitFor(() => expect(mode).toHaveBeenCalled());
      const before = mode.mock.calls.length;
      kickComms("kicked-session", h.home);
      await vi.waitFor(() => expect(rejoin).toHaveBeenCalled());
      await vi.waitFor(() => expect(mode.mock.calls.length).toBeGreaterThan(before));
    } finally { await handlers.get("session_shutdown")!(); }
  });
});

describe("comms friction: remote rows skip the Flagg inbox pull", () => {
  it("returns no pull on a remote machine", () => {
    const pull = async () => ["pulled"];
    expect(remoteInboxPull({ MUSTER_MACHINE: "pennywise" }, pull)).toBeUndefined();
    expect(remoteInboxPull({ MUSTER_MACHINE: "local" }, pull)).toBe(pull);
    expect(remoteInboxPull({}, pull)).toBe(pull);
  });
});
