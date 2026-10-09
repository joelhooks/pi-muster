import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as versionSkew from "./version-skew.ts";
import { Cause, Effect, Schema } from "effect";
import * as ops from "./ops.ts";
import * as ownerQueue from "./owner-queue.ts";
import * as comms from "./comms.ts";
import { Packet, decodeOwnerItem } from "./domain.ts";
import { deskRecord } from "./desk.ts";
import { POST_NSID } from "./owner-lexicon.ts";

import muster, { failure as toolFailure } from "./extension-main.ts";
import { MailboxClientError } from "./vendor/rat-king-mailbox-client/error.ts";
import { musterToolNames } from "./reload-stale.ts";

function fakePi() {
  const tools: string[] = [];
  const defs = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
  let thinking = "high";
  const flags: string[] = [];
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const handlers: string[] = [];
  const hooks = new Map<string, Array<(event: { toolName: string; input: Record<string, unknown> }) => unknown>>();
  const emitted: string[] = [];
  const pi = {
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => {
      tools.push(tool.name);
      defs.set(tool.name, tool);
    },
    getThinkingLevel: () => thinking,
    // Like a model that has no xhigh: it clamps to high.
    setThinkingLevel: (level: string) => {
      thinking = level === "xhigh" ? "high" : level;
    },
    registerFlag: (name: string) => flags.push(name),
    registerCommand: (name: string) => commands.push(name),
    registerShortcut: (key: string) => shortcuts.push(key),
    on: (event: string, handler: (event: { toolName: string; input: Record<string, unknown> }) => unknown) => {
      handlers.push(event);
      hooks.set(event, [...(hooks.get(event) ?? []), handler]);
    },
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    appendEntry: vi.fn(),
    events: {
      emit: (event: string) => emitted.push(event),
      on: () => () => {},
    },
  };
  return { pi, tools, defs, flags, commands, shortcuts, handlers, hooks, emitted };
}

const saved = { ...process.env };
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("MUSTER_")) delete process.env[key];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (key.startsWith("MUSTER_")) delete process.env[key];
  Object.assign(process.env, saved);
});

const OWNER_TOOLS = [
  "desk_send",
  "thinking_set",
  "desk_inbox",
  "desk_answer",
  "desk_phone",
  "desk_report",
  "desk_rulings",
  "project_digest",
  "project_open",
  "project_move",
  "lane_open",
  "lane_deliver",
  "lane_close",
  "agent_launch",
  "agent_rewind",
  "agent_close",
  "packet_verify",
  "packet_land",
  "desk_post",
  "project_status",
  "project_update",
  "project_review",
];

describe("extension modes", () => {
  it("gives a plain session the owner tools and no worker tool, and starts nothing", () => {
    const fake = fakePi();
    muster(fake.pi as never);
    expect(fake.tools).toEqual(["owner_inbox", "owner_reply", "comms_doctor", "skill_find", ...OWNER_TOOLS]);
    expect(fake.tools).toEqual(musterToolNames(process.env));
    expect(fake.defs.get("project_status")).toMatchObject({ parameters: { properties: { takeover: { type: "boolean" } } } });
    expect(fake.flags).toEqual(["compact-at", "switchboard"]);
    expect(fake.commands).toEqual(["compact-at", "muster-rewind", "switchboard"]);
    expect(fake.shortcuts).toEqual(["alt+s"]);
    expect(fake.emitted).toEqual([]);
  });

  it("gives a worker packet_report and skill_find: no desk, no path to Joel", () => {
    Object.assign(process.env, { MUSTER_ROLE: "worker", MUSTER_AGENT: "w1", MUSTER_PROJECT: "/p", MUSTER_OWNER: "boss" });
    const fake = fakePi();
    muster(fake.pi as never);
    expect(fake.tools).toEqual(["owner_inbox", "owner_note", "owner_reply", "comms_doctor", "packet_report", "skill_find", "context_mark"]);
    expect(fake.tools).toEqual(musterToolNames(process.env));
  });

  it("gives a boss both sides: it reports up and owns its workers", () => {
    Object.assign(process.env, { MUSTER_ROLE: "boss", MUSTER_AGENT: "b1", MUSTER_PROJECT: "/p", MUSTER_OWNER: "hawk" });
    const fake = fakePi();
    muster(fake.pi as never);
    expect(fake.tools).toEqual(["owner_inbox", "owner_note", "owner_reply", "comms_doctor", "packet_report", "skill_find", ...OWNER_TOOLS]);
    expect(fake.tools).toEqual(musterToolNames(process.env));
  });
});

