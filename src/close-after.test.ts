import { describe, expect, it, vi } from "vitest";
import { closeAfterExit, pidAlive } from "../bin/muster-close-after.ts";
import { registerRestartExit } from "./extension-main.ts";
import { closeOwnedPane, finishRestart, spawnRestartCloser } from "./ops.ts";
import { harness, runWith } from "./test-support.ts";

const binding = { paneId: "old", terminalId: "terminal", tabId: "tab", openedByMuster: true };
function rig(alive: (pid: number) => boolean = () => false) {
  let time = 0;
  return { alive: vi.fn(alive), now: () => time, sleep: vi.fn(async (ms: number) => { time += ms; }),
    close: vi.fn(async () => "closed"), log: vi.fn() };
}

describe("detached restart closer", () => {
  it("waits for the Pi pid before closing", async () => {
    let probes = 0;
    const d = rig(pid => { expect(pid).toBe(123); return probes++ < 3; });
    d.sleep.mockImplementation(async () => { expect(d.close).not.toHaveBeenCalled(); });
    await closeAfterExit(123, binding, d);
    expect(d.sleep).toHaveBeenCalledTimes(3);
    expect(d.close).toHaveBeenCalledOnce();
  });
  it("never closes a live Pi on timeout", async () => {
    const d = rig(() => true);
    await closeAfterExit(123, binding, d);
    expect(d.now()).toBe(30_000);
    expect(d.close).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("still alive"));
  });
  it("does not probe or close adopted panes", async () => {
    const d = rig();
    await closeAfterExit(123, { ...binding, openedByMuster: false }, d);
    expect(d.alive).not.toHaveBeenCalled(); expect(d.close).not.toHaveBeenCalled();
  });
  it("logs probe failures without closing or throwing", async () => {
    const d = rig(() => { throw new Error("probe denied"); });
    await closeAfterExit(123, binding, d);
    expect(d.close).not.toHaveBeenCalled(); expect(d.log).toHaveBeenCalledWith(expect.stringContaining("probe denied"));
  });
  it("probes the current process as alive", () => { expect(pidAlive(process.pid)).toBe(true); });
  it("spawns detached with a startup log and unreferences; adopted panes spawn nothing", () => {
    const h = harness();
    const child = { on: vi.fn(), unref: vi.fn() };
    const start = vi.fn(() => child);
    spawnRestartCloser("/package", "/project", binding, "self restart", start as never, h.home);
    expect(start).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([String(process.pid), "/project", JSON.stringify(binding), "self restart"]), { detached: true, stdio: ["ignore", expect.any(Number), expect.any(Number)] });
    expect(child.unref).toHaveBeenCalledOnce();
    spawnRestartCloser("/package", "/project", { ...binding, openedByMuster: false }, "adopted", start as never, h.home);
    expect(start).toHaveBeenCalledOnce();
  });
  it("still spawns with ignored stdio when the startup log cannot be opened", () => {
    const start = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
    spawnRestartCloser("/package", "/project", binding, "restart", start as never, "/dev/null");
    expect(start).toHaveBeenCalledWith(process.execPath, expect.any(Array), { detached: true, stdio: "ignore" });
  });
  it("treats an already gone pane as a no-op", async () => {
    const h = harness();
    const d = rig();
    d.close.mockImplementation(() => runWith(h, closeOwnedPane(binding, h.root, "test")));
    await closeAfterExit(123, binding, d);
    expect(d.log).toHaveBeenCalledWith("pane old already gone");
    expect(h.herdr.calls.some(c => c.method === "pane.close")).toBe(false);
  });
  it("closes only the bound terminal, not a reused pane id", async () => {
    const h = harness();
    const old = h.herdr.addPane("w1", "t1", h.root);
    const original = { paneId: old.pane_id, terminalId: old.terminal_id, tabId: old.tab_id, openedByMuster: true };
    const d = rig();
    d.close.mockImplementation(() => runWith(h, closeOwnedPane(original, h.root, "test")));
    // Reuse the pane id for another terminal: the helper must leave it alone.
    old.terminal_id = "another-terminal";
    await closeAfterExit(123, original, d);
    expect(h.herdr.calls.some(c => c.method === "pane.close")).toBe(false);
    old.terminal_id = original.terminalId;
    await closeAfterExit(123, original, d);
    expect(h.herdr.calls.filter(c => c.method === "pane.close").map(c => c.params.pane_id)).toEqual([original.paneId]);
  });
  it("lets a fixture extension registered after Muster finish session_shutdown before any close", async () => {
    const h = harness();
    const old = h.herdr.addPane("w1", "t1", h.root);
    const replacement = h.herdr.addPane("w1", "t2", h.root);
    const oldPane = { paneId: old.pane_id, terminalId: old.terminal_id, tabId: old.tab_id, openedByMuster: true };
    const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = { on: (name: string, hook: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), hook]) };
    const start = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
    const arm = registerRestartExit(pi as never, pending => runWith(h, finishRestart(pending.dir, pending.restart, start as never)).then(() => {}));
    let recorded = false;
    // Fixture extension loads after Muster, just as Pi emits hooks sequentially.
    pi.on("session_shutdown", async () => {
      expect(h.herdr.calls.some(c => c.method === "pane.close")).toBe(false);
      await Promise.resolve(); recorded = true;
    });
    const ctx = { sessionManager: { getSessionId: () => "old" }, shutdown: vi.fn() };
    arm({ sessionId: "old", dir: h.root, restart: { oldPane,
      replacementPane: { paneId: replacement.pane_id, terminalId: replacement.terminal_id, tabId: replacement.tab_id, openedByMuster: true }, name: "worker" } });
    for (const hook of hooks.get("agent_end") ?? []) await hook({}, ctx);
    for (const hook of hooks.get("session_shutdown") ?? []) await hook({}, ctx);
    expect(recorded).toBe(true); expect(start).toHaveBeenCalledOnce();
    expect(h.herdr.calls.some(c => c.method === "pane.close")).toBe(false);
  });
});
