import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { consumeNetworkMailbox, createNetworkComms, networkConfigPath, networkIdentityPath } from "./comms-network.ts";
import type { LeaseFence, SendOptions } from "./vendor/rat-king-mailbox-client/index.ts";
import { MailboxClientError } from "./vendor/rat-king-mailbox-client/error.ts";
import { Main } from "./vendor/rat-king-lexicon/runtime.lease.ts";
import { Output } from "./vendor/rat-king-lexicon/mailbox.send.ts";

function reference(agent: string) {
  const did = `did:web:${agent}.example.invalid`;
  return { did, secret: `entry_${agent}`, document: { id: did, verificationMethod: ["atproto", "encryption"].map(key => ({ id: `${did}#${key}`, controller: did, publicKeyJwk: { kty: "EC", crv: "P-256", x: "public-x", y: "public-y" } })), authentication: [`${did}#atproto`], keyAgreement: [`${did}#encryption`] } };
}
function privateFile(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
const output = Schema.decodeUnknownSync(Output)(JSON.parse(readFileSync(new URL("./vendor/rat-king-fixtures/send.output.json", import.meta.url), "utf8")));
const lease = (generation: number) => Schema.decodeUnknownSync(Main)({ did: reference("desk").did, leaseId: generation === 1 ? "3jzfcijpj2z2b" : "3jzfcijpj2z2c", generation, expiresAt: "2026-10-07T00:00:00.000Z", harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: "desk-session" } });

async function withMailbox(test: (service: ReturnType<typeof createNetworkComms>, home: string, send: (to: string, body: string, opts?: SendOptions) => Effect.Effect<typeof output, MailboxClientError>) => Promise<void>, handler: (opts?: SendOptions) => Effect.Effect<typeof output, MailboxClientError>) {
  const home = mkdtempSync(join(tmpdir(), "network-fence-"));
  privateFile(networkConfigPath(home), { endpoint: "https://mailbox.example.invalid", serviceDid: "did:web:mailbox.example.invalid", provisionWrapper: "/private/wrapper", didTemplate: "did:web:{agent}.example.invalid" });
  privateFile(networkIdentityPath(home), { desk: reference("desk"), worker: reference("worker") });
  const send = (_to: string, _body: string, opts?: SendOptions) => handler(opts);
  class FakeMailbox extends Context.Service<FakeMailbox, { send: typeof send }>()("test/network-fence") {}
  vi.doMock("./vendor/rat-king-mailbox-client/index.ts", () => ({ Identity: Schema.Struct({ did: Schema.String }), RatKingMailbox: FakeMailbox, layer: () => Layer.succeed(FakeMailbox)({ send }) }));
  try {
    await test(createNetworkComms({ home, sender: () => ({ agent: "desk", session: "desk-session" }), recipient: () => Effect.succeed("worker"), run: async () => JSON.stringify({ did: reference("desk").did }) }), home, send);
  } finally { vi.doUnmock("./vendor/rat-king-mailbox-client/index.ts"); }
}

describe("same-process consumer send fence", () => {
  it("borrows the live fence, refreshes it on 409 reacquisition, then sends unfenced after release", async () => {
    let live: LeaseFence | undefined; const seen: Array<LeaseFence | undefined> = []; let acquisitions = 0;
    await withMailbox(async (service, home) => {
      const mailbox = {
        lease: { acquire: () => Effect.sync(() => { live = lease(++acquisitions); return lease(acquisitions); }), renew: () => Effect.succeed(lease(acquisitions)), resolve: () => Effect.succeed(lease(acquisitions)), release: () => Effect.sync(() => { live = undefined; }) },
        watch: (_seq: number, fence: LeaseFence) => Stream.fromEffect(Effect.gen(function* () {
          expect((yield* service.send("worker-session", "brief")).status).toBe("accepted");
          if (fence.generation === 1) return yield* Effect.fail(new MailboxClientError({ error: "LeaseMismatch", reason: "PRIVATE_BODY", status: 409 }));
          return { events: [], throughSeq: 2 };
        })),
        open: () => Effect.die("no envelope expected"), deliver: () => Effect.die("no delivery expected"), ack: () => Effect.die("no ack expected"),
      };
      await Effect.runPromise(consumeNetworkMailbox({ home, agent: "desk", session: "desk-session", mailbox, senderAgent: () => Effect.succeed("worker"), receive: () => Effect.void }));
      expect((await Effect.runPromise(service.send("worker-session", "after release"))).status).toBe("accepted");
      expect(acquisitions).toBe(2);
      expect(seen.map(fence => fence?.generation)).toEqual([1, 2, undefined]);
      expect(seen[0]?.leaseId).not.toBe(seen[1]?.leaseId);
    }, opts => Effect.suspend(() => {
      seen.push(opts?.fence);
      if (live && (!opts?.fence || opts.fence.did !== live.did || opts.fence.leaseId !== live.leaseId || opts.fence.generation !== live.generation)) return Effect.fail(new MailboxClientError({ error: "LeaseMismatch", reason: "PRIVATE_BODY", status: 409 }));
      return Effect.succeed(output);
    }));
  });
  it.each(["LeaseMismatch", "AuthRequired", "PRIVATE_SECRET_SENTINEL"])("unfenced failure %s exposes only a known protocol code", async code => {
    const seen = vi.fn();
    await withMailbox(async service => {
      const result = await Effect.runPromise(service.send("worker-session", "brief"));
      expect(result.status).toBe("failed"); expect(result.detail).not.toContain("PRIVATE_BODY"); expect(result.detail).not.toContain("PRIVATE_SECRET_SENTINEL");
      if (code !== "PRIVATE_SECRET_SENTINEL") expect(result.detail).toContain(code);
      if (code === "LeaseMismatch") expect(result.detail).toContain("sender lease held elsewhere (another process with this identity)");
      expect(seen).toHaveBeenCalledWith(undefined);
    }, opts => { seen(opts); return Effect.fail(new MailboxClientError({ error: code, reason: "PRIVATE_BODY", status: 409 })); });
  });
});
