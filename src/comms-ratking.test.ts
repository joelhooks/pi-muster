import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentEnv } from "./argv.ts";
import { createComms, remoteCommsEnvironment, selectComms } from "./comms.ts";
import { networkReceiptPath } from "./comms-fallback.ts";
import { RATKING_MESSAGE, RATKING_SEND, RATKING_SEND_RESULT, RatkingComms, ownerName, ownerSelfName, ratkingInbound, ratkingLoaded, ratkingSend, ratkingTarget } from "./comms-ratking.ts";
import { decodePolicy, type AgentRow, type Project } from "./domain.ts";
import muster from "./extension-main.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { appendOwnerItem, deliverOwnerItem, readOwnerQueue } from "./owner-queue.ts";
import { load } from "./store.ts";
import { harness, runWith } from "./test-support.ts";

const saved = { ...process.env };
beforeEach(() => { for (const key of Object.keys(process.env)) if (key.startsWith("MUSTER_") || key.startsWith("RATKING_")) delete process.env[key]; });
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const row = (fields: Partial<AgentRow>) => ({ name: "w", sessionId: "s", owner: "o", state: "running", ...fields }) as AgentRow;
const catalog = (slug: string, agents: AgentRow[]) => ({ slug, agents }) as unknown as Project;

/** pi-ratking's half of the events contract: answers each send with the scripted result. */
function fakeRatking(result: (request: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const events = createEventBus();
  const requests: Array<Record<string, unknown>> = [];
  events.on(RATKING_SEND, data => {
    const request = data as Record<string, unknown>;
    requests.push(request);
    const answer = result(request);
    if (answer) queueMicrotask(() => events.emit(RATKING_SEND_RESULT, { requestId: request.requestId, ...answer }));
  });
  return { events, requests };
}
let ids = 0;
const createId = () => `id-${++ids}`;

describe("names", () => {
  it("every launched row gets RATKING_NAME <project>/<row>, and its owner's recorded name", () => {
    const env = agentEnv({ slug: "pilot", dir: "/p" } as Project, { ...row({ name: "worker", owner: "boss", ownerName: "titan" }), profile: { env: {} }, lane: "work", role: "worker" } as AgentRow);
    expect(env.RATKING_NAME).toBe("pilot/worker");
    expect(env.MUSTER_OWNER_NAME).toBe("titan");
  });

  it("a launch writes RATKING_NAME into the launcher, and records a rowless owner's own name", async () => {
    process.env.RATKING_NAME = "titan";
    const h = harness(); const dir = join(h.home, "project"); mkdirSync(dir, { recursive: true });
    await runWith(h, projectOpen({ dir, slug: "pilot", outcome: "names", reviewTrigger: "review", nextAction: "launch", ephemeral: true, createSpace: true }));
    await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "names", repo: dir }));
    await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, noSkills: true }));
    const script = h.herdr.launcherScripts.at(-1) ?? "";
    expect(script).toContain("RATKING_NAME='pilot/worker'");
    expect(script).toContain("MUSTER_OWNER_NAME='titan'");
    expect((await runWith(h, load(dir))).agents.find(agent => agent.name === "worker")?.ownerName).toBe("titan");
  });

  it("resolves a row owner, a rowless owner and an aliased owner", () => {
    const catalogs = [catalog("muster", [row({ name: "desk", sessionId: "desk-session" }), row({ name: "w1", sessionId: "w1-session", owner: "01a0f2f4-switchboard", ownerName: "switchboard" })])];
    expect(ownerName("desk-session", { catalogs })).toBe("muster/desk");
    // Rowless: the Switchboard owns w1 by session; its name was recorded at launch.
    expect(ownerName("01a0f2f4-switchboard", { catalogs })).toBe("switchboard");
    expect(ownerName("titan-session", { catalogs, recorded: "titan" })).toBe("titan");
    // Aliased: no row and nothing recorded; the legacy alias table names Servo.
    expect(ownerName("servo-session", { catalogs, aliases: { "servo-session": "servo", other: "not-reserved" } })).toBe("servo");
    expect(ownerName("other", { catalogs, aliases: { other: "not-reserved" } })).toBeUndefined();
    // A closed row is not a live name.
    expect(ownerName("gone", { catalogs: [catalog("muster", [row({ name: "old", sessionId: "gone", state: "closed" })])] })).toBeUndefined();
  });

  it("an owner Pi names itself from RATKING_NAME, then MUSTER_AGENT, then the Switchboard flag", () => {
    expect(ownerSelfName({ RATKING_NAME: "titan", MUSTER_AGENT: "x" })).toBe("titan");
    expect(ownerSelfName({ MUSTER_AGENT: "desk", MUSTER_PROJECT_SLUG: "muster" })).toBe("muster/desk");
    expect(ownerSelfName({ MUSTER_SWITCHBOARD: "1" })).toBe("switchboard");
    expect(ownerSelfName({})).toBeUndefined();
  });

  it("a target becomes a name: aliases and rows by catalog, a worker's owner by MUSTER_OWNER_NAME, never a DID", () => {
    const catalogs = [catalog("pilot", [row({ name: "desk", sessionId: "desk-session" })])];
    expect(ratkingTarget("pilot/desk", { catalogs, env: {} })).toEqual({ name: "pilot/desk", session: "desk-session" });
    expect(ratkingTarget("desk-session", { catalogs, env: {} })).toEqual({ name: "pilot/desk", session: "desk-session" });
    expect(ratkingTarget("boss", { catalogs: [], env: { MUSTER_OWNER: "boss", MUSTER_OWNER_NAME: "titan" } })).toEqual({ name: "titan", session: "boss" });
    expect(() => ratkingTarget("stranger", { catalogs, env: {} })).toThrow(/no Rat King name/);
    expect(() => ratkingTarget("did:web:x.invalid", { catalogs, env: {} })).toThrow(/not DIDs/);
  });
});

