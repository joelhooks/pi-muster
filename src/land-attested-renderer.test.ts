import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Packet } from "./domain.ts";
import { GuardFailed } from "./errors.ts";
import muster from "./extension-main.ts";
import * as ops from "./ops.ts";
import * as versionSkew from "./version-skew.ts";

const saved = { ...process.env };
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("MUSTER_")) delete process.env[key];
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (key.startsWith("MUSTER_")) delete process.env[key];
  Object.assign(process.env, saved);
});
function tool(name = "packet_land") {
  vi.spyOn(versionSkew, "createVersionSkew").mockReturnValue({ check: async () => undefined });
  type Def = { name: string; parameters: { properties: Record<string, unknown> }; execute: (...args: unknown[]) => Promise<{ content: unknown }> };
  const defs = new Map<string, Def>();
  // SAFETY: registration-only fake provides every host method used at extension startup.
  muster({ registerTool: (def: Def) => { defs.set(def.name, def); }, registerFlag: () => {}, registerCommand: () => {}, registerShortcut: () => {}, registerMessageRenderer: () => {}, on: () => {}, events: { on: () => () => {}, emit: () => {} } } as never);
  return defs.get(name)!;
}
const context = { cwd: "/p", sessionManager: { getSessionId: () => "test-session", getBranch: () => [] } };

describe("attested packet tool rendering", () => {
  it("renders the blind review file and judge instruction in verify output", async () => {
    const packet = Schema.decodeUnknownSync(Packet)({ id: "abc", kind: "commit", lane: "test", agent: "worker", artifact: null, report: "/p/report.svx", checks: [], state: "verified", verification: null, landedAs: null, reportedAt: "t", updatedAt: "t" });
    const note = 'Blind review brief: /p/abc-review.md. Run agent_launch role:"judge" with a prompt naming only that file.';
    vi.spyOn(ops, "packetVerify").mockReturnValue(Effect.succeed({ packet, checks: [], reviewFile: "/p/abc-review.md", note }));
    const result = await tool("packet_verify").execute("id", { id: "abc" }, undefined, undefined, context as never);
    expect(result.content).toContainEqual({ type: "text", text: `Packet abc verified.\n${note}` });
  });
  it.each(["run packet_verify on abc before landing it", 'abc does not match packet def; differing paths: "work"'])("adds a hint without changing structured guard message: %s", async message => {
    vi.spyOn(ops, "packetLand").mockReturnValue(Effect.fail(new GuardFailed({ guard: "verified", message })));
    const result = await tool().execute("id", { id: "abc", outcome: "committed" }, undefined, undefined, context as never);
    expect(result).toMatchObject({ isError: true, details: { error: { message } } });
    expect(result.content).toContainEqual({ type: "text", text: `GuardFailed: ${message}\nif the work landed inside a larger commit, pass attested: true with evidence` });
  });
  it("renders the attested marker and exposes the schema", async () => {
    const packet = Schema.decodeUnknownSync(Packet)({ id: "abc", kind: "commit", lane: "test", agent: "worker", artifact: null, report: "/p/report.svx", checks: [], state: "committed", verification: null, landedAs: "def", attested: true, reportedAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" });
    vi.spyOn(ops, "packetLand").mockReturnValue(Effect.succeed({ packet, note: "recorded an owner-attested landing", notes: [] }));
    const def = tool();
    expect(def.parameters.properties).toHaveProperty("attested");
    expect(def.parameters.properties).toHaveProperty("review");
    const result = await def.execute("id", { id: "abc", outcome: "committed", landedAs: "def", attested: true, evidence: "owner checked PR" }, undefined, undefined, context as never);
    expect(result.content).toContainEqual({ type: "text", text: "Packet abc committed as def (attested). recorded an owner-attested landing" });
  });
});
