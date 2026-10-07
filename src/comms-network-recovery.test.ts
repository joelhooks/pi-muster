import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeNetworkMailbox, networkFencePath, networkIdentityPath, readConsumerFence } from "./comms-network.ts";
import { MailboxClientError } from "./vendor/rat-king-mailbox-client/error.ts";
import { Main } from "./vendor/rat-king-lexicon/runtime.lease.ts";

const did = "did:web:desk.example.invalid";
const session = "desk-session";
const start = Date.parse("2026-10-07T12:00:00.000Z");
const privateFile = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data), { mode: 0o600 }); };
const realImmediate = setImmediate;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => realImmediate(resolve)); };
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };
afterEach(() => vi.useRealTimers());

/** Stateful pinned-server contract: acquire refuses even our own live lease; expiry hides resolve. */
function authority() {
  const home = mkdtempSync(join(tmpdir(), "network-recovery-"));
  privateFile(networkIdentityPath(home), { desk: { did, secret: "entry_desk", document: { id: did,
    verificationMethod: ["atproto", "encryption"].map(key => ({ id: `${did}#${key}`, controller: did, publicKeyJwk: { kty: "EC", crv: "P-256", x: "public-x", y: "public-y" } })), authentication: [`${did}#atproto`], keyAgreement: [`${did}#encryption`] } } });
  let current: Schema.Schema.Type<typeof Main> | undefined;
  let generation = 0;
  let down: "transport" | "5xx" | "timeout" | undefined;
  const unavailable = <A>(work: () => A) => down === "timeout" ? Effect.never : down
    ? Effect.fail(new MailboxClientError({ reason: "private transport detail", ...(down === "5xx" ? { error: "Unavailable", status: 503 } : {}) }))
    : Effect.try({ try: work, catch: error => error as MailboxClientError });
  const live = () => {
    if (!current || Date.parse(current.expiresAt) <= Date.now()) throw new MailboxClientError({ error: "LeaseNotFound", reason: "expired", status: 404 });
    return current;
  };
  const lease = {
    acquire: vi.fn((input: { did: string; harness: unknown; expiresAt: string }) => unavailable(() => {
      if (current && Date.parse(current.expiresAt) > Date.now()) throw new MailboxClientError({ error: "LeaseHeld", reason: "held", status: 409 });
      current = Schema.decodeUnknownSync(Main)({ ...input, generation: ++generation, leaseId: generation === 1 ? "3jzfcijpj2z2b" : "3jzfcijpj2z2c", expiresAt: new Date(Math.min(Date.parse(input.expiresAt), Date.now() + 300_000)).toISOString() });
      return current;
    })),
    resolve: vi.fn(() => unavailable(live)),
    renew: vi.fn((input: { leaseId: string; generation: number; expiresAt: string }) => unavailable(() => {
      const held = live();
      if (held.generation !== input.generation || held.leaseId !== input.leaseId) throw new MailboxClientError({ error: "StaleGeneration", reason: "fenced", status: 409 });
      current = Schema.decodeUnknownSync(Main)({ ...held, expiresAt: new Date(Math.min(Date.parse(input.expiresAt), Date.now() + 300_000)).toISOString() }); return current;
    })),
    release: vi.fn((input: { generation: number }) => unavailable(() => {
      if (current?.generation === input.generation) current = Schema.decodeUnknownSync(Main)({ ...current, expiresAt: new Date(Date.now()).toISOString() });
    })),
  };
  const notices: string[] = [];
  const options = { home, agent: "desk", session, senderAgent: () => Effect.succeed("worker"), receive: (payload: Parameters<Parameters<typeof consumeNetworkMailbox>[0]["receive"]>[0]) => Effect.sync(() => { if (payload.type === "message") notices.push(payload.body); }) };
  return { lease, options, notices, outage: (value: typeof down) => { down = value; }, holder: () => current,
    takeover: () => { current = Schema.decodeUnknownSync(Main)({ ...live(), generation: ++generation, harness: { $type: "sh.mschf.ratking.runtime.lease#pi", sessionId: "foreign-session" } }); } };
}
const unused = { open: () => Effect.die("unexpected envelope"), deliver: () => Effect.die("unexpected delivery"), ack: () => Effect.die("unexpected ack") };

