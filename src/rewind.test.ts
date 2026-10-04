import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { agentRewind, registerWorkerNavigation } from "./rewind.ts";
import { agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";
import { openSessionTree } from "./session-tree.ts";

async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "proof", outcome: "test rewind", reviewTrigger: "weekly", criticalPath: ["proof"], nextAction: "test", space: "w1", ephemeral: true, deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "proof", label: "🧪 proof", goal: "test" }));
  const launched = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "proof", cwd: dir, label: "🔨 worker" }));
  const file = launched.row.sessionFile!;
  // Persisted Pi entries rather than a synthetic line scraper seam.
  const tree = SessionManager.open(file);
  tree.appendMessage({ role: "user", content: "Read the code", timestamp: 1 });
  const target = tree.appendMessage({ role: "assistant", content: [{ type: "text", text: "Read" }], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6.1-sol", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  tree.appendLabelChange(target, "ctx:ready");
  tree.appendMessage({ role: "user", content: "Wrong instruction", timestamp: 3 });
  const original = h.herdr.handle.bind(h.herdr);
  let working = false;
  let stalled = false;
  let prove = true;
  h.herdr.handle = (method, params) => {
    if (method === "agent.get" || method === "agent.wait") {
      const result = original("agent.wait", params) as { agent: { agent_status: string } };
      result.agent.agent_status = method === "agent.get" ? (working ? "working" : "idle") : (stalled ? "working" : "idle");
      return result;
    }
    if (method === "pane.send_input" && String(params.text).startsWith("/muster-rewind")) {
      if (prove) tree.branchWithSummary(target, "Overruled instruction; use the correction");
    }
    return original(method, params);
  };
  return { h, dir, row: launched.row, tree, target, working: () => { working = true; }, stall: () => { stalled = true; }, noProof: () => { prove = false; } };
}

describe("worker navigation registration", () => {
  it("marks the current leaf with the default or supplied label", async () => {
    const setLabel = vi.fn();
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    registerWorkerNavigation({ registerCommand: vi.fn(), setLabel, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) } as never, true);
    const tool = tools.get("context_mark")!;
    const ctx = { sessionManager: { getLeafId: () => "leaf" } };
    await expect(tool.execute("id", {}, undefined, undefined, ctx)).resolves.toMatchObject({ details: { entryId: "leaf", label: "ctx:ready" } });
    await tool.execute("id", { label: "ctx:other" }, undefined, undefined, ctx);
    expect(setLabel.mock.calls).toEqual([["leaf", "ctx:ready"], ["leaf", "ctx:other"]]);
    await expect(tool.execute("id", {}, undefined, undefined, { sessionManager: { getLeafId: () => null } })).rejects.toThrow("No session leaf");
  });
  it("registers a command that calls command-context navigation with summary and note", async () => {
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    registerWorkerNavigation({ registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; } } as never, false);
    const navigateTree = vi.fn().mockResolvedValue({ cancelled: false });
    const waitForIdle = vi.fn();
    await handler("entry-id Correct the instruction", { navigateTree, waitForIdle });
    expect(navigateTree).toHaveBeenCalledWith("entry-id", { summarize: true, customInstructions: "Correct the instruction", label: "rewound" });
    expect(waitForIdle).toHaveBeenCalledOnce();
    navigateTree.mockResolvedValue({ cancelled: true });
    await expect(handler("entry-id", { navigateTree, waitForIdle })).rejects.toThrow("cancelled");
  });
});

