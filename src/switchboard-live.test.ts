import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { queuePath, readDesk } from "./desk.ts";
import { deskPost, projectOpen, agentLaunch } from "./ops.ts";
import { NetworkComms } from "./comms.ts";
import { Herdr, Comms } from "./runtime.ts";
import { load } from "./store.ts";
import { focusDesk, deskAnswer, loadSystem, nudgeSwitchboards, registerSwitchboardSession, registryPath } from "./switchboard-ops.ts";
import { watchSwitchboard, registerSwitchboard } from "./switchboard-ext.ts";
import { SwitchboardState, handleKey, renderOverlay } from "./switchboard-view.ts";
import { fleetGroups, inbox } from "./switchboard.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

const plain = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const ask = { id: "ask", kind: "decision" as const, from: "desk", title: "Ship?", ts: "2026-09-29T00:00:00Z" };
const setup = async () => {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n", space: "w1", ephemeral: true, desk: true, musterExtension: "/m", deskExtension: null }));
  mkdirSync(dirname(registryPath(h.home)), { recursive: true });
  writeFileSync(registryPath(h.home), `${JSON.stringify({ slug: "probe", dir, spaceId: "w1", ts: h.now.toISOString() })}\n`);
  return { h, dir };
};

describe("whole fleet rows", () => {
  it("keeps quiet projects and lists unregistered spaces last with adoption hints", async () => {
    const { h } = await setup();
    h.herdr.workspaces.set("w2", { workspace_id: "w2", label: "rubicon-fitness" });
    const s = new SwitchboardState();
    s.setSystem(await runWith(h, loadSystem));
    expect(s.rows()).toMatchObject([{ type: "group", group: { project: "probe", items: [] } }, { type: "unregistered", space: { label: "rubicon-fitness" } }]);
    const lines = renderOverlay(s, 110, 20, plain).join("\n");
    expect(lines).toContain("probe 0 · quiet");
    expect(lines).toContain("rubicon-fitness · unregistered · project_open adopts it");
    expect(handleKey(s, "\r")).toEqual({ type: "desk", project: "probe" });
    s.move(1);
    expect(handleKey(s, "\r")).toBeNull();
    s.toggle();
    expect(s.rows()).toHaveLength(2);
    // A newly registered quiet project appears without restarting the reader.
    appendFileSync(registryPath(h.home), `${JSON.stringify({ slug: "moved", dir: "/missing", spaceId: "w2", ts: h.now.toISOString() })}\n`);
    s.setSystem(await runWith(h, loadSystem));
    expect(s.groups.map((g) => g.project)).toEqual(["moved", "probe"]);
    expect(s.unregistered).toEqual([]);
  });

  it("marks a terminal-verified desk outside its space and a live owner's session", async () => {
    const { h, dir } = await setup();
    await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: dir }));
    const pane = [...h.herdr.panes.values()].find((p) => p.name === "desk")!;
    pane.workspace_id = "w2";
    expect((await runWith(h, loadSystem)).groups[0]?.outsideSpace).toBe(true);
    pane.terminal_id = "reused";
    expect((await runWith(h, loadSystem)).groups[0]?.outsideSpace).toBe(false);
    const owner = h.herdr.addPane("w2", "t2", dir);
    owner.agent_session = { agent: "pi", kind: "id", source: "test", value: h.sessionId };
    const view = await runWith(h, loadSystem);
    expect(view.groups[0]?.outsideSpace).toBe(true);
    owner.agent_session = { agent: "pi", kind: "file", source: "test", value: `/sessions/2026-09-29T00-00-00_${h.sessionId}.jsonl` };
    expect((await runWith(h, loadSystem)).groups[0]?.outsideSpace).toBe(true);
    const s = new SwitchboardState(); s.setSystem(view);
    expect(renderOverlay(s, 120, 20, plain).join("\n")).toContain("↗ owner/desk outside space");
  });

  it("marks open projects with no live desk or owner, but not when sessions are unknown", async () => {
    const { h, dir } = await setup();
    await runWith(h, deskPost(dir, { kind: "blocked", title: "Needs a live desk" }));
    h.live = [];
    expect((await runWith(h, loadSystem)).groups[0]?.deadDesk).toBe(true);
    await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: dir }));
    const desk = (await runWith(h, load(dir))).agents.find((agent) => agent.name === "desk")!;
    h.live = [desk.sessionId];
    expect((await runWith(h, loadSystem)).groups[0]?.deadDesk).toBe(false);
    h.live = [desk.owner];
    expect((await runWith(h, loadSystem)).groups[0]?.deadDesk).toBe(false);
    h.live = undefined;
    expect((await runWith(h, loadSystem)).groups[0]?.deadDesk).toBeUndefined();
  });

  it("keeps urgent asks above quiet rows and never duplicates a registered project", () => {
    const groups = fleetGroups(inbox({ probe: [ask] }, Date.now()), ["quiet", "probe", "quiet"]);
    expect(groups.map((g) => g.project)).toEqual(["probe", "quiet"]);
  });
});

