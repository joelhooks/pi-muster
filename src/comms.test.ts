import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { commsAddress, createComms, IntercomComms, NetworkComms, selectComms, LeaseAuthority, NetworkMailbox, leaseToComms, resolveNetworkAddress } from "./comms.ts";
import { Input as AckInput } from "./vendor/rat-king-lexicon/mailbox.ack.ts";
import { Main as Lease, type MainValue as LeaseValue } from "./vendor/rat-king-lexicon/runtime.lease.ts";
import { Params as ListInput } from "./vendor/rat-king-lexicon/mailbox.list.ts";
import { Input as SendInput } from "./vendor/rat-king-lexicon/mailbox.send.ts";
import { CommsError, Unsupported, type IntercomTransport } from "./runtime.ts";
import { Policy, decodeOwnerItem, decodePolicy, mergePolicy } from "./domain.ts";
import { OUTBOX_REQUEST_EVENT, OUTBOX_RESULT_EVENT } from "./intercom.ts";
import { appendOwnerItem, canonicalJson, deliverOwnerItem, ownerPath, readOwnerQueue } from "./owner-queue.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { load, projectPath } from "./store.ts";
import { harness, runWith } from "./test-support.ts";

function bus(status = "sent") {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const requests: Array<{ requestId: string; to: string; message: string }> = [];
  const events = {
    on(event: string, listener: (payload: unknown) => void) {
      const set = listeners.get(event) ?? new Set(); set.add(listener); listeners.set(event, set);
      return () => { set.delete(listener); };
    },
    emit(event: string, payload: unknown) {
      if (event === OUTBOX_REQUEST_EVENT && typeof payload === "object" && payload !== null && "requestId" in payload && typeof payload.requestId === "string" && "to" in payload && typeof payload.to === "string" && "message" in payload && typeof payload.message === "string") {
        requests.push({ requestId: payload.requestId, to: payload.to, message: payload.message });
        events.emit(OUTBOX_RESULT_EVENT, { requestId: payload.requestId, status });
      }
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
  return { events, requests, listeners };
}
const transport: IntercomTransport = { send: () => Effect.succeed({ status: "sent" }), sessions: () => Effect.succeed(["live"]) };
const adapter = () => IntercomComms(transport, () => Effect.succeed("live"));

const wireFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./__fixtures__/ratking-v0/${name}.json`, import.meta.url), "utf8"));
describe("private network seams", () => {
  const lease = Schema.decodeUnknownSync(Lease)(wireFixture("lease.object"));
  const piTag = "sh.mschf.ratking.runtime.lease#pi";
  const piSession = (binding: LeaseValue) => typeof binding.harness.sessionId === "string" && binding.harness.sessionId.length > 0
    ? Effect.succeed(binding.harness.sessionId) : Effect.fail(new Unsupported("pi session unresolved"));
  it("refuses acquire, resolve, release and every typed mailbox call by default", async () => {
    const refusals = [
      LeaseAuthority.acquire(lease), LeaseAuthority.resolve(lease.did), LeaseAuthority.release(lease),
      NetworkMailbox.send(Schema.decodeUnknownSync(SendInput)(wireFixture("send.input"))),
      NetworkMailbox.ack(Schema.decodeUnknownSync(AckInput)(wireFixture("ack.input"))),
      NetworkMailbox.list(Schema.decodeUnknownSync(ListInput)(wireFixture("list.params"))),
    ];
    for (const refusal of refusals) await expect(Effect.runPromise(refusal)).rejects.toBeInstanceOf(Unsupported);
  });
  it("maps a DID lease only through an explicitly supported session adapter", async () => {
    await expect(Effect.runPromise(leaseToComms(lease))).rejects.toBeInstanceOf(Unsupported);
    expect(await Effect.runPromise(leaseToComms(lease, { [piTag]: piSession }))).toEqual({ address: { kind: "did", did: lease.did }, session: "example-session", expiresAt: lease.expiresAt });
    const paneOnly = Schema.decodeUnknownSync(Lease)({ ...lease, harness: { $type: piTag, paneId: "not-an-identity" } });
    await expect(Effect.runPromise(leaseToComms(paneOnly, { [piTag]: piSession }))).rejects.toBeInstanceOf(Unsupported);
    await expect(Effect.runPromise(leaseToComms(lease, { [piTag]: () => Effect.succeed("") }))).rejects.toBeInstanceOf(Unsupported);
    const future = Schema.decodeUnknownSync(Lease)({ ...lease, harness: { $type: "future.adapter", sessionId: "looks-live" } });
    await expect(Effect.runPromise(leaseToComms(future, { [piTag]: piSession }))).rejects.toBeInstanceOf(Unsupported);
  });
  it.each(["p/desk", "local-session"])("resolves %s locally before addressing the authority by DID", async identity => {
    const localDid = vi.fn(() => Effect.succeed(lease.did));
    const resolve = vi.fn(() => Effect.succeed(lease));
    const options = { localDid, authority: { ...LeaseAuthority, resolve }, adapters: { [piTag]: piSession } };
    expect((await Effect.runPromise(resolveNetworkAddress(identity, options))).address).toEqual({ kind: "did", did: lease.did });
    expect(localDid).toHaveBeenCalledWith(commsAddress(identity));
    expect(resolve).toHaveBeenCalledWith(lease.did);
    localDid.mockClear();
    await Effect.runPromise(resolveNetworkAddress(lease.did, options));
    expect(localDid).not.toHaveBeenCalled();
  });
  it("rejects a mismatched authority DID and propagates local/authority failures", async () => {
    const options = { localDid: () => Effect.succeed(lease.did), authority: LeaseAuthority, adapters: { [piTag]: piSession } };
    await expect(Effect.runPromise(resolveNetworkAddress("p/desk", options))).rejects.toBeInstanceOf(Unsupported);
    await expect(Effect.runPromise(resolveNetworkAddress("p/desk", { ...options, localDid: () => Effect.fail(new CommsError("unknown local alias")) }))).rejects.toThrow("unknown local alias");
    await expect(Effect.runPromise(resolveNetworkAddress(lease.did, { ...options, authority: { ...LeaseAuthority, resolve: () => Effect.succeed(Schema.decodeUnknownSync(Lease)({ ...lease, did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" })) } }))).rejects.toThrow("another DID");
  });
});

describe("Comms port", () => {
  it("selects env before policy before default, rejecting invalid env instead of falling back", () => {
    expect(selectComms(undefined)).toBe("intercom");
    expect(selectComms(undefined, { comms: "network" })).toBe("network");
    expect(selectComms("intercom", { comms: "network" })).toBe("intercom");
    expect(selectComms("network", { comms: "intercom" })).toBe("network");
    expect(() => selectComms("bogus", { comms: "intercom" })).toThrow(/MUSTER_COMMS/);
    expect(Schema.decodeUnknownSync(Policy)({})).toEqual({ comms: "intercom" });
    expect(mergePolicy({ comms: "network" }, decodePolicy({ nudgeAfterMin: 20 })).comms).toBe("network");
    expect(mergePolicy({ comms: "network" }, decodePolicy({ comms: "intercom" })).comms).toBe("intercom");
  });
  it("accepts tagged addresses and local aliases; DID is typed but refused by intercom", async () => {
    expect(commsAddress("p/desk")).toEqual({ kind: "alias", project: "p", row: "desk" });
    expect(commsAddress("session-1")).toEqual({ kind: "session", id: "session-1" });
    await expect(Effect.runPromise(adapter().resolve({ kind: "did", did: "did:key:abc" }))).rejects.toBeInstanceOf(Unsupported);
    expect(await Effect.runPromise(adapter().send("did:key:abc", "opaque"))).toMatchObject({ status: "failed", detail: expect.stringContaining("DID") });
    await expect(Effect.runPromise(adapter().resolve("p/desk/extra"))).rejects.toBeInstanceOf(CommsError);
  });
  it.each(["ask", "reply"] as const)("%s reports typed Unsupported without sending", async method => {
    const send = vi.fn(transport.send); const service = IntercomComms({ ...transport, send }, () => Effect.succeed("live"));
    const result = method === "ask" ? service.ask("live", "opaque", { timeoutMs: 10 }) : service.reply("record", "opaque");
    await expect(Effect.runPromise(result)).rejects.toBeInstanceOf(Unsupported);
    expect(send).not.toHaveBeenCalled();
  });
  it("wake reports no wake, separately from message delivery", async () => {
    expect(await Effect.runPromise(adapter().wake("live"))).toEqual({ woke: false, reason: "intercom has no wake" });
    expect(await Effect.runPromise(adapter().sessions())).toEqual(["live"]);
  });
  it.each(["sent", "queued", "rejected", "blocked", "failed", "unavailable"] as const)("maps intercom %s through the port without touching bodies", async status => {
    const events = bus(status); const h = harness();
    const comms = createComms({ events: events.events, createId: () => "1", home: h.home, projectDir: "/missing", adapterEnv: () => "intercom" });
    const body = '\u0000opaque {"encrypted":"not parsed"}';
    try {
      expect(await Effect.runPromise(comms.send({ kind: "session", id: "live" }, body))).toMatchObject({ status: status === "sent" ? "delivered" : status === "queued" ? "queued" : "failed" });
      expect(events.requests[0]).toEqual({ requestId: "muster-1", to: "live", message: body });
      expect(events.listeners.get(OUTBOX_RESULT_EVENT)?.size).toBe(0);
    } finally { comms.dispose(); }
  });
  it("network fails closed on every operation and opens no intercom channel", async () => {
    const events = bus(); const h = harness();
    const comms = createComms({ events: events.events, createId: () => "1", home: h.home, projectDir: "/missing", adapterEnv: () => "network" });
    expect(await Effect.runPromise(comms.send("live", "opaque"))).toMatchObject({ status: "failed", detail: expect.stringContaining("NetworkComms") });
    const operations: readonly Effect.Effect<unknown, CommsError>[] = [comms.ask("live", "opaque", { timeoutMs: 10 }), comms.reply("record", "opaque"), comms.resolve("live"), comms.wake("live"), comms.sessions()];
    for (const operation of operations) {
      await expect(Effect.runPromise(operation.pipe(Effect.asVoid))).rejects.toThrow(/NetworkComms missing or invalid config: .*network.json/);
    }
    expect(events.requests).toEqual([]); expect(events.listeners.size).toBe(0);
    expect(await Effect.runPromise(NetworkComms.send("live", "opaque"))).toMatchObject({ status: "failed" });
  });
  it("resolves the catalog again after restore changes the session, never caching a lease", async () => {
    const h = harness(); const dir = h.home + "/project"; mkdirSync(dir, { recursive: true });
    await runWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n", ephemeral: true, createSpace: true }));
    await runWith(h, laneOpen(dir, { slug: "desk", label: "desk", goal: "g", repo: dir }));
    await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: dir }));
    const events = bus(); const comms = createComms({ events: events.events, createId: () => "1", home: h.home, projectDir: dir, adapterEnv: () => undefined });
    try {
      const before = await Effect.runPromise(comms.resolve("probe/desk"));
      await Effect.runPromise(comms.send("probe/desk", "before"));
      // Restore and /new publish a new session in the same catalog row.
      const catalog = await runWith(h, load(dir));
      writeFileSync(projectPath(dir), JSON.stringify({ ...catalog, agents: catalog.agents.map(row => ({ ...row, sessionId: "restored-session" })) }));
      const after = await Effect.runPromise(comms.resolve({ kind: "alias", project: "probe", row: "desk" }));
      expect(after.address).toEqual(before.address); expect(after.session).toBe("restored-session");
      expect(after.session).not.toBe(before.session);
      await Effect.runPromise(comms.send("probe/desk", "after"));
      expect(events.requests.map(request => request.to)).toEqual([before.session, "restored-session"]);
      await Effect.runPromise(comms.send(before.session, "raw ids remain raw"));
      expect(events.requests.at(-1)?.to).toBe(before.session);
      writeFileSync(projectPath(dir), JSON.stringify({ ...catalog, policy: { comms: "network" } }));
      expect(await Effect.runPromise(comms.send("probe/desk", "offline"))).toMatchObject({ status: "failed", detail: expect.stringContaining("NetworkComms") });
      expect(events.requests).toHaveLength(3);
    } finally { comms.dispose(); }
  });
  it.each(["sent", "queued", "blocked", "rejected", "unavailable", "failed"])("decodes old %s delivery metadata without changing CID", status => {
    const record = decodeOwnerItem({ $type: "dev.muster.note.post", uri: "muster://old/record", cid: "old-cid", author: "old", createdAt: "2026-10-01T00:00:00Z", text: "legacy", kind: "fyi", delivery: { status } });
    expect(record.cid).toBe("old-cid");
    expect(record.delivery?.status).toBe(status === "sent" ? "delivered" : status === "queued" ? "queued" : "failed");
  });
  it("network failure leaves the owner outbox queued for offline replay", async () => {
    const h = harness();
    const result = await Effect.runPromise(deliverOwnerItem({ owner: "owner", home: h.home, session: "writer", project: "probe",
      item: { author: "writer", kind: "question", title: "offline", signed: { opaque: true } }, send: NetworkComms.send }));
    expect(result.queued).toBe(true);
    expect(result.delivery.status).toBe("failed");
    expect(readOwnerQueue("owner", h.home).items[0]?.item).toMatchObject({ uri: result.uri, signed: { opaque: true } });
  });
  it("keeps unsigned legacy rows, opaque signed slots and their CIDs without rewriting JSONL", () => {
    const h = harness(); const path = ownerPath("owner", h.home);
    mkdirSync(dirname(path), { recursive: true });
    const old = { $type: "dev.muster.note.post", uri: "muster://old/record", cid: "old-cid", author: "old", createdAt: "2026-10-01T00:00:00Z", text: "legacy", kind: "fyi", delivery: { status: "sent" } };
    const raw = JSON.stringify(old) + "\n"; writeFileSync(path, raw);
    expect(readOwnerQueue("owner", h.home).items[0]?.item).toMatchObject({ cid: "old-cid", text: "legacy", delivery: { status: "delivered" } });
    expect(readFileSync(path, "utf8")).toBe(raw);
    const signed = { codec: "provisional", bytes: [1, 2, 3] };
    const item = appendOwnerItem("owner", { author: "writer", kind: "fyi", title: "opaque", signed }, h.home);
    expect(readOwnerQueue("owner", h.home).items[1]?.item).toEqual(item);
    expect(item.signed).toEqual(signed);
    const { cid, signed: _signed, ...record } = item;
    expect(cid).toBe(createHash("sha256").update(canonicalJson(record)).digest("hex").slice(0, 32)); expect(record).not.toHaveProperty("signed");
    expect(readFileSync(path, "utf8").startsWith(raw)).toBe(true);
  });
});
