import { join } from "node:path";
import { Effect } from "effect";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import muster from "./extension-main.ts";
import * as ops from "./ops.ts";
import * as versionSkew from "./version-skew.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

it("forwards the optional discard flag and avoids a phantom root in lane_open output", async () => {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, ops.projectOpen({ dir, slug: "discard", outcome: "ship", reviewTrigger: "weekly", nextAction: "ship", space: "w1", ephemeral: true, deskExtension: null }));
  await runWith(h, ops.laneOpen(dir, { slug: "started", label: "started", goal: "ship" }));
  const closed = await runWith(h, ops.laneClose(dir, "started"));
  const parked = await runWith(h, ops.laneOpen(dir, { slug: "started", label: "started", goal: "ship", open: false }));
  const tools = new Map<string, ToolDefinition>();
  // SAFETY: registration-only fake implements the APIs used at extension startup.
  const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerFlag() {}, registerCommand() {}, registerShortcut() {}, on() {}, getFlag() {},
    registerMessageRenderer() {}, events: { on: () => () => {}, emit() {} } } as unknown as ExtensionAPI;
  vi.stubEnv("MUSTER_ROLE", "boss");
  vi.stubEnv("MUSTER_PROJECT", dir);
  try {
    vi.spyOn(versionSkew, "createVersionSkew").mockReturnValue({ check: async () => undefined });
    const close = vi.spyOn(ops, "laneClose").mockReturnValue(Effect.succeed(closed));
    vi.spyOn(ops, "laneOpen").mockReturnValue(Effect.succeed(parked));
    muster(pi);
    // SAFETY: mocked operations need only session identity, not live UI.
    const ctx = { cwd: dir, sessionManager: { getSessionId: () => "test", getBranch: () => [] } } as unknown as Parameters<ToolDefinition["execute"]>[4];
    const tool = tools.get("lane_close")!;
    expect(tool.parameters).toMatchObject({ properties: { discard: { type: "boolean" } } });
    expect(tool.parameters).not.toMatchObject({ required: expect.arrayContaining(["discard"]) });
    await tool.execute("id", { slug: "started", discard: true }, undefined, undefined, ctx);
    expect(close).toHaveBeenLastCalledWith(dir, "started", { discard: true });
    await tool.execute("id", { slug: "started" }, undefined, undefined, ctx);
    expect(close).toHaveBeenLastCalledWith(dir, "started", { discard: undefined });
    const result = await tools.get("lane_open")!.execute("id", { slug: "started", label: "started", goal: "ship", open: false }, undefined, undefined, ctx);
    expect(result.content).toContainEqual({ type: "text", text: "Lane started is closed." });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
