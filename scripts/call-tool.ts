#!/usr/bin/env node
// Call one Muster tool outside a Pi turn, through its registered execute():
//
//   MUSTER_CALL_SESSION=<owner session id> npx tsx scripts/call-tool.ts project_status '{"project":"/abs/dir"}'
//
// The owner is the named session; its pane-ownership rules apply as usual.
// Used for dogfood receipts and for operators without an owner Pi session.
import muster from "../extensions/pi-muster.ts";

type Tool = { name: string; execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }>; details: unknown; isError?: boolean }> };

const [name, raw = "{}"] = process.argv.slice(2);
const session = process.env.MUSTER_CALL_SESSION;
if (!name || !session) {
  console.error("usage: MUSTER_CALL_SESSION=<session id> npx tsx scripts/call-tool.ts <tool> '<json params>'");
  process.exit(2);
}

const tools = new Map<string, Tool>();
const listeners = new Map<string, Array<(payload: unknown) => void>>();
muster({
  registerTool: (tool: Tool) => tools.set(tool.name, tool),
  registerFlag: () => {},
  registerCommand: () => {},
  on: () => {},
  getFlag: () => undefined,
  appendEntry: () => {},
  events: {
    emit: (event: string, payload: unknown) => listeners.get(event)?.forEach((listener) => listener(payload)),
    on: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
    },
  },
} as never);

const tool = tools.get(name);
if (!tool) {
  console.error(`no tool ${name}; have ${[...tools.keys()].join(", ")}`);
  process.exit(2);
}
const result = await tool.execute("cli", JSON.parse(raw), undefined, undefined, {
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => session },
});
console.log(result.content.map((part) => part.text).join("\n"));
if (process.env.MUSTER_CALL_DETAILS) console.log(JSON.stringify(result.details, null, 2));
process.exit(result.isError ? 1 : 0);