describe("registered tool version skew", () => {
  it("appends the warning to the real thinking_set tool through extension registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "muster-extension-skew-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    git("commit", "-q", "--allow-empty", "-m", "loaded");
    const loaded = git("rev-parse", "HEAD");
    const skew = versionSkew.createVersionSkew({ root });
    vi.spyOn(versionSkew, "createVersionSkew").mockReturnValue(skew);
    const fake = fakePi();
    muster(fake.pi as never);
    git("commit", "-q", "--allow-empty", "-m", "updated");
    const disk = git("rev-parse", "HEAD");
    const result = await fake.defs.get("thinking_set")?.execute("id", { level: "low" });
    expect(result?.content[0]?.text).toBe(`Thinking high → low, from the next model call.\n⚠ Muster tools are stale: loaded ${loaded.slice(0, 7)}, on disk ${disk.slice(0, 7)} (1 commits). Restart it onto current code with agent_launch action: "restart" (an owner, or a desk for itself); never /reload.`);
  });
});

describe("thinking_set", () => {
  it("changes the session's own thinking level and says when the model clamps it", async () => {
    const fake = fakePi();
    muster(fake.pi as never);
    const tool = fake.defs.get("thinking_set");
    expect((await tool?.execute("id", { level: "low" }))?.content[0]?.text).toBe("Thinking high → low, from the next model call.");
    expect((await tool?.execute("id", { level: "xhigh" }))?.content[0]?.text).toContain("this model clamps xhigh to high");
  });
});

const JOINED = "Collectionfence4/4behavior/propertytests";
const PLAIN = "Collection fence: all four behavior and property tests passed.";
const HINT = "Rewrite in plain sentences with spaces between words; put code, paths and ids in backticks.";
const notice = { id: "uri", uri: "uri", queued: true, woke: false, path: "queue" as const, delivery: { status: "delivered" as const }, owner: "boss", resolution: "explicit recipient", lost: false };
const cleanReport = { commit: "HEAD", summary: PLAIN, body: PLAIN, checks: [{ name: "Unit tests", outcome: "pass", detail: PLAIN }] };
const refusalCases: Array<[string, Record<string, unknown>]> = [
  ["packet_report", { ...cleanReport, summary: JOINED }],
  ["packet_report", { ...cleanReport, body: JOINED }],
  ["packet_report", { ...cleanReport, checks: [{ name: JOINED, outcome: "pass" }] }],
  ["packet_report", { ...cleanReport, checks: [{ name: "Unit tests", outcome: "pass", detail: JOINED }] }],
  ["owner_note", { kind: "fyi", title: JOINED, body: PLAIN }],
  ["owner_note", { kind: "fyi", title: PLAIN, body: JOINED, replyTo: "uri" }],
  ["owner_reply", { uri: "uri", text: JOINED }],
  ["owner_reply", { uri: "uri", text: `${PLAIN.repeat(100)}\n${JOINED}` }],
  ["desk_post", { kind: "fyi", title: JOINED, body: PLAIN }],
  ["desk_post", { kind: "fyi", title: PLAIN, body: JOINED }],
];

