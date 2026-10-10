import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComms, explicitPolicyComms, selectComms } from "./comms.ts";
import { NetworkComms } from "./comms.ts";
import { RATKING_SEND, RATKING_SEND_RESULT, RatkingComms, intercomLoaded, ratkingLoaded, registeredCatalogs, reservedRatkingDids } from "./comms-ratking.ts";
import { decodeProject, roleDefaults } from "./domain.ts";
import muster from "./extension-main.ts";
import { OUTBOX_REQUEST_EVENT } from "./intercom.ts";
import { ingestOwnerItem } from "./owner-queue.ts";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen, projectStatus, projectUpdate, pullRemoteOwnerInbox } from "./ops.ts";
import { load, mutate, projectPath } from "./store.ts";
import { registerSwitchboardSession } from "./switchboard-ops.ts";
import { harness, runWith } from "./test-support.ts";

const saved = { ...process.env };
beforeEach(() => { for (const key of Object.keys(process.env)) if (/^(MUSTER|RATKING|HERDR)_/.test(key)) delete process.env[key]; });
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const raw = (dir: string) => JSON.parse(readFileSync(projectPath(dir), "utf8")) as { policy?: Record<string, unknown> };
const writeRaw = (dir: string, value: unknown) => writeFileSync(projectPath(dir), JSON.stringify(value));

async function opened() {
  const h = harness(); const dir = join(h.home, "project"); mkdirSync(dir, { recursive: true });
  await runWith(h, projectOpen({ dir, slug: "pilot", outcome: "ratking by default", reviewTrigger: "review", nextAction: "launch", ephemeral: true, createSpace: true }));
  return { h, dir };
}

/** pi-ratking's half of the events contract, delivering every send. */
function fakeRatking(events = createEventBus()) {
  const requests: Array<Record<string, unknown>> = [];
  events.on(RATKING_SEND, data => {
    const request = data as Record<string, unknown>;
    requests.push(request);
    queueMicrotask(() => events.emit(RATKING_SEND_RESULT, { requestId: request.requestId, status: "delivered", id: `rk-${requests.length}`, seq: requests.length, to: request.to ?? "reply" }));
  });
  return { events, requests };
}

describe("ratking is the default", { timeout: 30_000 }, () => {
  it("a new project records ratking; an existing file is never given a comms value it lacks", async () => {
    const { h, dir } = await opened();
    expect(raw(dir).policy?.comms).toBe("ratking");
    // An older catalog: no comms key. Updates and status passes write it back without one.
    const { policy: _policy, ...older } = raw(dir) as Record<string, unknown>;
    writeRaw(dir, { ...older, policy: { roles: {} } });
    const updated = await runWith(h, projectUpdate(dir, { policy: { nudgeAfterMin: 20 } }));
    expect(updated.policy.comms).toBe("ratking");
    expect(raw(dir).policy).toEqual({ roles: {}, nudgeAfterMin: 20 });
    await runWith(h, projectStatus(dir, { act: false }));
    expect(raw(dir).policy).not.toHaveProperty("comms");
    expect(selectComms(undefined, (await runWith(h, load(dir))).policy)).toBe("ratking");
  });

  it("an unknown comms value decodes, is kept on write, runs as ratking, and says so", async () => {
    const { h, dir } = await opened();
    writeRaw(dir, { ...raw(dir), policy: { comms: "carrier-pigeon" } });
    expect(decodeProject(raw(dir)).policy?.comms).toBe("carrier-pigeon");
    expect(selectComms(undefined, (await runWith(h, load(dir))).policy)).toBe("ratking");
    expect(explicitPolicyComms(dir)).toBe("ratking");
    // Routing still finds the project's rows, and the owner inbox pull reads the file.
    expect(registeredCatalogs(h.home, dir).map(project => project.slug)).toEqual(["pilot"]);
    expect(await runWith(h, pullRemoteOwnerInbox(dir))).toEqual([]);
    const service = createComms({ events: createEventBus(), createId: () => "id", home: h.home, projectDir: dir, adapterEnv: () => undefined, followProjectPolicy: true });
    expect(await Effect.runPromise(service.mode!())).toBe("ratking");
    const updated = await runWith(h, projectUpdate(dir, { policy: { nudgeAfterMin: 20 } }));
    expect(updated.policy.comms).toBe("ratking");
    expect(updated.notes.join("\n")).toContain('comms: "carrier-pigeon" is unknown to this Muster; it runs as ratking');
    expect(raw(dir).policy?.comms).toBe("carrier-pigeon");
    expect((await runWith(h, projectStatus(dir, { act: false }))).notes.join("\n")).toContain("carrier-pigeon");
  });

  it("an unknown role thinking level decodes and falls back to the role default", async () => {
    const { dir } = await opened();
    const project = decodeProject({ ...raw(dir), policy: { roles: { worker: { thinking: "ultra", model: "sol" } } } });
    expect(project.policy?.roles?.worker?.thinking).toBe("ultra");
    expect(roleDefaults(undefined, project.policy, "worker").thinking).toBe("medium");
  });
});

