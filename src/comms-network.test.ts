import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Schema, Stream } from "effect";
import type { Socket } from "effect/socket";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createComms } from "./comms.ts";
import { createNetworkComms, networkConfigPath, networkIdentityPath, networkRecipient, openNetworkMailbox, provisionNetworkAgent, readNetworkConfig, readNetworkIdentities, watchCloseAction, watchNetworkMailbox, consumeNetworkMailbox, prepareRemoteNetworkAgent } from "./comms-network.ts";
import { decodeCommsIdentityReference, decodeMachines } from "./domain.ts";
import { appendOwnerItem, deliverOwnerItem, ingestOwnerItem, readOwnerQueue, writeReader } from "./owner-queue.ts";
import { CommsError, Proc, MusterEnv } from "./runtime.ts";
import { harness } from "./test-support.ts";

const config = { endpoint: "https://mailbox.example.invalid", serviceDid: "did:web:mailbox.example.invalid", provisionWrapper: "/private/pilot-wrapper", didTemplate: "did:web:{agent}.example.invalid", secretsCommand: "/private/secrets" };
function home() { return mkdtempSync(join(tmpdir(), "muster-network-")); }
function privateFile(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function provision(agent = "desk") {
  const did = config.didTemplate.replace("{agent}", agent);
  return { did, secret: `rat_king_agent_${agent}_identity`, document: {
    id: did, verificationMethod: ["atproto", "encryption"].map(key => ({ id: `${did}#${key}`, controller: did, publicKeyJwk: { kty: "EC", crv: "P-256", x: "public-x", y: "public-y" } })),
    authentication: [`${did}#atproto`], keyAgreement: [`${did}#encryption`],
  } };
}

describe("private network configuration and provisioning", () => {
  it("startup's transitive static import graph excludes all Rat King runtime code", () => {
    const visited = new Set<string>();
    const visit = (path: string) => {
      if (visited.has(path)) return;
      visited.add(path);
      expect(path).not.toContain("/vendor/rat-king-");
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) && !statement.importClause.name && statement.importClause.namedBindings.elements.every(item => item.isTypeOnly)) continue;
        const specifier = statement.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) visit(resolve(dirname(path), specifier.text));
      }
    };
    visit(resolve("extensions/pi-muster.ts"));
    // guardedLoad evaluates extension-main dynamically when registration starts.
    visit(resolve("src/extension-main.ts"));
    expect([...visited].some(path => path.endsWith("comms.ts"))).toBe(true);
    expect([...visited].some(path => path.endsWith("comms-network.ts"))).toBe(false);
  });
  it("intercom mode checks remain inert and never register a bus channel", async () => {
    const emit = vi.fn(); const on = vi.fn();
    const service = createComms({ home: home(), projectDir: "/missing", events: { emit, on }, createId: () => "id", adapterEnv: () => "intercom" });
    if (!service.mode) throw new Error("mode seam missing");
    expect(await Effect.runPromise(service.mode())).toBe("intercom");
    expect(emit).not.toHaveBeenCalled(); expect(on).not.toHaveBeenCalled();
  });
  it("fails at call time with the config file name and zero intercom events", async () => {
    const root = home(); const emit = vi.fn(); const on = vi.fn();
    const service = createComms({ home: root, projectDir: "/missing", events: { emit, on }, createId: () => "id", adapterEnv: () => "network" });
    expect(emit).not.toHaveBeenCalled(); expect(on).not.toHaveBeenCalled();
    expect(await Effect.runPromise(service.send("desk", "message"))).toMatchObject({ status: "failed", detail: expect.stringContaining(networkConfigPath(root)) });
    await expect(Effect.runPromise(service.resolve("desk"))).rejects.toThrow(networkConfigPath(root));
    expect(emit).not.toHaveBeenCalled(); expect(on).not.toHaveBeenCalled();
  });
  it("rejects insecure modes, symlinks, credentials and #mailbox in serviceDid", () => {
    const root = home(); const path = networkConfigPath(root);
    privateFile(path, config); chmodSync(path, 0o644);
    expect(() => readNetworkConfig(root)).toThrow("0600"); chmodSync(path, 0o600);
    privateFile(path, { ...config, serviceDid: `${config.serviceDid}#mailbox` });
    expect(() => readNetworkConfig(root)).toThrow(path);
    privateFile(path, { ...config, endpoint: "https://secret:credential@example.invalid" });
    expect(() => readNetworkConfig(root)).toThrow(path);
    const other = home(); mkdirSync(dirname(networkConfigPath(other)), { recursive: true }); symlinkSync(path, networkConfigPath(other));
    expect(() => readNetworkConfig(other)).toThrow("regular file");
  });
  it("provisions once, stores only a secret reference in owned 0600 state, and resolves cached public documents", async () => {
    const root = home(); privateFile(networkConfigPath(root), config);
    const run = vi.fn(async () => JSON.stringify(provision()));
    const first = await Effect.runPromise(provisionNetworkAgent({ home: root, agent: "desk", run }));
    expect(await Effect.runPromise(provisionNetworkAgent({ home: root, agent: "desk", run }))).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(config.provisionWrapper, ["provision", "--agent", "desk", "--did", first.did]);
    expect(statSync(networkIdentityPath(root)).mode & 0o777).toBe(0o600);
    expect(networkRecipient(root, "desk")).toEqual(first);
    expect(() => networkRecipient(root, "unknown-worker")).toThrow("unknown recipient: unknown-worker");
    expect(readFileSync(networkIdentityPath(root), "utf8")).not.toContain('"d":');
  });
  it("refuses DID mismatches and private document keys without caching or disclosing output", async () => {
    const root = home(); privateFile(networkConfigPath(root), config);
    const run = async () => JSON.stringify({ ...provision(), did: "did:web:other.invalid", leaked: "PRIVATE_SENTINEL" });
    await expect(Effect.runPromise(provisionNetworkAgent({ home: root, agent: "desk", run }))).rejects.toThrow("identity mismatch: desk");
    expect(readNetworkIdentities(root)).toEqual({});
    const raw = provision(); raw.document.verificationMethod[0]!.publicKeyJwk = { ...raw.document.verificationMethod[0]!.publicKeyJwk, ...{ d: "PRIVATE_SENTINEL" } };
    expect(() => decodeCommsIdentityReference(raw)).toThrow();
    const failed = await Effect.runPromiseExit(provisionNetworkAgent({ home: root, agent: "desk", run: async () => { throw new Error("PRIVATE_SENTINEL"); } }));
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_SENTINEL");
  });
  it("refuses stale identity configuration and concurrent writers without changing cache", async () => {
    const root = home(); privateFile(networkConfigPath(root), config);
    privateFile(networkIdentityPath(root), { desk: provision() });
    privateFile(networkConfigPath(root), { ...config, didTemplate: "did:web:{agent}.changed.invalid" });
    await expect(Effect.runPromise(provisionNetworkAgent({ home: root, agent: "desk" }))).rejects.toThrow("differs from config: desk");
    privateFile(`${networkIdentityPath(root)}.lock`, { pid: process.pid, token: "live-holder" });
    await expect(Effect.runPromise(provisionNetworkAgent({ home: root, agent: "worker", lockWaitMs: 50 }))).rejects.toThrow("cache busy: worker");
    expect(readNetworkIdentities(root).desk).toEqual(provision());
    expect(JSON.parse(readFileSync(`${networkIdentityPath(root)}.lock`, "utf8")).token).toBe("live-holder"); // A live holder's lock is never taken.
  });
  it.each([
    ["a dead holder", { pid: 2147483647, token: "dead-holder" }, false],
    ["an empty legacy lock older than 30 s", "", true],
  ] as const)("recovers the identity cache lock from %s and provisions", async (_name, lock, old) => {
    const root = home(); privateFile(networkConfigPath(root), config);
    const path = `${networkIdentityPath(root)}.lock`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (typeof lock === "string") writeFileSync(path, lock, { mode: 0o600 }); else privateFile(path, lock);
    if (old) utimesSync(path, new Date(0), new Date(0));
    const run = vi.fn(async () => JSON.stringify(provision("worker")));
    expect((await Effect.runPromise(provisionNetworkAgent({ home: root, agent: "worker", run, lockWaitMs: 50 }))).did).toBe(provision("worker").did);
    expect(existsSync(path)).toBe(false); // Released after use.
  });
  it("waits for a young empty legacy lock instead of stealing it", async () => {
    const root = home(); privateFile(networkConfigPath(root), config);
    const path = `${networkIdentityPath(root)}.lock`; mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, "", { mode: 0o600 });
    await expect(Effect.runPromise(provisionNetworkAgent({ home: root, agent: "worker", run: async () => JSON.stringify(provision("worker")), lockWaitMs: 50 }))).rejects.toThrow("cache busy: worker");
    expect(existsSync(path)).toBe(true);
  });
  it("unknown recipients fail by name before leasing keys", async () => {
    const root = home(); privateFile(networkConfigPath(root), config); const run = vi.fn(async () => "PRIVATE_SENTINEL");
    const service = createNetworkComms({ home: root, sender: () => ({ agent: "desk", session: "s" }), recipient: () => Effect.succeed("worker"), run });
    expect(await Effect.runPromise(service.send("worker", "body"))).toEqual({ status: "failed", detail: "NetworkComms unknown recipient: worker; provision it first" });
    expect(run).not.toHaveBeenCalled();
  });
  it("passes bare serviceDid and all cached recipient documents into the dynamically loaded client", async () => {
    const root = home(); privateFile(networkConfigPath(root), config); privateFile(networkIdentityPath(root), { desk: provision(), worker: provision("worker") });
    const captured = vi.fn();
    const { Context, Layer } = await import("effect");
    class FakeMailbox extends Context.Service<FakeMailbox, { marker: string }>()("test/network-mailbox") {}
    vi.doMock("./vendor/rat-king-mailbox-client/index.ts", () => ({
      Identity: Schema.Struct({ did: Schema.String }), RatKingMailbox: FakeMailbox,
      layer: (value: unknown) => { captured(value); return Layer.succeed(FakeMailbox)({ marker: "fake" }); },
    }));
    try {
      await Effect.runPromise(openNetworkMailbox({ home: root, agent: "desk", run: async () => JSON.stringify({ did: provision().did }) }));
      expect(captured.mock.calls[0]?.[0]).toMatchObject({ serviceDid: config.serviceDid, documents: [provision().document, provision("worker").document] });
    } finally { vi.doUnmock("./vendor/rat-king-mailbox-client/index.ts"); vi.resetModules(); }
  });
});