describe("owner rewind protocol", () => {
  it("refuses non-owners before any Herdr action", async () => {
    const { h, dir } = await setup();
    h.herdr.calls.length = 0;
    h.sessionId = "stranger";
    expect(await failWith(h, agentRewind(dir, { name: "worker", to: "ctx:ready" }))).toMatchObject({ guard: "owner" });
    expect(h.herdr.calls).toEqual([]);
  });
  it("resolves a label, types the command once, and verifies fresh summary from disk", async () => {
    const { h, dir, target, row } = await setup();
    h.herdr.calls.length = 0;
    expect(await runWith(h, agentRewind(dir, { name: "worker", to: "ctx:ready", note: "Use the corrected plan" }))).toMatchObject({ entryId: target, note: "Use the corrected plan" });
    const sent = h.herdr.calls.filter(c => c.method === "pane.send_input");
    expect(sent).toEqual([{ method: "pane.send_input", params: { pane_id: row.pane!.paneId, text: `/muster-rewind ${target} Use the corrected plan`, keys: ["Enter"] } }]);
  });
  it("interrupts working agents and waits for idle before submitting", async () => {
    const { h, dir, target, working } = await setup();
    working();
    h.herdr.calls.length = 0;
    await runWith(h, agentRewind(dir, { name: "worker", to: target }));
    expect(h.herdr.calls.map(c => c.method)).toEqual(["pane.get", "agent.wait", "pane.send_keys", "agent.wait", "pane.get", "pane.send_input"]);
    expect(h.herdr.calls.find(c => c.method === "pane.send_keys")?.params.keys).toEqual(["Escape"]);
  });
  it("does not submit when idle wait expires", async () => {
    const { h, dir, working, stall } = await setup();
    working(); stall(); h.herdr.calls.length = 0;
    expect(await failWith(h, agentRewind(dir, { name: "worker", to: "ctx:ready" }))).toMatchObject({ guard: "rewind-idle" });
    expect(h.herdr.calls.some(c => c.method === "pane.send_input")).toBe(false);
  });
  it("does not accept old evidence or resend when verification expires", async () => {
    const { h, dir, tree, target, noProof } = await setup();
    tree.branchWithSummary(target, "old summary");
    noProof(); h.herdr.calls.length = 0;
    expect(await failWith(h, agentRewind(dir, { name: "worker", to: target }))).toMatchObject({ guard: "rewind-proof" });
    expect(h.herdr.calls.filter(c => c.method === "pane.send_input")).toHaveLength(1);
  });
  it("guards reused terminals and unknown labels before typing", async () => {
    const { h, dir, row } = await setup();
    expect(await failWith(h, agentRewind(dir, { name: "worker", to: "missing" }))).toMatchObject({ _tag: "InputError", message: expect.stringContaining("ctx:ready") });
    h.herdr.panes.get(row.pane!.paneId)!.terminal_id = "reused";
    expect(await failWith(h, agentRewind(dir, { name: "worker", to: "ctx:ready" }))).toMatchObject({ guard: "pane-binding" });
  });
  it("fails closed when a session binding changes during the idle wait", async () => {
    const { h, dir, row, working } = await setup();
    working();
    const handle = h.herdr.handle.bind(h.herdr);
    let waits = 0;
    h.herdr.handle = (method, params) => {
      const result = handle(method, params);
      if (method === "agent.wait" && ++waits === 1) h.herdr.panes.get(row.pane!.paneId)!.terminal_id = "new-terminal";
      return result;
    };
    h.herdr.calls.length = 0;
    expect(await failWith(h, agentRewind(dir, { name: "worker", to: "ctx:ready" }))).toMatchObject({ guard: "pane-binding" });
    expect(h.herdr.calls.some(c => c.method === "pane.send_input")).toBe(false);
  });
  it("does not claim that a no-op applied the steering note", async () => {
    const { h, dir, tree } = await setup();
    h.herdr.calls.length = 0;
    expect(await failWith(h, agentRewind(dir, { name: "worker", to: tree.getLeafId()!, note: "Use this instead" }))).toMatchObject({ guard: "rewind-target" });
    expect(h.herdr.calls.some(c => c.method === "pane.send_input")).toBe(false);
  });
  it("rejects multiline or terminal-control notes", async () => {
    const { h, dir } = await setup();
    expect(await failWith(h, agentRewind(dir, { name: "worker", to: "ctx:ready", note: "first\n/injected" }))).toMatchObject({ _tag: "InputError" });
  });
});

describe("warm fork launch integration", () => {
  it("rejects at on a non-fork launch", async () => {
    const { h, dir } = await setup();
    expect(await failWith(h, agentLaunch(dir, { action: "restore", name: "worker", at: "ctx:ready" }))).toMatchObject({ _tag: "InputError", message: "at is only valid with action fork" });
  });
  it("unknown at is an input error and does not start a pane", async () => {
    const { h, dir } = await setup();
    h.herdr.calls.length = 0;
    expect(await failWith(h, agentLaunch(dir, { action: "fork", name: "child", from: "worker", at: "missing" }))).toMatchObject({ _tag: "InputError", message: expect.stringContaining("ctx:ready") });
    expect(h.herdr.calls).toEqual([]);
  });
  it("launches through existing fork argv with a fresh name/id, clone and brief", async () => {
    const { h, dir, target, row } = await setup();
    const brief = join(dir, "child.md"); writeFileSync(brief, "Follow-up task");
    const result = await runWith(h, agentLaunch(dir, { action: "fork", name: "child", from: "worker", at: "ctx:ready", clone: true, brief }));
    expect(result.row.name).toBe("child");
    expect(result.row.sessionId).not.toBe(row.sessionId);
    expect(result.row.cwd).not.toBe(row.cwd);
    expect(result.row.brief).toBe(brief);
    const source = result.argv[result.argv.indexOf("--fork") + 1]!;
    expect(source).not.toBe(row.sessionFile);
    expect(openSessionTree(source).getLabel(target)).toBe("ctx:ready");
    expect(openSessionTree(source).getEntries().filter(e => e.type === "message" && e.message.role === "user")).toHaveLength(1);
  });
  it("without at retains full-session fork behaviour", async () => {
    const { h, dir, row } = await setup();
    const result = await runWith(h, agentLaunch(dir, { action: "fork", name: "child", from: "worker" }));
    expect(result.argv[result.argv.indexOf("--fork") + 1]).toBe(row.sessionFile);
  });
});
