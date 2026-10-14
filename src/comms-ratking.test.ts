import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentEnv } from "./argv.ts";
import { createComms, remoteCommsEnvironment, selectComms } from "./comms.ts";
const networkReceiptPath = (home: string) => join(home, ".local/state/muster/ratking-receipts.jsonl");
import { RATKING_MESSAGE, RATKING_SEND, RATKING_SEND_RESULT, RatkingComms, ownerName, ownerSelfName, ratkingInbound, ratkingLoaded, ratkingSend, ratkingTarget } from "./comms-ratking.ts";
import { decodePolicy, type AgentRow, type Project } from "./domain.ts";
import muster from "./extension-main.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { ownerFeed } from "./owner-feed.ts";
import { appendOwnerItem, deliverOwnerItem, ingestOwnerItem, readOwnerQueue } from "./owner-queue.ts";
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

  // 2026-10-14: the muster desk, restarted by itself, sent every turn record to its own name and Rat King refused it.
  it("a self-owned row gets no owner name, so its turn records do not go to itself", () => {
    const env = agentEnv({ slug: "muster", dir: "/p" } as Project, { ...row({ name: "desk", owner: "desk-session", ownerName: "muster/desk" }), profile: { env: {} }, lane: "desk", role: "desk" } as AgentRow);
    expect(env.RATKING_NAME).toBe("muster/desk");
    expect(env.MUSTER_OWNER_NAME).toBeUndefined();
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
    expect(delivered.requests[0]).toMatchObject({ to: "pilot/desk" });
    // One copy only: pi-ratking keeps data off the model; Muster's hook delivers the follow-up.
    expect(delivered.requests[0]).toMatchObject({ kind: "data" });
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
    expect(fake.requests[0]).toMatchObject({ replyTo: "rk-1", kind: "data" });
    expect(fake.requests[0]).not.toHaveProperty("to");
  });

  it("an owner note over ratking writes a ratking route receipt; not delivered is lost, with no fallback", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-owner-"));
    const fake = fakeRatking(request => String(request.to) === "titan" ? { status: "delivered", id: "m", seq: 1, to: "titan" } : { status: "not-delivered", code: "UnknownName", reason: "x" });
    const comms = RatkingComms({ events: fake.events, createId, sender: () => "worker-session", target: to => ({ name: to === "titan-session" ? "titan" : "ghost", session: String(to) }) });
    const send = vi.fn(() => Effect.succeed({ status: "delivered" as const }));
    const ok = await Effect.runPromise(deliverOwnerItem({ owner: "titan-session", home, session: "worker-session", project: "pilot", item: { author: "worker-session", kind: "done", title: "shipped" }, comms, send }));
    expect(ok).toMatchObject({ path: "ratking", lost: false, delivery: { status: "delivered" } });
    expect(fake.requests[0]).toMatchObject({ kind: "data" }); // owner traffic never reaches the model raw
    const body = JSON.parse(String(fake.requests[0]!.body));
    expect(body).toMatchObject({ type: "owner", recipient: "titan-session", item: { author: "worker-session" } });
    const lost = await Effect.runPromise(deliverOwnerItem({ owner: "ghost-session", home, session: "worker-session", project: "pilot", item: { author: "worker-session", kind: "done", title: "shipped" }, comms, send }));
    // A failed send is parked in the owner's local queue, never thrown away.
    expect(lost).toMatchObject({ path: "ratking", lost: false, stored: "local-queue", failureCode: "UnknownName", delivery: { status: "failed" } });
    expect(readOwnerQueue("ghost-session", home).items.map(record => record.item.uri)).toEqual([lost.uri]);
    expect(send).not.toHaveBeenCalled();
    const receipts = readFileSync(networkReceiptPath(home), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(receipts.map(receipt => receipt.path)).toEqual(["ratking", "ratking"]);
  });
});

