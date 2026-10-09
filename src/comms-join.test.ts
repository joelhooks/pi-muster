import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createComms } from "./comms.ts";
import { localJoinFacts, networkConfigPath, readNetworkIdentities, seedNetworkIdentities, seedNetworkPeers, type PrivateCommand } from "./comms-network.ts";
import type { AgentRow } from "./domain.ts";
import { projectOpen } from "./ops.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { mutate } from "./store.ts";
import { harness, runWith } from "./test-support.ts";

const config = { endpoint: "https://mailbox.example.invalid", serviceDid: "did:web:mailbox.example.invalid", provisionWrapper: "/private/wrapper", didTemplate: "did:web:{agent}.example.invalid", secretsCommand: "/private/secrets" };
const reference = (agent: string) => {
  const did = `did:web:${agent}.example.invalid`;
  return { did, secret: `entry_${agent}`, document: { id: did, verificationMethod: [], authentication: [], keyAgreement: [] } };
};
const privateFile = (path: string, data: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data), { mode: 0o600 }); };
const events = { emit() {}, on() {} };

/** The secrets CLI lists names only. `held` is what this machine's store holds right now. */
const secrets = (held: Set<string>, calls: string[] = []): PrivateCommand => async (_file, args) => {
  calls.push(args.join(" "));
  if (args.includes("list")) return JSON.stringify([...held].map(name => ({ name })), null, 1);
  throw new Error("unexpected private command");
};

describe("a pre-flip remote row joins the mailbox with no restart", () => {
  it("follows the joined fact over MUSTER_COMMS=intercom once its key, identity, binding and config appear", async () => {
    const home = mkdtempSync(join(tmpdir(), "join-remote-"));
    const held = new Set<string>(); const calls: string[] = [];
    const comms = createComms({ events, createId: () => "id", home, projectDir: join(home, "no-catalog"), adapterEnv: () => "intercom", remote: true, run: secrets(held, calls),
      networkSender: () => ({ agent: "worker", session: "worker-session" }) });
    expect(await Effect.runPromise(comms.mode!())).toBe("intercom");
    expect(calls).toEqual([]); // No identity yet: no secrets process.
    // What Flagg's key push leaves on this machine.
    privateFile(networkConfigPath(home), config);
    seedNetworkIdentities(home, { worker: reference("worker"), boss: reference("boss") });
    seedNetworkPeers(home, { "worker-session": "worker", "owner-session": "boss" });
    held.add("entry_worker");
    expect(await Effect.runPromise(comms.mode!())).toBe("network");
    expect(calls).toEqual(["--no-update-check list"]);
    expect(await Effect.runPromise(comms.mode!())).toBe("network");
    expect(calls).toHaveLength(1); // A join holds for the process.
  });

  it("stays on intercom while the key is absent or another session holds the binding", async () => {
    const home = mkdtempSync(join(tmpdir(), "join-remote-miss-"));
    privateFile(networkConfigPath(home), config);
    seedNetworkIdentities(home, { worker: reference("worker") });
    seedNetworkPeers(home, { "worker-session": "worker" });
    const held = new Set<string>();
    const facts = (session: string) => localJoinFacts({ home, agent: "worker", session, remote: true, run: secrets(held) });
    expect(await facts("worker-session")).toMatchObject({ joined: false, key: false, reason: "key entry_worker is not in this machine's secrets" });
    held.add("entry_worker");
    expect(await facts("forked-session")).toMatchObject({ joined: false, session: false });
    expect((await facts("forked-session")).reason).toContain("session forked-session is not bound to worker here");
    expect(await facts("worker-session")).toMatchObject({ joined: true, reason: null, fence: "absent" });
    const comms = createComms({ events, createId: () => "id", home, projectDir: join(home, "no-catalog"), adapterEnv: () => "intercom", remote: true, run: secrets(new Set()),
      networkSender: () => ({ agent: "worker", session: "worker-session" }) });
    expect(await Effect.runPromise(comms.mode!())).toBe("intercom");
  });

  it("the 30 s owner-feed tick starts the reader in-process once the row joins", async () => {
    const home = mkdtempSync(join(tmpdir(), "join-tick-"));
    const held = new Set<string>();
    const comms = createComms({ events, createId: () => "id", home, projectDir: join(home, "no-catalog"), adapterEnv: () => "intercom", remote: true, run: secrets(held),
      networkSender: () => ({ agent: "worker", session: "worker-session" }) });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage: vi.fn(), sendUserMessage() {} };
    const ctx = { isIdle: () => false, sessionManager: { getSessionId: () => "worker-session", getBranch: () => [] } };
    const consume = vi.fn((_ctx: unknown, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener("abort", () => resolve())));
    registerOwnerFeed(pi as never, { HOME: home, MUSTER_COMMS: "intercom" }, { mode: () => Effect.runPromise(comms.mode!()), consume }, async () => false);
    vi.useFakeTimers();
    try {
      handlers.get("session_start")!({}, ctx);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(consume).not.toHaveBeenCalled();
      privateFile(networkConfigPath(home), config);
      seedNetworkIdentities(home, { worker: reference("worker") });
      seedNetworkPeers(home, { "worker-session": "worker" });
      held.add("entry_worker");
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(consume).toHaveBeenCalledOnce());
      expect(pi.sendMessage).not.toHaveBeenCalled();
    } finally { await handlers.get("session_shutdown")!(); vi.useRealTimers(); }
  });
});

