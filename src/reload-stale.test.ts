import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dependencyStamp, guardedLoad, musterToolNames } from "./reload-stale.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "muster-reload-"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), "root lock");
  writeFileSync(join(root, "node_modules/.package-lock.json"), "installed lock");
  return root;
}
function fake() {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };
  const defs = new Map<string, Tool>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
  const sendMessage = vi.fn();
  return { defs, hooks, sendMessage, pi: { registerTool: (tool: Tool) => defs.set(tool.name, tool), on: (event: string, handler: (event: unknown, ctx: unknown) => void) => hooks.set(event, handler), sendMessage } };
}
const ctx = { sessionManager: { getSessionFile: () => "/sessions/my session.jsonl" } };

describe("dependency reload gate", () => {
  it("loads the thin dynamic entry through Pi/jiti, then returns stubs on a changed install", () => {
    const output = execFileSync(process.execPath, ["src/reload-stale-repro.ts"], { encoding: "utf8", timeout: 20_000 });
    expect(output).toContain('"ok":true');
    expect(output).toContain('agent_launch action: \\"restart\\"');
  }, 25_000);
  it("hashes the installed lock, falling back to the root lock", () => {
    const root = fixture();
    const stamp = dependencyStamp(root);
    writeFileSync(join(root, "package-lock.json"), "changed root lock");
    expect(dependencyStamp(root)).toBe(stamp);
    writeFileSync(join(root, "node_modules/.package-lock.json"), "changed install");
    expect(dependencyStamp(root)).not.toBe(stamp);
    const fallback = mkdtempSync(join(tmpdir(), "muster-reload-fallback-"));
    writeFileSync(join(fallback, "package-lock.json"), "root lock");
    expect(dependencyStamp(fallback)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("records the first stamp and allows a second unchanged load", async () => {
    const root = fixture(); const f = fake(); const main = vi.fn(); const load = vi.fn(async () => ({ default: main }));
    await guardedLoad({ pi: f.pi as never, root, load, env: {} });
    const stamps: unknown = Reflect.get(globalThis, "__pi_muster_dependency_stamps_v1__");
    expect(stamps instanceof Map && stamps.get(realpathSync(root))).toBe(dependencyStamp(root));
    await guardedLoad({ pi: f.pi as never, root, load, env: {} });
    expect(load).toHaveBeenCalledTimes(2);
    expect(main).toHaveBeenCalledTimes(2);
    expect(f.defs.size).toBe(0);
  });
  it("blocks changed dependencies without importing, with session stubs and a quiet startup line", async () => {
    const root = fixture(); const load = vi.fn(async () => ({ default: vi.fn() }));
    await guardedLoad({ pi: fake().pi as never, root, load, env: {} });
    writeFileSync(join(root, "node_modules/.package-lock.json"), "upgraded");
    const f = fake();
    await guardedLoad({ pi: f.pi as never, root, load, env: {} });
    expect(load).toHaveBeenCalledTimes(1);
    expect([...f.defs.keys()]).toEqual(musterToolNames({}));
    const result = await f.defs.get("project_status")!.execute("id", { project: "/p" }, undefined, undefined, ctx);
    expect(result.content[0]?.text).toContain('agent_launch action: "restart" name: "<own row>"');
    expect(result.content[0]?.text).toContain("dependencies changed");
    f.hooks.get("session_start")!({}, ctx);
    expect(f.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('agent_launch action: "restart"'), display: true }), { triggerTurn: false });
    await guardedLoad({ pi: fake().pi as never, root, load, env: {} });
    expect(load).toHaveBeenCalledTimes(1); // Never advance the original stamp.
  });
  it("registers stubs with the first error line when the real import throws", async () => {
    const f = fake();
    await guardedLoad({ pi: f.pi as never, root: fixture(), load: async () => { throw new Error("Schema.TaggedError is not a function\nstack detail"); }, env: {} });
    const result = await f.defs.get("project_open")!.execute("id", {}, undefined, undefined, ctx);
    expect(result.content[0]?.text).toContain("Schema.TaggedError is not a function");
    expect(result.content[0]?.text).not.toContain("stack detail");
    expect(result.content[0]?.text).toContain('agent_launch action: "restart"');
  });
});