describe("owner mail shadow", () => {
  it.each(["action", "question", "blocked"] as const)("%s sends one readable mail attributed to the worker, not the operator", async kind => {
    const home = mkdtempSync(join(tmpdir(), "owner-mail-"));
    const fake = fakeRatking(() => ({ status: "delivered", id: "plain-id", seq: 1 }));
    const catalogs = [catalog("pilot", [row({ name: "worker", sessionId: "worker-session" }), row({ name: "desk", sessionId: "owner-session" })])];
    const comms = RatkingComms({ events: fake.events, createId, sender: () => "worker-session", target: to => ratkingTarget(to, { catalogs, env: {} }) });
    const result = await Effect.runPromise(deliverOwnerItem({ owner: "owner-session", home, session: "worker-session", project: "pilot", comms,
      item: { author: "worker-session", kind, title: "Approve packet", body: "Evidence attached in refs.", lane: "work", refs: ["commit:123", "report.md"] }, send: () => { throw new Error("legacy send"); } }));
    expect(result.delivery.status).toBe("delivered");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ to: "pilot/desk", kind: "message", summary: `${kind} pilot/worker · Approve packet`, body: "@owner-session Approve packet\nEvidence attached in refs.\n\nlane work · refs commit:123 report.md" });
    expect(String(fake.requests[0]!.summary).length).toBeLessThanOrEqual(280);
    expect(fake.requests[0]).not.toHaveProperty("attachments");
    expect(fake.requests[0]).not.toHaveProperty("record");
  });

  it("fyi remains data, and a threaded action reply keeps replyTo", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-mail-reply-"));
    const fake = fakeRatking(() => ({ status: "delivered", id: "reply-id", seq: 1 }));
    const comms = RatkingComms({ events: fake.events, createId, sender: () => "worker-session", target: to => ({ name: to === "worker-session" ? "pilot/worker" : "pilot/desk", session: String(to) }) });
    const parent = appendOwnerItem("owner-session", { author: "worker-session", kind: "fyi", title: "Quiet" }, home);
    await Effect.runPromise(comms.postOwner!("owner-session", parent));
    expect(fake.requests[0]).toMatchObject({ kind: "data", body: JSON.stringify({ type: "owner", recipient: "owner-session", item: parent }) });
    ratkingInbound({ verified: true, id: "parent-mail", body: JSON.stringify({ type: "owner", recipient: "owner-session", item: parent }) }, { owner() {}, message() {} });
    ingestOwnerItem("worker-session", parent, home);
    const reply = appendOwnerItem("worker-session", { author: "worker-session", kind: "action", title: "Act", replyTo: parent.uri }, home, false);
    await Effect.runPromise(comms.postOwner!("owner-session", reply));
    expect(fake.requests[1]).toMatchObject({ kind: "message", replyTo: "parent-mail", summary: "action pilot/worker · Act" });
    expect(fake.requests[1]).not.toHaveProperty("to");
  });

  it("reconstructs exactly one queue record by mail id, leaves inbox readable and never renders or wakes", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-mail-inbound-"));
    const project = catalog("pilot", [row({ name: "worker", sessionId: "worker-session" })]);
    const wake = vi.fn();
    const feed = ownerFeed({ session: "owner-session", home, appendEntry() {}, sendMessage: wake });
    const followUp = vi.fn();
    const handle = { catalogs: () => [catalog("owner-project", [row({ name: "desk", sessionId: "owner-session" })]), project], owner: (item: Parameters<typeof ingestOwnerItem>[1]) => { ingestOwnerItem("owner-session", item, home); }, message: followUp };
    const mail = { id: "shadow-mail-id", verified: true, from: "pilot/worker", kind: "message", summary: "action pilot/worker · Review", body: "Evidence\n\nlane work · refs commit:123 report.md" };
    expect(ratkingInbound(mail, handle)).toBe("owner");
    expect(ratkingInbound(mail, handle)).toBe("owner");
    const records = readOwnerQueue("owner-session", home);
    expect(records.cursor).toBe(1);
    expect(records.items[0]!.item).toMatchObject({ uri: mail.id, author: "worker-session", kind: "action", text: "action pilot/worker · Review\nEvidence", lane: "work", refs: ["commit:123", "report.md"], project: "pilot", renderedBy: "ratking" });
    expect(feed.inbox().items).toHaveLength(1);
    expect(feed.flush()).toBe(0);
    expect(await feed.poll(() => true)).toBe(0);
    expect(feed.beforeTurn()).toBeUndefined();
    expect(wake).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    feed.dispose();

    // owner_reply's unchanged route: parent.author is the row session, and the remembered URI threads mail.
    const parent = records.items[0]!.item;
    const fake = fakeRatking(() => ({ status: "delivered", id: "owner-answer", seq: 2, to: "pilot/worker" }));
    const comms = RatkingComms({ events: fake.events, createId, sender: () => "owner-session", target: () => { throw new Error("threaded reply needs no target lookup"); } });
    const answer = await Effect.runPromise(deliverOwnerItem({ owner: parent.author, home, session: "owner-session", project: "pilot", comms,
      item: { author: "owner-session", kind: "fyi", title: "Approved", text: "Approved", replyTo: parent.uri, mention: parent.author }, send: () => { throw new Error("no legacy send"); } }));
    expect(answer.delivery).toMatchObject({ status: "delivered", detail: "ratking → pilot/worker" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ replyTo: mail.id, kind: "data" });
    expect(JSON.parse(String(fake.requests[0]!.body))).toMatchObject({ recipient: "worker-session", item: { reply: { parent: { uri: mail.id } } } });

    // A mixed-version body has no marker: the existing feed must still render it.
    const legacy = appendOwnerItem("owner-session", { author: "worker-session", kind: "action", title: "Old post", mention: "owner-session" }, home, false);
    expect(ratkingInbound({ id: "old-mail-id", verified: true, body: JSON.stringify({ type: "owner", recipient: "owner-session", item: legacy }) }, handle)).toBe("owner");
    const oldFeed = ownerFeed({ session: "owner-session", home, appendEntry() {}, sendMessage: wake });
    expect(oldFeed.flush()).toBe(1);
    expect(wake).toHaveBeenCalledOnce();
    expect(wake.mock.calls[0]![0].content).toContain("Old post");
    oldFeed.dispose();
  });

  it("ignores foreign, unverified, malformed and falsely operator-attributed plain mail", () => {
    const owner = vi.fn();
    const handle = { owner, message: vi.fn(), catalogs: () => [catalog("pilot", [row({ name: "worker" })])] };
    const mail = { id: "guard", verified: true, from: "pilot/worker", kind: "message", summary: "action pilot/worker · Review", body: "Evidence\nlane - · refs " };
    for (const patch of [{ from: "other/worker" }, { verified: false }, { summary: "action Joel · Review" }, { summary: "action operator · Review" }, { body: "missing facts" }, { kind: "data" }]) expect(ratkingInbound({ ...mail, ...patch }, handle)).toBe("ignored");
    const rejected = vi.fn();
    for (const sender of [row({ name: "worker", state: "closed" }), row({ name: "worker", sessionId: "" })]) {
      expect(ratkingInbound(mail, { ...handle, catalogs: () => [catalog("pilot", [sender])], rejected })).toBe("ignored");
    }
    expect(rejected).toHaveBeenCalledTimes(2);
    expect(owner).not.toHaveBeenCalled();
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
      events.emit(RATKING_MESSAGE, { id: "m1", from: "pilot/worker", did: "did:web:x", verified: true, body: JSON.stringify({ type: "owner", recipient: "owner-session", item }), kind: "data" });
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

  it("with pi-ratking and MUSTER_COMMS=ratking every send goes through it; without pi-ratking it fails loudly, never over intercom", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-select-"));
    const fake = fakeRatking(() => ({ status: "delivered", id: "m", seq: 1 }));
    const ratking = RatkingComms({ events: fake.events, createId, sender: () => "me", target: to => ({ name: "pilot/desk", session: String(to) }) });
    const intercom: Array<Record<string, unknown>> = [];
    const events = { emit: (_event: string, payload: unknown) => { intercom.push(payload as Record<string, unknown>); }, on: () => () => {} };
    const withRatking = createComms({ ratking: () => ratking });
    expect(await Effect.runPromise(withRatking.mode!())).toBe("ratking");
    expect(await Effect.runPromise(withRatking.send("desk-session", "hi"))).toMatchObject({ status: "delivered" });
    expect(fake.requests).toHaveLength(1);

    const without = createComms({ ratking: () => undefined });
    expect(await Effect.runPromise(without.mode!())).toBe("ratking");
    expect(await Effect.runPromise(without.send("desk-session", "hi"))).toMatchObject({ status: "failed", detail: expect.stringContaining("pi-ratking not loaded") });
    expect(intercom).toEqual([]);
  });
});