/** Flagg: an owner and a worker in one catalog. The worker has no identity. */
async function flagg(policy: "network" | "intercom" = "network", provision: "ok" | "fail" = "ok") {
  const h = harness();
  const dir = join(h.home, "alpha"); mkdirSync(dir, { recursive: true });
  await runWith(h, projectOpen({ dir, slug: "alpha", outcome: "route", reviewTrigger: "review", nextAction: "send", ephemeral: true, createSpace: true }));
  const row = (name: string, sessionId: string): AgentRow => ({ name, role: "worker", lane: "alpha", machine: "local", cwd: dir, clone: null, side: null, sessionId, pane: null, state: "running",
    profile: { label: name, model: "sol", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: null },
    sessionFile: null, parentSessionFile: null, owner: "owner-session", brief: null, delivery: "proven", restarts: 0, restore: null, createdAt: h.now.toISOString(), updatedAt: h.now.toISOString() });
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, policy: { ...p.policy, comms: policy }, agents: [row("boss", "owner-session"), row("worker", "worker-session")] }, undefined] as const)));
  const wrapper = join(h.root, "bin/provision"); mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, provision === "fail" ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nprintf '{"did":"%s","secret":"entry_%s","document":{"id":"%s","verificationMethod":[],"authentication":[],"keyAgreement":[]}}' "$5" "$3" "$5"\n`); chmodSync(wrapper, 0o755);
  privateFile(networkConfigPath(h.home), { ...config, provisionWrapper: wrapper });
  return { h, dir };
}

describe("selection on Flagg", () => {
  it("a joined fact beats an intercom launch hint, and an explicit intercom policy still opts the project out", async () => {
    const { h, dir } = await flagg();
    seedNetworkIdentities(h.home, { worker: reference("worker") });
    const comms = () => createComms({ events, createId: () => "id", home: h.home, projectDir: dir, adapterEnv: () => "intercom", networkSender: () => ({ agent: "worker", session: "worker-session" }) });
    expect(await Effect.runPromise(comms().mode!())).toBe("network");
    await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, policy: { ...p.policy, comms: "intercom" as const } }, undefined] as const)));
    expect(await Effect.runPromise(comms().mode!())).toBe("intercom");
  });
});

describe("a send to an unprovisioned row", () => {
  it("mints the row on Flagg before the first send, never the bare refusal", async () => {
    const { h, dir } = await flagg();
    const order: string[] = [];
    const run: PrivateCommand = async (file, args) => {
      order.push(`${args[0]} ${args[2] ?? ""}`.trim());
      if (args[0] === "provision") return JSON.stringify(reference(args[2]!));
      throw new Error("lease refused in tests");
    };
    const comms = createComms({ events, createId: () => "id", home: h.home, projectDir: dir, adapterEnv: () => undefined, followProjectPolicy: true, run,
      networkSender: () => ({ agent: "boss", session: "owner-session" }) });
    const sent = await runWith(h, comms.send("alpha/worker", "hello"));
    expect(sent.detail).not.toContain("provision it first");
    expect(readNetworkIdentities(h.home).worker?.did).toBe("did:web:worker.example.invalid");
    // The recipient's mint finished before the sender's mailbox opened.
    expect(order.indexOf("provision worker")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("provision worker")).toBeLessThan(order.findIndex(line => line.startsWith("lease")));
  });

  it("fails clearly and sends nothing when the mint fails", async () => {
    const { h, dir } = await flagg("network", "fail");
    seedNetworkIdentities(h.home, { boss: reference("boss") });
    const run = vi.fn<PrivateCommand>(async () => { throw new Error("refused"); });
    const comms = createComms({ events, createId: () => "id", home: h.home, projectDir: dir, adapterEnv: () => undefined, followProjectPolicy: true, run,
      networkSender: () => ({ agent: "boss", session: "owner-session" }) });
    const sent = await runWith(h, comms.send("alpha/worker", "hello"));
    expect(sent.status).toBe("failed");
    expect(sent.detail).toContain("could not mint worker before the first send");
    expect(sent.detail).toContain("nothing sent, no intercom fallback");
    expect(run.mock.calls.some(([, args]) => args[0] === "lease")).toBe(false);
  });

  it("a remote process never mints", async () => {
    const { h, dir } = await flagg();
    seedNetworkIdentities(h.home, { boss: reference("boss") });
    const run = vi.fn<PrivateCommand>(async () => { throw new Error("refused"); });
    const comms = createComms({ events, createId: () => "id", home: h.home, projectDir: dir, adapterEnv: () => "network", remote: true, run,
      networkSender: () => ({ agent: "boss", session: "owner-session" }) });
    const sent = await runWith(h, comms.send("alpha/worker", "hello"));
    expect(sent.status).toBe("failed");
    expect(run.mock.calls.some(([, args]) => args[0] === "provision")).toBe(false);
    expect(readNetworkIdentities(h.home).worker).toBeUndefined();
  });
});
