import { afterEach, expect, it, vi } from "vitest";
import muster from "./extension-main.ts";
import { harness } from "./test-support.ts";
import { inactiveOwnTools } from "./tool-loadout.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const MINE = "/pkg/pi-muster/extensions/pi-muster.ts";
const tool = (name: string, exposure = "direct", path = MINE) => ({ name, exposure, sourceInfo: { path } });

it("names only Muster's own active-on-registration tools that a restored journal left inactive", () => {
  const all = [tool("owner_inbox"), tool("packet_report"), tool("owner_note"), tool("deferred_one", "deferred"), tool("read", "direct", "builtin:read"), tool("other", "direct", "/x/other.ts")];
  expect(inactiveOwnTools(all, ["owner_inbox", "read"])).toEqual(["packet_report", "owner_note"]);
  expect(inactiveOwnTools(all, ["owner_inbox", "packet_report", "owner_note"])).toEqual([]);
  // Without the anchor (a --tools allowlist hid it, or Muster isn't loaded) nothing is guessed.
  expect(inactiveOwnTools(all.filter(entry => entry.name !== "owner_inbox"), [])).toEqual([]);
});

// calendar-app lime, 2026-10-24: a hand resume without MUSTER_ROLE recorded the worker tools as removed, and the
// restart's fork restored that set, so the worker tools registered but stayed inactive.
it("a worker reactivates its own tools at session start after its journal dropped them", async () => {
  const h = harness();
  vi.stubEnv("HOME", h.home); vi.stubEnv("RATKING_NAME", "off");
  vi.stubEnv("MUSTER_ROLE", "worker"); vi.stubEnv("MUSTER_AGENT", "lime"); vi.stubEnv("MUSTER_OWNER", "owner-session");
  vi.stubEnv("MUSTER_PROJECT", h.home); vi.stubEnv("MUSTER_MACHINE", "local");
  const registered: string[] = [];
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  let active = ["read", "bash", "owner_inbox", "owner_reply"];
  const setActiveTools = vi.fn((names: string[]) => { active = names; });
  const pi = {
    registerTool: (definition: { name: string }) => { registered.push(definition.name); },
    registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
    getFlag: () => undefined, getThinkingLevel: () => "medium", setThinkingLevel() {}, getCommands: () => [],
    getAllTools: () => [tool("read", "direct", "builtin:read"), ...registered.map(name => tool(name))],
    getActiveTools: () => active, setActiveTools, sendMessage() {}, sendUserMessage() {},
    events: { on: () => () => {}, emit() {} },
    on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, [...(hooks.get(event) ?? []), handler]),
  };
  const ctx = { cwd: h.home, hasUI: false, isIdle: () => true, ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: { getSessionId: () => "lime-session", getBranch: () => [], getEntries: () => [], getHeader: () => null } };
  muster(pi as never);
  const lifecycle = async (event: string) => { for (const handler of hooks.get(event) ?? []) await handler({}, ctx); };
  try {
    await lifecycle("session_start");
    expect(active).toEqual(expect.arrayContaining(["read", "bash", "owner_note", "packet_report", "context_mark"]));
    expect(setActiveTools).toHaveBeenCalledOnce();
    await lifecycle("session_start");
    expect(setActiveTools).toHaveBeenCalledOnce();
  } finally { await lifecycle("session_shutdown"); }
});