describe("transport", () => {
  it("a send emits ratking/send by name and maps delivered and not-delivered", async () => {
    const delivered = fakeRatking(() => ({ status: "delivered", id: "m1", seq: 7, to: "pilot/desk" }));
    const comms = RatkingComms({ events: delivered.events, createId, sender: () => "worker-session", target: () => ({ name: "pilot/desk", session: "desk-session" }) });
    expect(await Effect.runPromise(comms.send("desk-session", "hello"))).toMatchObject({ status: "delivered", id: "m1", seq: 7 });
    expect(delivered.requests[0]).toMatchObject({ to: "pilot/desk", kind: "muster" });
    expect(JSON.parse(String(delivered.requests[0]!.body))).toEqual({ type: "message", recipient: "desk-session", author: "worker-session", body: "hello" });

    const refused = fakeRatking(() => ({ status: "not-delivered", code: "UnknownName", reason: "no such name" }));
    const loud = await Effect.runPromise(RatkingComms({ events: refused.events, createId, sender: () => "w", target: () => ({ name: "nobody", session: "x" }) }).send("x", "hi"));
    expect(loud).toEqual({ status: "failed", detail: "NOT DELIVERED: UnknownName: no such name (ratking; no fallback)" });

    const silent = await Effect.runPromise(ratkingSend(fakeRatking(() => undefined).events, createId, { to: "a", body: "b" }, 20));
    expect(silent.status).toBe("failed");
    expect(silent.detail).toContain("NOT DELIVERED: Timeout");
  });

  it("an owner reply answers the ratking message that carried the parent post", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-reply-"));
    const parent = appendOwnerItem("owner-session", { author: "worker-session", kind: "question", title: "which way?" }, home);
    expect(ratkingInbound({ id: "rk-1", from: "pilot/worker", verified: true, body: JSON.stringify({ type: "owner", recipient: "owner-session", item: parent }) }, { owner() {}, message() {} })).toBe("owner");
    const fake = fakeRatking(() => ({ status: "delivered", id: "rk-2", seq: 2 }));
    const comms = RatkingComms({ events: fake.events, createId, sender: () => "owner-session", target: () => { throw new Error("a reply needs no name"); } });
    const reply = appendOwnerItem("worker-session", { author: "owner-session", kind: "fyi", title: "left", replyTo: parent.uri }, home, false);
    expect(await Effect.runPromise(comms.postOwner!("worker-session", reply))).toMatchObject({ status: "delivered" });
    expect(fake.requests[0]).toMatchObject({ replyTo: "rk-1" });
    expect(fake.requests[0]).not.toHaveProperty("to");
  });

  it("an owner note over ratking writes a ratking route receipt; not delivered is lost, with no fallback", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-owner-"));
    const fake = fakeRatking(request => String(request.to) === "titan" ? { status: "delivered", id: "m", seq: 1, to: "titan" } : { status: "not-delivered", code: "UnknownName", reason: "x" });
    const comms = RatkingComms({ events: fake.events, createId, sender: () => "worker-session", target: to => ({ name: to === "titan-session" ? "titan" : "ghost", session: String(to) }) });
    const send = vi.fn(() => Effect.succeed({ status: "delivered" as const }));
    const ok = await Effect.runPromise(deliverOwnerItem({ owner: "titan-session", home, session: "worker-session", project: "pilot", item: { author: "worker-session", kind: "done", title: "shipped" }, comms, send }));
    expect(ok).toMatchObject({ path: "ratking", lost: false, delivery: { status: "delivered" } });
    const body = JSON.parse(String(fake.requests[0]!.body));
    expect(body).toMatchObject({ type: "owner", recipient: "titan-session", item: { author: "worker-session" } });
    const lost = await Effect.runPromise(deliverOwnerItem({ owner: "ghost-session", home, session: "worker-session", project: "pilot", item: { author: "worker-session", kind: "done", title: "shipped" }, comms, send }));
    expect(lost).toMatchObject({ path: "ratking", lost: true, delivery: { status: "failed" } });
    expect(send).not.toHaveBeenCalled();
    const receipts = readFileSync(networkReceiptPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(receipts.map(receipt => receipt.path)).toEqual(["ratking", "ratking"]);
  });
});

