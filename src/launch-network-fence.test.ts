import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { consumeNetworkMailbox, networkFencePath, networkIdentityPath, readConsumerFence, sendWithConsumerFence } from "./comms-network.ts";
import { MailboxClientError } from "./vendor/rat-king-mailbox-client/error.ts";
import { Main } from "./vendor/rat-king-lexicon/runtime.lease.ts";
import { Output } from "./vendor/rat-king-lexicon/mailbox.send.ts";

const did = "did:web:desk.example.invalid";
const lease = (generation: number) => Schema.decodeUnknownSync(Main)({ did, leaseId: generation === 1 ? "3jzfcijpj2z2b" : "3jzfcijpj2z2c", generation, expiresAt: "2026-10-07T00:00:00.000Z", harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: "desk-session" } });
const output = Schema.decodeUnknownSync(Output)(JSON.parse(readFileSync(new URL("./vendor/rat-king-fixtures/send.output.json", import.meta.url), "utf8")));
const mismatch = () => new MailboxClientError({ error: "LeaseMismatch", reason: "PRIVATE_BODY", status: 409 });
const home = () => mkdtempSync(join(tmpdir(), "launch-network-fence-"));
function privateFile(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function seed(root: string) {
  privateFile(networkIdentityPath(root), { desk: { did, secret: "entry_desk", document: { id: did, verificationMethod: ["atproto", "encryption"].map(key => ({ id: `${did}#${key}`, controller: did, publicKeyJwk: { kty: "EC", crv: "P-256", x: "public-x", y: "public-y" } })), authentication: [`${did}#atproto`], keyAgreement: [`${did}#encryption`] } } });
}

// A fresh Node process has no consumer registry. Its fake mailbox enforces checkSend.
async function detachedSend(root: string, live?: ReturnType<typeof lease>) {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import {Effect} from 'effect';
    import {sendWithConsumerFence} from ${JSON.stringify(new URL("./comms-network.ts", import.meta.url).href)};
    import {MailboxClientError} from ${JSON.stringify(new URL("./vendor/rat-king-mailbox-client/error.ts", import.meta.url).href)};
    const [home,did,raw]=process.argv.slice(1); const live=JSON.parse(raw); let seen;
    const result=await Effect.runPromise(sendWithConsumerFence({home,did,send:opts=>Effect.suspend(()=>{
      seen=opts?.fence;
      if(live && (!seen || seen.did!==live.did || seen.leaseId!==live.leaseId || seen.generation!==live.generation))
        return Effect.fail(new MailboxClientError({error:'LeaseMismatch',reason:'private',status:409}));
      return Effect.succeed({status:'accepted'});
    })}));
    console.log(JSON.stringify({result,seen:seen??null}));
  `, root, did, JSON.stringify(live ?? null)], { timeout: 10_000 });
  return JSON.parse(stdout);
}

function consumer(root: string, watch: Parameters<typeof consumeNetworkMailbox>[0]["mailbox"]["watch"]) {
  seed(root);
  const release = { calls: 0 }; let acquisitions = 0;
  const run = consumeNetworkMailbox({ home: root, agent: "desk", session: "desk-session", mailbox: {
    lease: { acquire: () => Effect.sync(() => lease(++acquisitions)), renew: () => Effect.succeed(lease(1)), resolve: () => Effect.succeed(lease(1)), release: () => Effect.sync(() => { release.calls++; }) },
    watch, open: () => Effect.die("unexpected envelope"), deliver: () => Effect.die("unexpected delivery"), ack: () => Effect.die("unexpected ack"),
  }, senderAgent: () => Effect.succeed("worker"), receive: () => Effect.void });
  return { run, release };
}

describe("detached launch borrows the boss consumer fence", () => {
  it("sends from a separate process while the boss holds its lease, and unfenced after release", async () => {
    const root = home();
    const c = consumer(root, () => Stream.fromEffect(Effect.tryPromise({ try: async () => {
      expect(statSync(networkFencePath(root, did)).mode & 0o777).toBe(0o600);
      expect((await detachedSend(root, lease(1))).seen).toMatchObject({ leaseId: lease(1).leaseId, generation: 1 });
      return { events: [], throughSeq: 1 };
    }, catch: () => new MailboxClientError({ reason: "detached sender test failed" }) })));
    await Effect.runPromise(c.run);
    expect(c.release.calls).toBe(1);
    expect(existsSync(networkFencePath(root, did))).toBe(false);
    expect((await detachedSend(root)).seen).toBeNull();
  }, 15_000);

  it("publishes the replacement fence on consumer reacquisition", async () => {
    const root = home(); const seen: number[] = [];
    const c = consumer(root, (_seq, fence) => Stream.fromEffect(Effect.suspend(() => {
      seen.push(readConsumerFence(root, did)!.generation);
      if (fence.generation === 1) return Effect.fail(mismatch());
      return Effect.succeed({ events: [], throughSeq: 1 });
    })));
    await Effect.runPromise(c.run);
    expect(seen).toEqual([1, 2]);
    expect(c.release.calls).toBe(1);
    expect(readConsumerFence(root, did)).toBeUndefined();
  });

  it("releases the acquired lease if publishing fails", async () => {
    const root = home(); const path = networkFencePath(root, did); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.lock`, "", { mode: 0o600 });
    const c = consumer(root, () => Stream.die("watch must not start"));
    await expect(Effect.runPromise(c.run)).rejects.toThrow("consumer failed");
    expect(c.release.calls).toBe(1);
    expect(readConsumerFence(root, did)).toBeUndefined();
  });

  it("re-reads a stale fence exactly once when checkSend refuses it", async () => {
    const root = home(); const seen: Array<number | undefined> = [];
    privateFile(networkFencePath(root, did), lease(1));
    await Effect.runPromise(sendWithConsumerFence({ home: root, did, send: opts => Effect.suspend(() => {
      seen.push(opts?.fence?.generation);
      if (opts?.fence?.generation !== 2) { privateFile(networkFencePath(root, did), lease(2)); return Effect.fail(mismatch()); }
      return Effect.succeed(output);
    }) }));
    expect(seen).toEqual([1, 2]);
  });

  it("does not keep retrying a stale fence", async () => {
    const root = home(); let sends = 0; privateFile(networkFencePath(root, did), lease(1));
    await expect(Effect.runPromise(sendWithConsumerFence({ home: root, did, send: () => { sends++; return Effect.fail(mismatch()); } }))).rejects.toThrow();
    expect(sends).toBe(2);
  });

  it("names an old boss with no published fence, without acquiring", async () => {
    const root = home(); let sends = 0;
    await expect(Effect.runPromise(sendWithConsumerFence({ home: root, did, send: opts => {
      expect(opts).toBeUndefined(); sends++; return Effect.fail(mismatch());
    } }))).rejects.toThrow("boss consumer has no published fence; restart the boss onto current code");
    expect(sends).toBe(2);
  });

  it("does not retry authentication failures", async () => {
    const root = home(); let sends = 0;
    await expect(Effect.runPromise(sendWithConsumerFence({ home: root, did, send: () => {
      sends++; return Effect.fail(new MailboxClientError({ error: "AuthRequired", reason: "private", status: 401 }));
    } }))).rejects.toThrow();
    expect(sends).toBe(1);
  });

  it.each(["mode", "symlink", "wrong-did", "invalid-generation"])("rejects %s snapshots before sending", async kind => {
    const root = home(); const path = networkFencePath(root, did);
    privateFile(path, { ...lease(1), ...(kind === "wrong-did" ? { did: "did:web:other.invalid" } : {}), ...(kind === "invalid-generation" ? { generation: -1 } : {}) });
    if (kind === "mode") chmodSync(path, 0o644);
    if (kind === "symlink") {
      const other = home(); const linked = networkFencePath(other, did); mkdirSync(dirname(linked), { recursive: true }); symlinkSync(path, linked);
      expect(() => readConsumerFence(other, did)).toThrow("invalid consumer fence");
    } else expect(() => readConsumerFence(root, did)).toThrow("invalid consumer fence");
  });

  it("an old finalizer preserves a newer published fence", async () => {
    const root = home();
    const c = consumer(root, () => Stream.fromEffect(Effect.sync(() => {
      privateFile(networkFencePath(root, did), lease(2)); return { events: [], throughSeq: 1 };
    })));
    await Effect.runPromise(c.run);
    expect(c.release.calls).toBe(1);
    expect(readConsumerFence(root, did)?.generation).toBe(2);
  });
});