describe("pinned-client recovery policy with controlled time", () => {
  it.each(["transport", "5xx", "timeout"] as const)("survives %s longer than a lease and reacquires without restarting", async outage => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const a = authority();
    const watch = vi.fn((_after: number, fence: { generation: number }) => fence.generation === 1 ? Stream.never : Stream.succeed({ events: [], throughSeq: 7 }));
    const run = Effect.runPromise(consumeNetworkMailbox({ ...a.options, mailbox: { ...unused, lease: a.lease, watch } }));
    await vi.waitFor(() => expect(readConsumerFence(a.options.home, did)?.generation).toBe(1));
    a.outage(outage);
    for (let i = 0; i < 75; i++) await advance(10_000);
    expect(a.lease.renew.mock.calls.length).toBeGreaterThan(1);
    expect(existsSync(networkFencePath(a.options.home, did))).toBe(false);
    expect(a.notices).toHaveLength(1); expect(a.notices[0]).toContain("degraded");
    a.outage(undefined);
    for (let i = 0; i < 10 && a.lease.acquire.mock.calls.length < 2; i++) await advance(10_000);
    await run;
    expect(watch.mock.calls.map(call => call[1].generation)).toEqual([1, 2]);
    expect(a.notices).toHaveLength(2); expect(a.notices[1]).toContain("recovered");
    expect(a.holder()?.generation).toBe(2); expect(Date.parse(a.holder()!.expiresAt)).toBeLessThanOrEqual(Date.now());
  });

  it("resolves and publishes an own lease when acquire was accepted before its transport failed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const a = authority();
    const acquire = vi.fn((input: Parameters<typeof a.lease.acquire>[0]) => a.lease.acquire(input).pipe(
      Effect.flatMap(() => Effect.fail(new MailboxClientError({ reason: "response lost after acceptance" })))));
    const watch = vi.fn(() => {
      expect(readConsumerFence(a.options.home, did)?.generation).toBe(1);
      return Stream.succeed({ events: [], throughSeq: 1 });
    });
    const run = Effect.runPromise(consumeNetworkMailbox({ ...a.options, mailbox: { ...unused, lease: { ...a.lease, acquire }, watch } }));
    await vi.waitFor(() => expect(a.notices).toHaveLength(1)); await advance(5_000); await run;
    expect(acquire).toHaveBeenCalledOnce(); expect(watch).toHaveBeenCalledOnce(); expect(a.notices).toHaveLength(2);
  });

  it("retries watch transport failures with the same live lease, not resolve then acquire", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const a = authority(); let attempts = 0;
    const watch = vi.fn(() => ++attempts < 4 ? Stream.fail(new MailboxClientError({ reason: "connection refused" })) : Stream.succeed({ events: [], throughSeq: 2 }));
    const run = Effect.runPromise(consumeNetworkMailbox({ ...a.options, mailbox: { ...unused, lease: a.lease, watch } }));
    await vi.waitFor(() => expect(a.notices).toHaveLength(1));
    for (let i = 0; i < 10 && attempts < 4; i++) await advance(5_000);
    await run;
    expect(a.lease.acquire).toHaveBeenCalledOnce(); expect(a.lease.resolve).toHaveBeenCalledTimes(3);
    expect(a.notices).toHaveLength(2);
  });

  it.each(["LeaseTakenOver", "StaleGeneration", "AuthRequired"])("%s stays final, even with a 503 status", async error => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const a = authority();
    await expect(Effect.runPromise(consumeNetworkMailbox({ ...a.options, mailbox: { ...unused, lease: a.lease,
      watch: () => Stream.fail(new MailboxClientError({ error, reason: "private", status: 503 })) } }))).rejects.toThrow(error === "AuthRequired" ? "authentication failed" : error);
    expect(a.lease.acquire).toHaveBeenCalledOnce(); expect(a.notices).toEqual([]);
  });

  it("a foreign holder resolved after disconnect stays final and is never acquired over", async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const a = authority();
    const watch = () => Stream.fromEffect(Effect.sync(() => a.takeover()).pipe(Effect.flatMap(() => Effect.fail(new MailboxClientError({ error: "LeaseMismatch", reason: "changed" })) )));
    const run = Effect.runPromise(consumeNetworkMailbox({ ...a.options, mailbox: { ...unused, lease: a.lease, watch } })).then(() => "completed", error => String(error));
    await vi.waitFor(() => expect(a.lease.acquire).toHaveBeenCalledOnce()); await advance(1_000);
    expect(await run).toContain("LeaseTakenOver"); expect(a.lease.acquire).toHaveBeenCalledOnce(); expect(a.holder()?.harness.sessionId).toBe("foreign-session");
  });
});
