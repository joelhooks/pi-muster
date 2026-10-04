import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect } from "effect";
import { GuardFailed, InputError } from "./errors.ts";
import { agentGet, call, paneGet, paneRun, paneSendKeys } from "./herdr.ts";
import { MusterEnv } from "./runtime.ts";
import { load } from "./store.ts";
import { navigationLeaf, openSessionTree, resolveSessionTarget, rewindEvidence } from "./session-tree.ts";

export function registerWorkerNavigation(pi: ExtensionAPI, worker: boolean) {
  // Commands, unlike tools, have the command context required by Pi's navigation API.
  pi.registerCommand("muster-rewind", {
    description: "Rewind to a session entry, preserving a branch summary and optional steering note.",
    async handler(args, ctx) {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
      if (!match) throw new Error("Usage: /muster-rewind <entryId> [note]");
      await ctx.waitForIdle();
      const result = await ctx.navigateTree(match[1]!, {
        summarize: true, customInstructions: match[2], label: "rewound",
      });
      if (result.cancelled) throw new Error("Rewind cancelled; no corrected instruction sent");
    },
  });
  if (!worker) return;
  pi.registerTool({
    name: "context_mark", label: "Muster context mark",
    description: "Label the current leaf after reading the code you need, before editing. Defaults to ctx:ready.",
    parameters: Type.Object({ label: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const entryId = ctx.sessionManager.getLeafId();
      if (!entryId) throw new Error("No session leaf to label");
      const label = params.label ?? "ctx:ready";
      if (!label.trim()) throw new Error("context label must not be blank");
      pi.setLabel(entryId, label);
      return { content: [{ type: "text", text: `Marked ${entryId} as ${label}.` }], details: { entryId, label } };
    },
  });
}

const sessionIO = <A>(run: () => A) => Effect.try({
  try: run, catch: error => new InputError({ message: String(error instanceof Error ? error.message : error) }),
});

/** Linear protocol: ownership → binding → interrupt if working → idle → submit once → fresh file evidence.
 * No catalog lifecycle change: the row remains a running worker on a different Pi branch. */
export const agentRewind = (dir: string, params: { name: string; to: string; note?: string | undefined }) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const project = yield* load(dir);
    const row = project.agents.find(agent => agent.name === params.name);
    if (!row) return yield* new InputError({ message: `no row ${params.name}` });
    if (row.owner !== env.sessionId) return yield* new GuardFailed({ guard: "owner", message: `${row.name} belongs to owner session ${row.owner}; only its owner can rewind it` });
    if (!row.pane || !row.sessionFile) return yield* new InputError({ message: `${row.name} needs a live pane and session file` });
    if (row.pane.paneId === env.paneId) return yield* new InputError({ message: "cannot rewind the calling pane" });
    if (params.note?.includes("\n") || params.note?.includes("\r") || /[\x00-\x1f\x7f]/.test(params.note ?? "")) {
      return yield* new InputError({ message: "rewind note must be one line without control characters" });
    }
    const pane = yield* paneGet(row.pane.paneId);
    if (!pane || pane.terminal_id !== row.pane.terminalId || pane.agent_session?.value !== row.sessionFile) {
      return yield* new GuardFailed({ guard: "pane-binding", message: `${row.name}'s pane no longer matches its terminal and session file` });
    }
    const snapshot = yield* sessionIO(() => openSessionTree(row.sessionFile!));
    const entryId = yield* sessionIO(() => resolveSessionTarget(snapshot, params.to));
    if (!/^[A-Za-z0-9_.-]+$/.test(entryId)) return yield* new InputError({ message: "session entry id is not safe for a command argument" });
    const state = yield* agentGet(row.pane.paneId);
    if (state.agent_status === "working") yield* paneSendKeys(row.pane.paneId, ["Escape"]);
    if (state.agent_status !== "idle") {
      const waited = yield* call({ method: "agent.wait", params: { target: row.pane.paneId, until: ["idle"], timeout_ms: 30_000 }, timeoutMs: 35_000 });
      if (waited.agent.agent_status !== "idle") return yield* new GuardFailed({ guard: "rewind-idle", message: `${row.name} did not become idle within 30 seconds; nothing submitted` });
    }
    const currentPane = yield* paneGet(row.pane.paneId);
    if (!currentPane || currentPane.terminal_id !== row.pane.terminalId || currentPane.agent_session?.value !== row.sessionFile) {
      return yield* new GuardFailed({ guard: "pane-binding", message: `${row.name}'s binding changed while waiting; nothing submitted` });
    }
    const current = yield* sessionIO(() => openSessionTree(row.sessionFile!));
    const before = current.getEntries();
    // Already on the desired leaf: Pi navigateTree is a no-op and cannot produce fresh evidence.
    if (current.getLeafId() === entryId) return yield* new GuardFailed({ guard: "rewind-target", message: `${row.name} is already at ${entryId}; navigation would be a no-op and no steering note would be applied. Send the corrected instruction as usual.` });
    yield* paneRun(row.pane.paneId, `/muster-rewind ${entryId}${params.note ? ` ${params.note}` : ""}`);
    for (let attempt = 0; attempt < 120; attempt++) {
      const evidence = yield* sessionIO(() => rewindEvidence(openSessionTree(row.sessionFile!), before, entryId));
      if (evidence) return { name: row.name, entryId, note: params.note, evidence };
      yield* env.sleep(500);
    }
    return yield* new GuardFailed({ guard: "rewind-proof", message: `${row.name}: command submitted once but no fresh branch summary or leaf evidence for ${entryId} within 60 seconds. Inspect the pane before sending anything else (navigation leaf ${navigationLeaf(snapshot, entryId)}).` });
  });