describe("default", () => {
  it("MUSTER_COMMS=network is ignored; unset rides ratking", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-optin-"));
    const fake = fakeRatking(() => ({ status: "delivered", id: "m", seq: 1 }));
    const ratking = vi.fn(() => RatkingComms({ events: fake.events, createId, sender: () => "me", target: to => ({ name: "pilot/desk", session: String(to) }) }));
    const intercom: Array<Record<string, unknown>> = [];
    const events = { emit: (_event: string, payload: unknown) => { intercom.push(payload as Record<string, unknown>); }, on: () => () => {} };
    const network = createComms({ ratking });
    const mode = await Effect.runPromise(network.mode!().pipe(Effect.orElseSucceed(() => "network-unconfigured")));
    expect(mode).toBe("ratking");
    const sent = await Effect.runPromise(network.send("desk-session", "hi").pipe(Effect.orElseSucceed(() => ({ status: "failed" as const, detail: "network path" }))));
    expect(sent.status).toBe("delivered");
    expect(fake.requests).toHaveLength(1);
    expect(ratking).toHaveBeenCalled();
    const unset = createComms({ ratking });
    expect(await Effect.runPromise(unset.mode!())).toBe("ratking");
    expect(await Effect.runPromise(unset.send("desk-session", "hi"))).toMatchObject({ status: "delivered" });
    expect(fake.requests).toHaveLength(2);
    expect(intercom).toEqual([]);
  });

  it("launched rows always ride ratking, including legacy policies", () => {
    const worker = { ...row({ name: "worker" }), profile: { env: {} }, lane: "work", role: "worker" } as AgentRow;
    expect(agentEnv({ slug: "pilot", dir: "/p", policy: { comms: "ratking" } } as unknown as Project, worker).MUSTER_COMMS).toBe("ratking");
    expect(agentEnv({ slug: "pilot", dir: "/p" } as Project, worker).MUSTER_COMMS).toBe("ratking");
    expect(agentEnv({ slug: "pilot", dir: "/p", policy: { comms: "carrier-pigeon" } } as unknown as Project, worker).MUSTER_COMMS).toBe("ratking");
    expect(agentEnv({ slug: "pilot", dir: "/p", policy: { comms: "network" } } as unknown as Project, worker).MUSTER_COMMS).toBe("ratking");
    expect(agentEnv({ slug: "pilot", dir: "/p", policy: { comms: "intercom" } } as unknown as Project, worker).MUSTER_COMMS).toBe("ratking");
    expect(remoteCommsEnvironment({ policy: { comms: "ratking" } } as never, {} as never)).toEqual({ MUSTER_COMMS: "ratking" });
    expect(remoteCommsEnvironment({ policy: undefined } as never, {} as never)).toEqual({ MUSTER_COMMS: "ratking" });
    expect(decodePolicy({ deployLevel: 1, wipLimit: 3, flowStallMin: 120, landWaitMin: 30, comms: "ratking" }).comms).toBe("ratking");
    expect(selectComms("ratking")).toBe("ratking");
    expect(selectComms(undefined)).toBe("ratking");
  });
});

;
