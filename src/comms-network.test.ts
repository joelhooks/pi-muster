import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect, Schema, Stream } from "effect";
import type { Socket } from "effect/socket";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createComms } from "./comms.ts";
import { createNetworkComms, networkConfigPath, networkIdentityPath, networkRecipient, openNetworkMailbox, provisionNetworkAgent, readNetworkConfig, readNetworkIdentities, watchCloseAction, watchNetworkMailbox } from "./comms-network.ts";
import { decodeCommsIdentityReference } from "./domain.ts";

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
    privateFile(`${networkIdentityPath(root)}.lock`, {});
    await expect(Effect.runPromise(provisionNetworkAgent({ home: root, agent: "worker" }))).rejects.toThrow("cache busy: worker");
    expect(readNetworkIdentities(root).desk).toEqual(provision());
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

class FakeSocket implements Socket.WebSocketLike {
  readonly readyState = 1;
  readonly listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();
  constructor(readonly code: number) {}
  addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: Socket.WebSocketEvent) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  close() {}
  send(data: string | Uint8Array<ArrayBuffer>) {
    expect(typeof data === "string" && JSON.parse(data).$type).toBe("sh.mschf.ratking.mailbox.subscribe#auth");
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
    const stream = watchNetworkMailbox({ mailbox: { watch: (seq, fence) => watch({ ...config, identity, documents: [] }, () => Effect.succeed({ events: [], throughSeq: seq }), seq, fence) }, acquire, afterSeq: 0 });
    const result = await Effect.runPromiseExit(Stream.runDrain(stream).pipe(Effect.provideService(WebSocketPort, port), Effect.timeout("3 seconds")));
    expect(JSON.stringify(result)).toContain("AuthRequired");
    expect(connections).toHaveLength(code === 4401 ? 1 : 2);
    expect(acquire).toHaveBeenCalledTimes(code === 4409 ? 2 : 1);
    expect(watchCloseAction(code)).toBe(code === 4409 ? "reacquire" : code === 4401 ? "stop" : "backoff");
  });
});