describe("detection", () => {
  it("pi-ratking registered as intercom is pi-ratking, not pi-intercom", () => {
    const ratking = [{ name: "intercom", sourceInfo: { path: "/home/joel/Code/joelhooks/rat-king/packages/pi-ratking/src/extension.ts", source: "local" } }];
    expect(ratkingLoaded(ratking)).toBe(true);
    expect(ratkingLoaded(ratking, "intercom")).toBe(true);
    expect(intercomLoaded(ratking)).toBe(false);
    const intercom = [{ name: "intercom", sourceInfo: { path: "/n/pi-intercom/index.ts", source: "npm:pi-intercom" } }];
    expect(ratkingLoaded(intercom)).toBe(false);
    expect(intercomLoaded(intercom)).toBe(true);
  });
});

describe("no pi-intercom", { timeout: 30_000 }, () => {
  it("an intercom choice rides ratking when pi-intercom is absent, and fails loudly when pi-ratking is absent too", async () => {
    const { h, dir } = await opened();
    writeRaw(dir, { ...raw(dir), policy: { comms: "intercom" } });
    const fake = fakeRatking();
    const outbox: unknown[] = [];
    fake.events.on(OUTBOX_REQUEST_EVENT, request => outbox.push(request));
    const ratking = RatkingComms({ events: fake.events, createId: () => "id", sender: () => "me", target: to => ({ name: "pilot/desk", session: String(to) }) });
    const options = { events: fake.events, createId: () => "id", home: h.home, projectDir: dir, adapterEnv: () => undefined, followProjectPolicy: true };
    const withRatking = createComms({ ...options, ratking: () => ratking, intercom: () => false });
    expect(await Effect.runPromise(withRatking.mode!())).toBe("ratking");
    expect(await Effect.runPromise(withRatking.send("desk-session", "hi"))).toMatchObject({ status: "delivered" });
    expect(await Effect.runPromise(withRatking.relay!("desk-session", "hi"))).toMatchObject({ status: "delivered" });
    expect(fake.requests).toHaveLength(2);
    const neither = createComms({ ...options, ratking: () => undefined, intercom: () => false });
    expect(await Effect.runPromise(neither.send("desk-session", "hi"))).toMatchObject({ status: "failed", detail: expect.stringContaining("pi-ratking not loaded") });
    expect(outbox).toEqual([]);
  });

  it("a Muster Pi with no pi-intercom delivers an owner note, an owner reply, a desk_send and a Switchboard nudge over ratking", async () => {
    const { h, dir } = await opened();
    await runWith(h, laneOpen(dir, { slug: "desk", label: "desk", goal: "desk", repo: dir }));
    await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: dir }));
    await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "work", repo: dir }));
    await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, noSkills: true }));
    // desk_post publishes no tokens through the real Herdr client.
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, sidebar: "off" as const }, undefined] as const)));
    const project = await runWith(h, load(dir));
    const worker = project.agents.find(row => row.name === "worker")!;
    process.env.HOME = h.home;

    const fake = fakeRatking();
    const outbox: unknown[] = [];
    fake.events.on(OUTBOX_REQUEST_EVENT, request => outbox.push(request)); // pi-intercom is gone: nobody answers
    const piWith = (tools: readonly unknown[]) => {
      const registered = new Map<string, ToolDefinition>();
      const pi = {
        registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
        registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, appendEntry() {}, sendUserMessage() {},
        getFlag: () => undefined, getThinkingLevel: () => "medium", setThinkingLevel() {}, getAllTools: () => tools, on() {}, events: fake.events,
      };
      muster(pi as never);
      return registered;
    };
    const ctx = (session: string) => ({ cwd: dir, hasUI: false, isIdle: () => true, ui: { setStatus() {}, setWidget() {} },
      sessionManager: { getSessionId: () => session, getBranch: () => [], getEntries: () => [], getHeader: () => null } }) as never;
    const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(item => item.text ?? "").join("\n");
    const piRatking = [{ name: "intercom", sourceInfo: { path: "/x/rat-king/packages/pi-ratking/src/extension.ts", source: "local" } }];

    // The worker: owner_note reaches its rowless owner by the name recorded at launch.
    Object.assign(process.env, { MUSTER_ROLE: "worker", MUSTER_PROJECT: dir, MUSTER_AGENT: "worker", MUSTER_LANE: "work", MUSTER_OWNER: h.sessionId, MUSTER_OWNER_NAME: "titan" });
    const note = await piWith(piRatking).get("owner_note")!.execute("id", { kind: "question", title: "which way?" }, undefined, undefined, ctx(worker.sessionId));
    expect(note).not.toHaveProperty("isError");
    expect(fake.requests.at(-1)).toMatchObject({ to: "titan", kind: "data" });
    const uri = (note.details as { uri: string }).uri;
    // The owner's pi-ratking reader hands the payload to Muster, which queues it.
    ingestOwnerItem(h.sessionId, JSON.parse(String(fake.requests.at(-1)!.body)).item, h.home);

    // Without pi-ratking the same note fails at once, never over intercom.
    const lost = await piWith([]).get("owner_note")!.execute("id", { kind: "fyi", title: "lost" }, undefined, undefined, ctx(worker.sessionId));
    expect(lost).toMatchObject({ isError: true });
    expect(text(lost)).toContain("pi-ratking not loaded");

    // The owner: owner_reply, desk_send and the Switchboard nudge from desk_post.
    for (const key of ["MUSTER_ROLE", "MUSTER_AGENT", "MUSTER_LANE", "MUSTER_OWNER", "MUSTER_OWNER_NAME"]) delete process.env[key];
    process.env.MUSTER_ROLE = "boss";
    const owner = piWith(piRatking);
    const reply = await owner.get("owner_reply")!.execute("id", { uri, text: "left" }, undefined, undefined, ctx(h.sessionId));
    expect(reply).not.toHaveProperty("isError");
    expect(fake.requests.at(-1)).toMatchObject({ to: "pilot/worker", kind: "data" });
    const desk = await owner.get("desk_send")!.execute("id", { to: "pilot/desk", text: "hello desk" }, undefined, undefined, ctx(h.sessionId));
    expect(text(desk)).toContain("delivery: ratking · delivered");
    expect(fake.requests.at(-1)).toMatchObject({ to: "pilot/desk", kind: "message" });
    registerSwitchboardSession(h.home, "switchboard-session");
    await owner.get("desk_post")!.execute("id", { kind: "decision", title: "pick one" }, undefined, undefined, ctx(h.sessionId));
    expect(fake.requests.at(-1)).toMatchObject({ to: "switchboard", kind: "message" });
    expect(String(fake.requests.at(-1)!.body)).toContain("Desk queue changed: [pilot#");
    expect(outbox).toEqual([]);
  });
});