describe("switchboard queue delivery", () => {
  it("nudges running switchboards on post and resolve, and unregisters on stop", async () => {
    const { h, dir } = await setup();
    const stop = registerSwitchboardSession(h.home, "switchboard-session");
    h.live = ["switchboard-session"];
    const posted = await runWith(h, deskPost(dir, { kind: "decision", title: "Ship?" }));
    expect(h.sent.at(-1)).toMatchObject({ to: "switchboard-session", message: expect.stringContaining("decision") });
    await runWith(h, deskAnswer({ project: "probe", id: posted.record.id, answer: "yes" }));
    expect(h.sent.at(-1)?.message).toContain("resolved");
    expect(readDesk(queuePath("probe", h.home)).at(-1)?.resolves).toBe(posted.record.id);
    stop();
    h.sent.length = 0;
    await runWith(h, nudgeSwitchboards("probe", ask));
    expect(h.sent).toEqual([]);
  });

  it("nudges the desk by session id and says when no live session will read it", async () => {
    const { h, dir } = await setup();
    await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: dir }));
    const sessionId = (await runWith(h, load(dir))).agents.find((agent) => agent.name === "desk")!.sessionId;
    h.live = [];
    const first = await runWith(h, deskPost(dir, { kind: "decision", title: "Ship?" }));
    const quiet = await runWith(h, deskAnswer({ project: "probe", id: first.record.id, answer: "yes" }));
    expect(h.sent.at(-1)?.to).toBe(sessionId);
    expect(quiet.nudged).toEqual([`desk (${sessionId}): queued, no live session`]);
    h.live = [sessionId];
    const second = await runWith(h, deskPost(dir, { kind: "decision", title: "Again?" }));
    const heard = await runWith(h, deskAnswer({ project: "probe", id: second.record.id, answer: "no" }));
    expect(heard.nudged).toEqual([`desk (${sessionId}): sent`]);
  });

  it("doesn't turn an intercom failure into a failed write", async () => {
    const { h, dir } = await setup();
    registerSwitchboardSession(h.home, "switchboard-session");
    const broken = Layer.succeed(Comms)({ ...NetworkComms, sessions: () => Effect.succeed(undefined), send: () => Effect.die("disconnected") });
    const posted = await runWith(h, deskPost(dir, { kind: "decision", title: "Still writes" }).pipe(Effect.provide(broken)));
    await runWith(h, deskAnswer({ project: "probe", id: posted.record.id, answer: "yes" }).pipe(Effect.provide(broken)));
    expect(readDesk(queuePath("probe", h.home))).toHaveLength(2);
  });

  it("watches new queue files and registry replacements, not a frozen list of projects", async () => {
    const h = harness();
    const changed = vi.fn();
    const stop = watchSwitchboard(h.home, changed);
    try {
      writeFileSync(queuePath("brand-new", h.home), `${JSON.stringify(ask)}\n`);
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2000 });
      expect((await runWith(h, loadSystem)).groups[0]?.project).toBe("brand-new");
      changed.mockClear();
      const replacement = `${registryPath(h.home)}.new`;
      writeFileSync(replacement, `${JSON.stringify({ slug: "quiet", dir: "/missing", spaceId: null, ts: h.now.toISOString() })}\n`);
      renameSync(replacement, registryPath(h.home));
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2000 });
      expect((await runWith(h, loadSystem)).groups.map((g) => g.project)).toEqual(["brand-new", "quiet"]);
    } finally { stop(); }
  });
});