describe("inbound", () => {
  it("an inbound ratking owner payload lands in this session's owner queue; foreign and unverified bodies are left to pi-ratking", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-inbound-"));
    process.env.HOME = home;
    const events = createEventBus();
    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const followUps: string[] = [];
    const pi = {
      registerTool() {}, registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, appendEntry() {},
      getFlag: () => undefined, getThinkingLevel: () => "medium", setThinkingLevel() {},
      getAllTools: () => [{ name: "ratking", sourceInfo: { path: "/x/pi-ratking/src/extension.ts", source: "pi-ratking" } }],
      sendUserMessage: (text: string) => followUps.push(text),
      on: (name: string, fn: (...args: unknown[]) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
      events,
    };
    muster(pi as never);
    const ctx = { cwd: home, isIdle: () => false, hasUI: false, sessionManager: { getSessionId: () => "owner-session", getBranch: () => [], getEntries: () => [], getHeader: () => null }, ui: { setStatus() {}, setWidget() {} } };
    for (const hook of hooks.get("session_start") ?? []) await hook({}, ctx);
    try {
      const item = appendOwnerItem("owner-session", { author: "worker-session", kind: "done", title: "landed over ratking" }, home, false);
      events.emit(RATKING_MESSAGE, { id: "m1", from: "pilot/worker", did: "did:web:x", verified: true, body: JSON.stringify({ type: "owner", recipient: "owner-session", item }), kind: "muster" });
      events.emit(RATKING_MESSAGE, { id: "m2", from: "pilot/worker", did: "did:web:x", verified: false, body: JSON.stringify({ type: "owner", recipient: "owner-session", item: { ...item, uri: `${item.uri}x` } }) });
      events.emit(RATKING_MESSAGE, { id: "m3", from: "joel", did: "did:web:y", verified: true, body: "plain words" });
      events.emit(RATKING_MESSAGE, { id: "m4", from: "pilot/desk", did: "did:web:z", verified: true, body: JSON.stringify({ type: "message", recipient: "owner-session", author: "desk-session", body: "Do the brief." }) });
      expect(readOwnerQueue("owner-session", home).items.map(record => record.item.uri)).toEqual([item.uri]);
      expect(followUps).toEqual(["Do the brief.\n\n[Authenticated agent message from desk-session, not Joel.]"]);
    } finally {
      for (const hook of hooks.get("session_shutdown") ?? []) await hook({}, ctx);
    }
    events.emit(RATKING_MESSAGE, { id: "m5", from: "pilot/desk", did: "did:web:z", verified: true, body: JSON.stringify({ type: "message", recipient: "owner-session", author: "desk-session", body: "after shutdown" }) });
    expect(followUps).toHaveLength(1);
  });
});

