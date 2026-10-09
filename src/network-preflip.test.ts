import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { NetworkComms } from "./comms.ts";
import { commsDoctor, networkConfigPath, networkIdentityPath, readNetworkIdentities, type JoinFacts } from "./comms-network.ts";
import { rmSync } from "node:fs";
import { networkReceiptPath } from "./comms-fallback.ts";
import { decodeMachines, type AgentRow } from "./domain.ts";
import { projectOpen, projectStatus, projectUpdate } from "./ops.ts";
import { deliverOwnerItem } from "./owner-queue.ts";
import { Comms, Herdr, MusterEnv, Proc, liveProc, noEmitPaneClose, type CommsDelivery } from "./runtime.ts";
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
  const stdin: (string | null)[] = [];
  // Remote node probes: the fence probe and comms_doctor's join facts. Tests replace this.
  let remoteAnswer = (_line: string) => "";
  const machines = decodeMachines({ pennywise: { herdr: "pennywise", ssh: "pennywise", paths: {}, musterExtension: "/muster", workerWorktree: h.workerWorktree, env: {}, wrap: [], comms: { config: "/remote/network.json" } } });
  const run = <A, E, R extends Herdr | MusterEnv | Proc | Comms>(effect: Effect.Effect<A, E, R>) => runWith(h, effect.pipe(
    Effect.provideService(MusterEnv, { home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/muster", workerWorktree: h.workerWorktree, createId: () => "id", sleep: () => Effect.void, emitPaneClose: noEmitPaneClose, machines, remoteHerdr: () => Effect.succeed(remote.client()) }),
    // SSH is faked: the key copy reports "added", the public peer seed succeeds.
    Effect.provideService(Proc, { run: (command, args, opts) => command === "ssh"
      ? Effect.sync(() => { const line = args.at(-1)!; ssh.push(line); stdin.push(opts?.input ?? null); return { code: 0, stdout: line.includes("muster-key") ? "added\n" : remoteAnswer(line), stderr: "" }; })
      : liveProc.run(command, args, opts) }),
  ));
  const reply = (session = "owner-session", owner = "worker-session") => run(deliverOwnerItem({ owner, home: h.home, session, project: dir,
    item: { author: session, kind: "fyi", title: "go ahead", body: "line one\nline two", mention: owner }, comms, send: () => Effect.die("network mode never uses send") }));
  const receipts = () => readFileSync(networkReceiptPath(h.home), "utf8").trim().split("\n").map(line => JSON.parse(line) as { path: string; to: string });
  return { h, dir, row, pane, local: h.herdr, remote, relay, postOwner: networkSends, reply, receipts, ssh, stdin, run, answer: (fn: (line: string) => string) => { remoteAnswer = fn; } };
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
    expect(result.delivery.detail).toContain("worker has no mailbox reader yet (launched before comms: network); delivered via herdr-prompt; on current pi-muster it joins its mailbox within about a minute, otherwise restart the row");
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
    expect(result.delivery.detail).toContain("worker has no mailbox reader yet (launched before comms: network); delivered via herdr-prompt");
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

  it("project_update switching to network provisions every live row, local and remote, and pushes remote keys over stdin only", async () => {
    const f = await fixture();
    await runWith(f.h, mutate(f.dir, p => Effect.succeed([{ ...p, policy: { ...p.policy, comms: "intercom" as const }, agents: [...p.agents,
      { ...f.row, name: "far", sessionId: "far-session", machine: "pennywise", restore: { cwd: f.dir, argv: ["pi"], env: { MUSTER_COMMS: "intercom" } } },
      { ...f.row, name: "gone", sessionId: "gone-session", state: "closed" as const }] }, undefined] as const)));
    const result = await f.run(projectUpdate(f.dir, { policy: { comms: "network" } }));
    expect(result.notes.join("\n")).toContain("comms: network. Provisioned live rows; on current pi-muster each joins its mailbox within about a minute, older ones need a restart: worker: identity ready; far: identity ready, key pushed to pennywise.");
    expect(Object.keys(readNetworkIdentities(f.h.home)).sort()).toEqual(["far", "worker"]);
    // One key copy, for the remote row only. The leased key rides stdin; no ssh argument carries it.
    const copies = f.ssh.flatMap((line, index) => line.includes("muster-key") ? [index] : []);
    expect(copies).toHaveLength(1); expect(f.ssh[copies[0]!]).toContain("'copy' 'entry_far'");
    expect(f.stdin[copies[0]!]).toBe('{"did":"leased"}');
    expect(f.ssh.some(line => line.includes("leased"))).toBe(false);
    // The pre-flip reader learns its owner's session from the seeded peer cache, not a launch env it lacks.
    const seed = f.ssh.find(line => line.includes("seedNetworkPeers"))!;
    expect(seed).toContain(`"worker-session":"worker"`); expect(seed).toContain(`"far-session":"far"`); expect(seed).not.toContain("gone-session");
    const again = await f.run(projectUpdate(f.dir, { headline: "steady" }));
    expect(again.notes.join("\n")).not.toContain("Provisioned live rows");
    expect((await runWith(f.h, load(f.dir))).policy?.comms).toBe("network");
  });

  it("project_status act mints its owner's live rows that lack an identity; act: false and other owners' rows do not", async () => {
    const f = await fixture();
    await runWith(f.h, mutate(f.dir, p => Effect.succeed([{ ...p, agents: [...p.agents, { ...f.row, name: "theirs", sessionId: "theirs-session", owner: "another-owner", pane: null }] }, undefined] as const)));
    await f.run(projectStatus(f.dir, { act: false }));
    expect(readNetworkIdentities(f.h.home)).toEqual({});
    const status = await f.run(projectStatus(f.dir));
    expect(status.board).toContain("comms: worker: identity ready");
    expect(Object.keys(readNetworkIdentities(f.h.home))).toEqual(["worker"]);
  });

  it("a published fence ends the Herdr path: the row's reader takes network mail", async () => {
    const f = await fixture({ machine: "pennywise", comms: "intercom" });
    privateFile(networkIdentityPath(f.h.home), { worker: reference("worker") });
    f.answer(line => line.includes("readConsumerFence") ? "absent\n" : "");
    expect((await f.reply()).path).toBe("herdr-prompt");
    expect(f.postOwner).not.toHaveBeenCalled();
    f.answer(line => line.includes("readConsumerFence") ? "published\n" : "");
    const joined = await f.reply();
    expect(f.postOwner).toHaveBeenCalledOnce();
    expect(joined.delivery.detail).not.toContain("no mailbox reader");
    expect(prompts(f.remote)).toHaveLength(2); // The second is the owned remote row's failed-network Herdr fallback, not preflip.
  });
});