describe("readable message boundaries", () => {
  beforeEach(() => {
    Object.assign(process.env, { MUSTER_ROLE: "boss", MUSTER_AGENT: "b1", MUSTER_PROJECT: "/p", MUSTER_OWNER: "hawk" });
    vi.spyOn(versionSkew, "createVersionSkew").mockReturnValue({ check: async () => undefined });
    vi.spyOn(ops, "packetReport").mockReturnValue(Effect.succeed({
      packet: Schema.decodeUnknownSync(Packet)({ id: "1234567890ab", kind: "commit", lane: "test", agent: "b1", artifact: null, report: "/p/report.svx", checks: [], state: "reported", verification: null, landedAs: null, reportedAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" }),
      delivery: notice.delivery, notice,
    }));
    vi.spyOn(ops, "deskPost").mockReturnValue(Effect.succeed({ record: deskRecord({ kind: "fyi", title: PLAIN, from: "test" }, "12345678", new Date()), open: 1, path: "/p/desk.jsonl", notes: [] }));
    vi.spyOn(ownerQueue, "deliverOwnerItem").mockReturnValue(Effect.succeed(notice));
    vi.spyOn(ownerQueue, "findOwnerPost").mockReturnValue(decodeOwnerItem({ $type: POST_NSID, uri: "uri", cid: "cid", author: "boss", createdAt: "2026-10-04T00:00:00Z", text: PLAIN, kind: "fyi" }));
  });

  const context = () => ({ cwd: "/p", sessionManager: { getSessionId: () => "test-session", getBranch: () => [] } });

  it.each(refusalCases)("refuses %s before operations, queue reads, writes or intercom", async (name, params) => {
    const fake = fakePi();
    muster(fake.pi as never);
    const result = await fake.defs.get(name)!.execute("id", params, undefined, undefined, context());
    expect(result).toMatchObject({ isError: true, details: { ok: false } });
    expect(result.content[0]?.text).toContain(JSON.stringify(JOINED));
    expect(result.content[0]?.text).toContain(HINT);
    expect(ops.packetReport).not.toHaveBeenCalled();
    expect(ops.deskPost).not.toHaveBeenCalled();
    expect(ownerQueue.deliverOwnerItem).not.toHaveBeenCalled();
    expect(ownerQueue.findOwnerPost).not.toHaveBeenCalled();
    expect(fake.pi.appendEntry).not.toHaveBeenCalled();
    expect(fake.emitted).toEqual([]);
  });

  it.each([
    ["packet_report", cleanReport, "Packet"],
    ["owner_note", { kind: "fyi", title: PLAIN, body: PLAIN }, "owner:"],
    ["owner_reply", { uri: "uri", text: PLAIN }, "reply to:"],
    ["desk_post", { kind: "fyi", title: PLAIN, body: PLAIN }, "Posted desk item"],
  ])("accepts clean text for %s and reaches the operation", async (name, params, receipt) => {
    const fake = fakePi();
    muster(fake.pi as never);
    const result = await fake.defs.get(String(name))!.execute("id", params, undefined, undefined, context());
    expect(result).not.toHaveProperty("isError", true);
    expect(result.content[0]?.text).toContain(String(receipt));
    if (name === "packet_report") expect(ops.packetReport).toHaveBeenCalledOnce();
    else if (name === "desk_post") expect(ops.deskPost).toHaveBeenCalledOnce();
    else expect(ownerQueue.deliverOwnerItem).toHaveBeenCalledOnce();
  });

  it("quotes at most three squashed samples across all report fields", async () => {
    const fake = fakePi();
    muster(fake.pi as never);
    const samples = ["FirstJoinedWordsWithoutSpaces", "SecondJoinedWordsWithoutSpaces", "ThirdJoinedWordsWithoutSpaces", "FourthJoinedWordsWithoutSpaces"];
    const result = await fake.defs.get("packet_report")!.execute("id", { ...cleanReport, summary: samples[0], body: samples[1], checks: [{ name: samples[2], detail: samples[3], outcome: "pass" }] });
    for (const sample of samples.slice(0, 3)) expect(result.content[0]?.text).toContain(JSON.stringify(sample));
    expect(result.content[0]?.text).not.toContain(samples[3]);
  });

  it.each(["send", "ask", "reply"])("blocks squashed intercom %s only in a launched Muster session", async action => {
    const fake = fakePi();
    muster(fake.pi as never);
    const call = { toolName: "intercom", input: { action, message: JOINED } };
    const results = await Promise.all(fake.hooks.get("tool_call")!.map(hook => hook(call)));
    expect(results).toContainEqual({ block: true, reason: expect.stringContaining(HINT) });
    expect(fake.emitted).toEqual([]);
  });

  it("leaves ordinary Pi and unrelated intercom actions alone", async () => {
    const fake = fakePi();
    muster(fake.pi as never);
    const call = (action: string, message: unknown, toolName = "intercom") => Promise.all(fake.hooks.get("tool_call")!.map(hook => hook({ toolName, input: { action, message } })));
    for (const action of ["list", "status", "handover", "cancel"]) expect((await call(action, JOINED)).every(value => value === undefined)).toBe(true);
    expect((await call("send", PLAIN)).every(value => value === undefined)).toBe(true);
    expect((await call("send", 123)).every(value => value === undefined)).toBe(true);
    expect((await call("send", JOINED, "another_tool")).every(value => value === undefined)).toBe(true);
    for (const key of Object.keys(process.env)) if (key.startsWith("MUSTER_")) delete process.env[key];
    for (const action of ["send", "ask", "reply"]) expect((await call(action, JOINED)).every(value => value === undefined)).toBe(true);
  });
});

describe("retired intercom destinations", () => {
  it.each(["send", "ask", "reply", "handover"])("blocks %s to an exact retired id, not a row alias", async action => {
    const reason = "session old-session retired by restart; successor new-session; send to probe/desk or the new id";
    vi.spyOn(comms, "retiredSessionReason").mockImplementation((_home, to) => to === "old-session" ? reason : undefined);
    const fake = fakePi();
    muster(fake.pi as never);
    const call = (to: string) => Promise.all(fake.hooks.get("tool_call")!.map(hook => hook({ toolName: "intercom", input: { action, to, message: "Hello." } })));
    expect(await call("old-session")).toContainEqual({ block: true, reason });
    expect((await call("probe/desk")).every(value => value === undefined)).toBe(true);
    expect((await call("new-session")).every(value => value === undefined)).toBe(true);
    expect(fake.emitted).toEqual([]);
  });
});

describe("tool failure text", () => {
  it("names a schema error's code, reason and status instead of an empty message", () => {
    const text = toolFailure(Cause.fail(new MailboxClientError({ error: "LeaseNotFound", reason: "LeaseNotFound", status: 404 }))).content[0]!.text;
    expect(text).toBe("MailboxClientError: LeaseNotFound · status 404");
  });
});