describe("selection", () => {
  it("detects pi-ratking by its tool name or its package, not by the intercom tool", () => {
    expect(ratkingLoaded([{ name: "ratking" }])).toBe(true);
    expect(ratkingLoaded([{ name: "intercom", sourceInfo: { path: "/n/node_modules/@rat-king/pi-ratking/src/extension.ts", source: "npm:@rat-king/pi-ratking" } }])).toBe(true);
    expect(ratkingLoaded([{ name: "intercom", sourceInfo: { path: "/n/pi-intercom/index.ts", source: "pi-intercom" } }])).toBe(false);
    expect(ratkingLoaded([{ name: "rk" }], "rk")).toBe(true);
  });

  it("with pi-ratking and MUSTER_COMMS=ratking every send goes through it; without pi-ratking the intercom path is unchanged", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-select-"));
    const fake = fakeRatking(() => ({ status: "delivered", id: "m", seq: 1 }));
    const ratking = RatkingComms({ events: fake.events, createId, sender: () => "me", target: to => ({ name: "pilot/desk", session: String(to) }) });
    const intercom: Array<Record<string, unknown>> = [];
    const events = { emit: (_event: string, payload: unknown) => { intercom.push(payload as Record<string, unknown>); }, on: () => () => {} };
    const withRatking = createComms({ events, createId, home, projectDir: home, adapterEnv: () => "ratking", ratking: () => ratking });
    expect(await Effect.runPromise(withRatking.mode!())).toBe("ratking");
    expect(await Effect.runPromise(withRatking.send("desk-session", "hi"))).toMatchObject({ status: "delivered" });
    expect(fake.requests).toHaveLength(1);
    expect(withRatking.relay).toBeUndefined();

    const without = createComms({ events, createId, home, projectDir: home, adapterEnv: () => "ratking", ratking: () => undefined });
    expect(await Effect.runPromise(without.mode!())).toBe("intercom");
    expect(without.legacyDrain).toBeUndefined();
  });
});