describe("comms_doctor", () => {
  const facts = (over: Partial<JoinFacts>): string => JSON.stringify({ agent: "worker", config: null, identity: true, did: "did:web:worker.example.invalid", key: true, session: true, fence: "absent", joined: true, reason: null, ...over });
  const doctor = (f: Awaited<ReturnType<typeof fixture>>, over: Partial<Parameters<typeof commsDoctor>[0]> = {}) =>
    f.run(commsDoctor({ home: f.h.home, dir: f.dir, session: "owner-session", row: "worker", remote: false, ...over }));

  it("the owner mints a local row that has no identity, then reports it joined with no reader yet", async () => {
    const f = await fixture();
    const report = await doctor(f);
    expect(report.fixes).toEqual(["fixed: identity minted"]);
    expect(report.joined).toBe(true);
    expect(report.verdict).toBe("joined, no reader yet: current pi-muster starts it within about a minute (longer while a predecessor's lease runs out); older code needs a restart");
    expect(report.checks.find(check => check.name === "identity cached on Flagg")).toMatchObject({ ok: true });
    expect(report.checks.find(check => check.name === "fence published")).toMatchObject({ ok: false, detail: "no reader yet" });
  });

  it("a non-owner gets a report only and fixes nothing", async () => {
    const f = await fixture();
    const report = await doctor(f, { session: "intruder-session" });
    expect(report.fixes).toEqual(["report only: session intruder-session does not own worker; its owner fixes"]);
    expect(report.verdict).toBe("not joined: no identity for worker on this machine");
    expect(readNetworkIdentities(f.h.home)).toEqual({});
  });

  it("names a missing config, and an explicit intercom policy as an opt-out", async () => {
    const f = await fixture();
    rmSync(networkConfigPath(f.h.home));
    const missing = await doctor(f, { fix: false });
    expect(missing.verdict).toContain("not joined: NetworkComms missing or invalid config");
    expect(missing.checks.find(check => check.name === "config readable on Flagg")).toMatchObject({ ok: false });
    expect(missing.fixes).toEqual(["fix: false; would mint and push the key"]);
    await runWith(f.h, mutate(f.dir, p => Effect.succeed([{ ...p, policy: { ...p.policy, comms: "intercom" as const } }, undefined] as const)));
    const out = await doctor(f);
    expect(out.verdict).toBe("not joined: project policy comms: intercom opts this project out");
    expect(out.fixes).toEqual(["no fix: project policy comms: intercom opts this project out"]);
  });

  it("the owner pushes a remote row's missing key over stdin, then the probe reports it joined", async () => {
    const f = await fixture({ machine: "pennywise", comms: "intercom" });
    privateFile(networkIdentityPath(f.h.home), { worker: reference("worker") });
    f.answer(line => line.includes("localJoinFacts")
      ? f.ssh.some(sent => sent.includes("muster-key")) ? facts({}) : facts({ key: false, joined: false, reason: "key entry_worker is not in this machine's secrets" })
      : "");
    const before = await doctor(f, { fix: false });
    expect(before.verdict).toBe("not joined: key entry_worker is not in this machine's secrets");
    expect(before.checks.find(check => check.name === "key on pennywise")).toMatchObject({ ok: false });
    const report = await doctor(f);
    expect(report.fixes).toEqual(["fixed: identity minted and key pushed to pennywise"]);
    expect(report.joined).toBe(true);
    expect(report.checks.find(check => check.name === "launch hint vs joined fact")?.detail).toBe("MUSTER_COMMS=intercom; joined: true (the joined fact wins over the hint)");
    const copy = f.ssh.findIndex(line => line.includes("muster-key"));
    expect(f.stdin[copy]).toBe('{"did":"leased"}'); expect(f.ssh.some(line => line.includes("leased"))).toBe(false);
  });

  it("reports an unbound session and a remote checkout too old to answer", async () => {
    const f = await fixture({ machine: "pennywise", comms: "intercom" });
    privateFile(networkIdentityPath(f.h.home), { worker: reference("worker") });
    f.answer(line => line.includes("localJoinFacts") ? facts({ session: false, joined: false, reason: "session worker-session is not bound to worker here; the owner pushes the binding with the key" }) : "");
    expect((await doctor(f, { fix: false })).verdict).toContain("session worker-session is not bound to worker here");
    f.answer(() => "SyntaxError: no export localJoinFacts");
    const old = await doctor(f, { fix: false });
    expect(old.verdict).toBe("unknown: probe of pennywise returned no join facts; its pi-muster predates comms_doctor");
    expect(old.joined).toBe(false);
  });

  it("on a remote machine it reports this process only and never fixes", async () => {
    const f = await fixture();
    const self = await doctor(f, { remote: true, row: undefined, self: { agent: "worker", session: "worker-session" } });
    expect(self.verdict).toBe("not joined: no identity for worker on this machine");
    expect(self.fixes[0]).toContain("report only");
    await expect(doctor(f, { remote: true, row: "boss", self: { agent: "worker", session: "worker-session" } })).rejects.toThrow("reports this process only");
  });
});