describe("network owner routing and consumption", () => {
  it.each(["fyi", "question", "action"] as const)("routes %s through Comms even with a fresh local reader, without locally appending the owner's queue", async kind => {
    const root = home(); writeReader("desk-session", root);
    const postOwner = vi.fn(() => Effect.succeed({ status: "accepted" as const })); const send = vi.fn(() => Effect.succeed({ status: "delivered" as const }));
    const comms = { ...createNetworkComms({ home: root, sender: () => ({ agent: "worker", session: "worker-session" }), recipient: () => Effect.succeed("desk") }), postOwner };
    const result = await Effect.runPromise(deliverOwnerItem({ home: root, project: "pilot", session: "worker-session", owner: "desk-session", item: { author: "worker-session", kind, title: "mailbox only" }, comms, send }));
    expect(result.path).toBe("network"); expect(result.delivery.status).toBe("accepted"); expect(postOwner).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    expect(readOwnerQueue("desk-session", root).items).toHaveLength(0);
    expect(postOwner.mock.calls[0]).toMatchObject(["desk-session", { author: "worker-session", text: expect.stringContaining("mailbox only") }]);
  });
  it("threads owner replies over Comms and keeps failed sends out of the receiver queue", async () => {
    const root = home(); const parent = appendOwnerItem("desk-session", { author: "worker-session", project: "pilot", kind: "question", title: "question" }, root);
    const postOwner = vi.fn(() => Effect.succeed({ status: "failed" as const }));
    const comms = { ...createNetworkComms({ home: root, sender: () => ({ agent: "desk", session: "desk-session" }), recipient: () => Effect.succeed("worker") }), postOwner };
    const result = await Effect.runPromise(deliverOwnerItem({ home: root, project: "pilot", session: "desk-session", owner: "worker-session", item: { author: "desk-session", kind: "fyi", title: "answer", replyTo: parent.uri, mention: "worker-session" }, comms, send: () => Effect.die("intercom forbidden") }));
    expect(result.queued).toBe(false); expect(readOwnerQueue("worker-session", root).items).toHaveLength(0);
    expect(postOwner.mock.calls[0]).toMatchObject(["worker-session", { reply: { parent: { uri: parent.uri, cid: parent.cid } } }]);
  });
  it("authenticates payload author, ingests before ack, checkpoints privately, and releases the fence", async () => {
    const root = home(); privateFile(networkIdentityPath(root), { desk: provision(), worker: provision("worker") });
    const { Output } = await import("./vendor/rat-king-lexicon/mailbox.list.ts");
    const { Main } = await import("./vendor/rat-king-lexicon/runtime.lease.ts");
    const raw = JSON.parse(readFileSync(new URL("./vendor/rat-king-fixtures/list.output.json", import.meta.url), "utf8").replaceAll("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", provision("worker").did));
    const events = Schema.decodeUnknownSync(Output)(raw).events;
    const defs = await import("./vendor/rat-king-lexicon/defs.ts");
    const receipt = Schema.decodeUnknownSync(Schema.toType(defs.Receipt))(events[0]?.receipt);
    const workerDid = Schema.decodeUnknownSync(Main.schema.fields.did)(provision("worker").did);
    const tid = Schema.decodeUnknownSync(Main.schema.fields.leaseId)("3jzfcijpj2z2a");
    const lease = Schema.decodeUnknownSync(Main)({ did: provision().did, leaseId: "3jzfcijpj2z2b", generation: 1, expiresAt: "2026-10-07T00:00:00.000Z", harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: "desk-session" } });
    const item = appendOwnerItem("desk-session", { author: "worker-session", project: "pilot", kind: "action", title: "packet" }, root, false);
    const order: string[] = []; const release = vi.fn(() => Effect.void); const seen = vi.fn();
    const mailbox = {
      lease: { acquire: () => Effect.succeed(lease), renew: () => Effect.succeed(lease), resolve: () => Effect.succeed(lease), release },
      watch: (after: number) => { seen(after); return after ? Stream.empty : Stream.succeed({ events, throughSeq: 2 }); },
      open: () => Effect.succeed({ body: JSON.stringify({ type: "owner", recipient: "desk-session", item }), senderDid: workerDid, tid, verified: true as const }),
      deliver: () => Effect.sync(() => { order.push("deliver"); return { receipt }; }),
      ack: () => Effect.sync(() => { order.push("ack"); return { receipt }; }),
    };
    const options = { home: root, agent: "desk", session: "desk-session", mailbox, senderAgent: () => Effect.succeed("worker"), receive: () => Effect.sync(() => { order.push("ingest"); ingestOwnerItem("desk-session", item, root); }) };
    await Effect.runPromise(consumeNetworkMailbox(options));
    expect(order).toEqual(["ingest", "deliver", "ack"]); expect(release).toHaveBeenCalledOnce();
    expect(readOwnerQueue("desk-session", root).items).toHaveLength(1);
    const path = join(root, ".local/state/muster/network-cursors/desk.json"); expect(statSync(path).mode & 0o777).toBe(0o600);
    await Effect.runPromise(consumeNetworkMailbox(options)); expect(seen.mock.calls).toEqual([[0], [2]]); expect(order).toHaveLength(3);
    privateFile(path, { desk: 0 });
    // A mismatch is refused per message: saved, acked and surfaced, never ingested, and the reader keeps going.
    const notices: string[] = [];
    await Effect.runPromise(consumeNetworkMailbox({ ...options, senderAgent: () => Effect.succeed("desk"), receive: payload => Effect.sync(() => { notices.push(payload.type === "message" ? payload.body : "owner payload delivered"); }) }));
    expect(notices).toHaveLength(1); expect(notices[0]).toContain("authenticated sender differs from payload author worker-session");
    expect(readOwnerQueue("desk-session", root).items).toHaveLength(1); expect(order).toEqual(["ingest", "deliver", "ack", "deliver", "ack"]);
  });
  it("remote provisioning exchanges only public references and keeps the configured path on that machine", async () => {
    const h = harness(); const machine = decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/package", workerWorktree: "/worker", env: {}, comms: { config: "/private/network.json" } } }).remote!;
    const captured: Array<readonly string[]> = [];
    const proc = { run: (_file: string, args: readonly string[]) => { captured.push(args); return Effect.succeed({ code: 0, stdout: captured.length === 1 ? JSON.stringify(provision("worker")) : "", stderr: "" }); } };
    const env = { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/package", workerWorktree: h.workerWorktree, createId: () => "id", sleep: () => Effect.void, emitPaneClose: () => undefined };
    await Effect.runPromise(prepareRemoteNetworkAgent({ home: h.home, agent: "worker", machineName: "remote", machine }).pipe(Effect.provideService(MusterEnv, env), Effect.provideService(Proc, proc)));
    expect(networkRecipient(h.home, "worker")).toEqual(provision("worker"));
    expect(captured).toHaveLength(2);
    expect(captured[0]?.at(-1)).toContain("/private/network.json");
    expect(captured[1]?.at(-1)).toContain("seedNetworkIdentities");
    expect(JSON.stringify(captured)).not.toContain('\\\"d\\\"');
  });
  it("remote network requires an explicit config block and refuses a failed probe without fallback", async () => {
    const h = harness(); const machine = decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/package", workerWorktree: "/worker", env: {} } }).remote!;
    const run = (config: typeof machine) => Effect.runPromise(prepareRemoteNetworkAgent({ home: h.home, agent: "worker", machineName: "remote", machine: config }).pipe(Effect.provideService(MusterEnv, { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/package", workerWorktree: h.workerWorktree, createId: () => "id", sleep: () => Effect.void, emitPaneClose: () => {} }), Effect.provideService(Proc, { run: () => Effect.succeed({ code: 1, stdout: "", stderr: "PRIVATE_SENTINEL" }) })));
    await expect(run(machine)).rejects.toThrow("requires a comms config block");
    await expect(run({ ...machine, comms: { config: "/private/network.json" } })).rejects.toThrow("network config/provision probe failed");
    expect(decodeMachines({ remote: { ...machine, comms: { config: "/private/network.json" } } }).remote?.comms?.config).toBe("/private/network.json");
  });
});

class FakeSocket implements Socket.WebSocketLike {
  readonly readyState = 1;
  noticeSent = false;
  readonly listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();
  constructor(readonly code: number) {}
  addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: Socket.WebSocketEvent) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  close() {}
  send(data: string | Uint8Array<ArrayBuffer>) {
    expect(typeof data === "string" && JSON.parse(data).$type).toBe("sh.mschf.ratking.mailbox.subscribe#auth");
    if (typeof data === "string") {
      const claims = JSON.parse(Buffer.from(JSON.parse(data).token.split(".")[1], "base64url").toString("utf8"));
      expect(claims.aud).toBe(`${config.serviceDid}#mailbox`);
    }
    queueMicrotask(() => { this.noticeSent = true; this.emit("message", { data: JSON.stringify({ $type: "sh.mschf.ratking.mailbox.subscribe#notice", seq: 2 }) }); });
    setTimeout(() => this.emit("close", { code: this.code, reason: "test close" }), 0);
  }
}

describe("network watch close handling through a fake WebSocketPort", () => {
  it.each([4409, 4401, 4408, 1000, 1006, 1012])("maps %s", async code => {
    const { watch } = await import("./vendor/rat-king-mailbox-client/watch.ts");
    const { WebSocketPort, Identity } = await import("./vendor/rat-king-mailbox-client/index.ts");
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
    const identity = Schema.decodeUnknownSync(Identity)({ did: provision().did, signing: jwk, agreement: jwk });
    const connections: FakeSocket[] = [];
    const port = { connect: () => { const socket = new FakeSocket(connections.length === 0 ? code : 4401); connections.push(socket); return socket; } };
    const acquire = vi.fn(() => Effect.succeed({ did: identity.did, leaseId: "3jzfcijpj2z2b", generation: 1 }));
    const stream = watchNetworkMailbox({ mailbox: { watch: (seq, fence) => watch({ ...config, identity, documents: [] }, () => Effect.sync(() => { expect(connections.at(-1)?.noticeSent).toBe(true); return { events: [], throughSeq: seq }; }), seq, fence) }, acquire, afterSeq: 0 });
    const result = await Effect.runPromiseExit(Stream.runDrain(stream).pipe(Effect.provideService(WebSocketPort, port), Effect.timeout("3 seconds")));
    expect(JSON.stringify(result)).toContain("AuthRequired");
    expect(connections).toHaveLength(code === 4401 ? 1 : 2);
    expect(acquire).toHaveBeenCalledTimes(code === 4409 ? 2 : 1);
    expect(watchCloseAction(code)).toBe(code === 4409 ? "reacquire" : code === 4401 ? "stop" : "backoff");
  });
});