describe("opt-in", () => {
  it("pi-ratking loaded but MUSTER_COMMS unset or network keeps today's path and emits no ratking/send", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-optin-"));
    const fake = fakeRatking(() => ({ status: "delivered", id: "m", seq: 1 }));
    const ratking = vi.fn(() => RatkingComms({ events: fake.events, createId, sender: () => "me", target: to => ({ name: "pilot/desk", session: String(to) }) }));
    const intercom: Array<Record<string, unknown>> = [];
    const events = { emit: (_event: string, payload: unknown) => { intercom.push(payload as Record<string, unknown>); }, on: () => () => {} };
    const unset = createComms({ events, createId, home, projectDir: home, adapterEnv: () => undefined, ratking });
    expect(await Effect.runPromise(unset.mode!())).toBe("intercom");
    await Effect.runPromise(unset.send("desk-session", "hi").pipe(Effect.timeout(50), Effect.ignore));
    expect(intercom.length).toBeGreaterThan(0);
    const network = createComms({ events, createId, home, projectDir: home, adapterEnv: () => "network", ratking });
    const mode = await Effect.runPromise(network.mode!().pipe(Effect.orElseSucceed(() => "network-unconfigured")));
    expect(mode).not.toBe("ratking");
    const sent = await Effect.runPromise(network.send("desk-session", "hi").pipe(Effect.orElseSucceed(() => ({ status: "failed" as const, detail: "network path" }))));
    // Today's network path: it reads the network config, which this home lacks.
    expect(sent.detail).toContain("NetworkComms");
    expect(network.legacyDrain).toBeUndefined();
    expect(fake.requests).toEqual([]);
    expect(ratking).not.toHaveBeenCalled();
  });

  it("a ratking project opts its launched rows in; other policies do not", () => {
    const worker = { ...row({ name: "worker" }), profile: { env: {} }, lane: "work", role: "worker" } as AgentRow;
    expect(agentEnv({ slug: "pilot", dir: "/p", policy: { comms: "ratking" } } as unknown as Project, worker).MUSTER_COMMS).toBe("ratking");
    expect(agentEnv({ slug: "pilot", dir: "/p", policy: { comms: "network" } } as unknown as Project, worker).MUSTER_COMMS).toBeUndefined();
    expect(agentEnv({ slug: "pilot", dir: "/p" } as Project, worker).MUSTER_COMMS).toBeUndefined();
    expect(remoteCommsEnvironment({ policy: { comms: "ratking" } } as never, {} as never)).toEqual({ MUSTER_COMMS: "ratking" });
    expect(decodePolicy({ deployLevel: 1, wipLimit: 3, flowStallMin: 120, landWaitMin: 30, comms: "ratking" }).comms).toBe("ratking");
    expect(selectComms("ratking")).toBe("intercom");
  });
});

describe("legacy drain", () => {
  it("under pi-ratking the network module never starts a consumer without an existing legacy identity", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-drain-"));
    const ratking = RatkingComms({ events: createEventBus(), createId, sender: () => "me", target: () => ({ name: "pilot/desk", session: "me" }) });
    const service = createComms({ events: createEventBus(), createId, home, projectDir: home, adapterEnv: () => "ratking",
      networkSender: () => ({ agent: "pilot/desk", session: "me" }), ratking: () => ratking });
    expect(await Effect.runPromise(service.legacyDrain!())).toBe(false);
    const receive = vi.fn(() => Effect.void);
    await Effect.runPromise(service.consume!(receive));
    expect(receive).not.toHaveBeenCalled();
  });

  it("the owner feed starts the legacy consumer under ratking only while a legacy identity needs draining", async () => {
    for (const drain of [false, true]) {
      const home = mkdtempSync(join(tmpdir(), "ratking-feed-"));
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const pi = { on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn), registerTool() {}, registerMessageRenderer() {}, appendEntry() {}, sendMessage() {}, sendUserMessage() {} };
      const ctx = { isIdle: () => false, sessionManager: { getSessionId: () => "reader", getBranch: () => [] } };
      const consume = vi.fn(async () => {});
      const legacyDrain = vi.fn(async () => drain);
      registerOwnerFeed(pi as never, { HOME: home }, { mode: async () => "ratking", legacyDrain, consume }, async () => false);
      try {
        handlers.get("session_start")!({}, ctx);
        await vi.waitFor(() => expect(legacyDrain).toHaveBeenCalled());
        await new Promise(resolve => setTimeout(resolve, 20));
        if (drain) expect(consume).toHaveBeenCalled(); else expect(consume).not.toHaveBeenCalled();
      } finally { await handlers.get("session_shutdown")!(); }
    }
  });
});