describe("legacy drain and reserved names", { timeout: 30_000 }, () => {
  const sender = () => ({ agent: "pilot/desk", session: "desk-session" });
  const mockNetwork = (did: string, consume: () => Effect.Effect<void>) => vi.doMock("./comms-network.ts", () => ({
    localJoinFacts: async () => ({ agent: "pilot/desk", config: null, identity: true, did, key: null, session: null, fence: "absent", joined: true, reason: null }),
    readNetworkConfig: () => ({}), seedNetworkPeers: () => {}, readNetworkPeers: () => ({}), readNetworkIdentities: () => ({}),
    createNetworkComms: () => ({ ...NetworkComms, consume }),
  }));

  it("the legacy reader never consumes a DID pi-ratking reserves; a missing, unreadable or refusing config reserves nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "ratking-reserved-"));
    const config = join(home, "pi.json");
    process.env.RATKING_CONFIG = config;
    const drained = async (did: string) => {
      const consume = vi.fn(() => Effect.void);
      mockNetwork(did, consume);
      try {
        const service = createComms({ events: createEventBus(), createId: () => "id", home, projectDir: join(home, "none"), adapterEnv: () => "ratking", networkSender: sender,
          ratking: () => RatkingComms({ events: createEventBus(), createId: () => "id", sender: () => "me", target: () => ({ name: "pilot/desk", session: "me" }) }) });
        const drain = await Effect.runPromise(service.legacyDrain!());
        await Effect.runPromise(service.consume!(() => Effect.void));
        expect(consume).toHaveBeenCalledTimes(drain ? 1 : 0);
        return drain;
      } finally { vi.doUnmock("./comms-network.ts"); }
    };
    expect(await drained("did:web:switchboard.example.invalid")).toBe(true); // no config file
    writeFileSync(config, "{not json");
    expect(await drained("did:web:switchboard.example.invalid")).toBe(true);
    writeFileSync(config, JSON.stringify({ reserved: { switchboard: { did: "did:web:switchboard.example.invalid" }, "fleet-owner": { did: "did:web:owner.example.invalid" } }, refuse: ["fleet-owner"] }));
    expect(reservedRatkingDids(home)).toEqual(new Set(["did:web:switchboard.example.invalid"]));
    expect(await drained("did:web:switchboard.example.invalid")).toBe(false);
    expect(await drained("did:web:owner.example.invalid")).toBe(true); // refused: pi-ratking does not read it
    expect(await drained("did:web:pilot.desk.example.invalid")).toBe(true);
    delete process.env.RATKING_CONFIG;
    mkdirSync(join(home, ".config/rat-king"), { recursive: true });
    writeFileSync(join(home, ".config/rat-king/pi.json"), JSON.stringify({ reserved: { "pilot-desk": { did: "did:web:pilot.desk.example.invalid" } } }));
    expect(await drained("did:web:pilot.desk.example.invalid")).toBe(false);
  });
});