describe("live extension opt-in", () => {
  it("desk_inbox reads without subscribing; subscribe: true makes the session the Switchboard", async () => {
    const { h, dir } = await setup();
    const handlers = new Map<string, Function>();
    const tools = new Map<string, { execute: Function }>();
    const widgetRender = vi.fn();
    const overlayRender = vi.fn();
    let closeOverlay: (() => void) | undefined;
    let browse: ((ctx: unknown) => Promise<void>) | undefined;
    let widget: { render: (width: number) => string[] } | undefined;
    const pi = {
      registerFlag: () => {}, registerShortcut: (_key: string, options: { handler: (ctx: unknown) => Promise<void> }) => { browse = options.handler; }, registerCommand: () => {},
      on: (event: string, handler: Function) => handlers.set(event, handler),
      registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool),
      getFlag: () => false,
    };
    const ctx = {
      sessionManager: { getSessionId: () => "inbox-session" },
      ui: {
        setWidget: (_: string, factory?: Function) => { widget = factory?.({ requestRender: widgetRender }, plain); },
        custom: (factory: Function) => new Promise((resolve) => {
          factory({ requestRender: overlayRender }, plain, {}, resolve);
          closeOverlay = () => resolve({ type: "close" });
        }),
      },
    };
    registerSwitchboard(pi as never, { env: { HOME: h.home }, layer: () => h.layer, run: async (_ctx, _signal, program, render) => render(await runWith(h, program)) });
    await handlers.get("session_start")!(null, ctx);
    expect(widget).toBeUndefined();
    try {
      const peek = await tools.get("desk_inbox")!.execute("id", {}, undefined, undefined, ctx);
      expect(peek).toContain("probe (0) · quiet");
      expect(widget).toBeUndefined();
      await runWith(h, deskPost(dir, { kind: "fyi", title: "Seen by a peek" }));
      expect(h.sent.some((message) => message.to === "inbox-session")).toBe(false);
      const text = await tools.get("desk_inbox")!.execute("id", { subscribe: true }, undefined, undefined, ctx);
      expect(text).toContain("probe (0) · quiet");
      expect(widget?.render(100).join("\n")).toContain("inbox clear");
      const browsing = browse!(ctx);
      await vi.waitFor(() => expect(closeOverlay).toBeDefined());
      await runWith(h, deskPost(dir, { kind: "decision", title: "Fresh question" }));
      expect(h.sent.at(-1)?.to).toBe("inbox-session");
      await vi.waitFor(() => expect(widget?.render(100).join("\n")).toContain("1 open"), { timeout: 2500 });
      expect(widgetRender).toHaveBeenCalled();
      expect(overlayRender).toHaveBeenCalled();
      closeOverlay!();
      await browsing;
    } finally { handlers.get("session_shutdown")!(); }
    h.sent.length = 0;
    await runWith(h, nudgeSwitchboards("probe", ask));
    expect(h.sent).toEqual([]);
  });

  it("never registers a Muster-launched session as the Switchboard, even with subscribe: true", async () => {
    const { h, dir } = await setup();
    const handlers = new Map<string, Function>();
    const tools = new Map<string, { execute: Function }>();
    const notes: string[] = [];
    const pi = {
      registerFlag: () => {}, registerShortcut: () => {}, registerCommand: () => {},
      on: (event: string, handler: Function) => handlers.set(event, handler),
      registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool),
      getFlag: () => false,
    };
    const ctx = { sessionManager: { getSessionId: () => "desk-session" }, ui: { setWidget: () => {}, notify: (text: string) => notes.push(text) } };
    registerSwitchboard(pi as never, { env: { HOME: h.home, MUSTER_ROLE: "desk" }, layer: () => h.layer, run: async (_ctx, _signal, program, render) => render(await runWith(h, program)) });
    await handlers.get("session_start")!(null, ctx);
    try {
      await tools.get("desk_inbox")!.execute("id", { subscribe: true }, undefined, undefined, ctx);
      await runWith(h, deskPost(dir, { kind: "decision", title: "Not for the desk" }));
      expect(h.sent.some((message) => message.to === "desk-session")).toBe(false);
      expect(notes.join("\n")).toContain("not paged");
    } finally { handlers.get("session_shutdown")!(); }
  });
});

describe("desk focus", () => {
  it("focuses workspace then verified desk, pastes only when idle, never presses Enter", async () => {
    const { h, dir } = await setup();
    await runWith(h, agentLaunch(dir, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: dir }));
    const pane = [...h.herdr.panes.values()].find((p) => p.name === "desk")!;
    const client = h.herdr.client();
    let idle = true;
    const focusCalls: string[] = [];
    const override = Layer.succeed(Herdr)({ ...client, request: (request) => {
      if (request.method === "workspace.focus") { focusCalls.push("workspace"); return Effect.succeed({ type: "workspace_info", workspace: {} } as never); }
      if (request.method === "agent.get" || request.method === "agent.focus") {
        if (request.method === "agent.focus") focusCalls.push("desk");
        return Effect.succeed({ type: "agent_info", agent: { agent: "pi", agent_status: idle ? "idle" : "working", interactive_ready: true, terminal_id: pane.terminal_id, workspace_id: pane.workspace_id } } as never);
      }
      return client.request(request);
    } });
    const run = () => runWith(h, focusDesk("probe", "[probe#ask]").pipe(Effect.provide(override)));
    expect(await run()).toEqual({ live: true, typed: true });
    expect(focusCalls).toEqual(["workspace", "desk"]);
    expect(h.herdr.calls.at(-1)).toMatchObject({ method: "pane.send_text", params: { text: "[probe#ask] " } });
    h.herdr.calls.length = 0;
    idle = false;
    expect(await run()).toEqual({ live: true, typed: false });
    expect(h.herdr.calls.some((c) => c.method.startsWith("pane.send"))).toBe(false);
    pane.terminal_id = "reused";
    focusCalls.length = 0;
    expect(await run()).toEqual({ live: false, typed: false });
    expect(focusCalls).toEqual(["workspace"]);
  });
});
