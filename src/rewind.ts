import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect, Schema } from "effect";
import { machineConfig, onRemote, remoteNode } from "./remote.ts";
import { GuardFailed, InputError } from "./errors.ts";
import { agentGet, agentReadinessRefusal, agentReady, call, paneGet, paneRun, paneSendKeys } from "./herdr.ts";
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


const remoteRewind = (row: import("./domain.ts").AgentRow, params: { to: string; note?: string | undefined }) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const machine = yield* machineConfig(row.machine);
  const imported = `import {openSessionTree,resolveSessionTarget,navigationLeaf} from ${JSON.stringify(`${machine.musterExtension}/src/session-tree.ts`)}; const tree=openSessionTree(process.argv[1]);`;
  const raw = yield* remoteNode(row.machine, machine, `${imported} const entryId=resolveSessionTarget(tree,process.argv[2]);console.log(JSON.stringify({entryId,leaf:tree.getLeafId(),expected:navigationLeaf(tree,entryId),ids:tree.getEntries().map(e=>e.id)}));`, [row.sessionFile!, params.to]);
  const snapshot = yield* sessionIO(() => Schema.decodeUnknownSync(Schema.Struct({ entryId: Schema.String, leaf: Schema.NullOr(Schema.String), expected: Schema.NullOr(Schema.String), ids: Schema.Array(Schema.String) }))(JSON.parse(raw)));
  if (!/^[A-Za-z0-9_.-]+$/.test(snapshot.entryId)) return yield* new InputError({ message: "remote rewind entry id is unsafe" });
  if (snapshot.leaf === snapshot.entryId) return yield* new GuardFailed({ guard: "rewind-target", message: "remote session is already at target; nothing submitted" });
  const binding = row.pane!;
  yield* onRemote(row.machine, machine, Effect.gen(function* () {
    const checkBinding = () => paneGet(binding.paneId).pipe(Effect.flatMap(pane => pane && pane.terminal_id === binding.terminalId && pane.agent_session?.value === row.sessionFile ? Effect.void : Effect.fail(new GuardFailed({ guard: "pane-binding", message: `${row.name}: remote terminal or session changed; nothing submitted` }))));
    yield* checkBinding();
    const state = yield* agentGet(binding.paneId);
    yield* checkReadyIdentity(state, row.name);
    if (state.agent_status === "working") yield* paneSendKeys(binding.paneId, ["Escape"]);
    if (!agentReady(state)) {
      const wait = yield* call({ method: "agent.wait", params: { target: binding.paneId, until: ["idle", "done"], timeout_ms: 30_000 }, timeoutMs: 35_000 });
      yield* checkReadyIdentity(wait.agent, row.name);
      if (!agentReady(wait.agent)) return yield* new GuardFailed({ guard: "rewind-idle", message: "remote session did not become idle or done; nothing submitted" });
    }
    yield* checkBinding();
    yield* paneRun(binding.paneId, `/muster-rewind ${snapshot.entryId}${params.note ? ` ${params.note}` : ""}`);
  }));
  // Each poll returns only entry ids. No transcript text crosses SSH or enters a local file.
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt++) {
    const evidence = (yield* remoteNode(row.machine, machine, `${imported} const old=new Set(JSON.parse(process.argv[2]));const expected=process.argv[3]||null;const branch=tree.getBranch();const found=branch.find(e=>!old.has(e.id)&&e.type==='branch_summary'&&e.parentId===expected);const leaf=tree.getLeafEntry();const label=leaf&&!old.has(leaf.id)&&leaf.type==='label'&&leaf.label==='rewound'&&leaf.parentId===expected;console.log(found?.id||(label?leaf.id:tree.getLeafId()===expected&&process.argv[4]!==expected?expected:'')||'');`, [row.sessionFile!, JSON.stringify(snapshot.ids), snapshot.expected ?? "", snapshot.leaf ?? ""])).trim();
    if (evidence) return { name: row.name, entryId: snapshot.entryId, note: params.note, evidence };
    yield* env.sleep(500);
  }
  return yield* new GuardFailed({ guard: "rewind-proof", message: `machine ${row.machine}: submitted once but no fresh branch evidence; inspect the pane before sending anything else` });
});

const sessionIO = <A>(run: () => A) => Effect.try({
  try: run, catch: error => new InputError({ message: String(error instanceof Error ? error.message : error) }),
});

const checkReadyIdentity = (agent: Parameters<typeof agentReadinessRefusal>[0], name: string) => {
  const reason = agentReadinessRefusal(agent, name);
  return reason ? Effect.fail(new GuardFailed({ guard: `rewind-${reason}`, message: `${name}: readiness refused: ${reason}; nothing submitted` })) : Effect.void;
};

/** Linear protocol: ownership → binding → interrupt if working → idle/done → submit once → fresh file evidence.
 * No catalog lifecycle change: the row remains a running worker on a different Pi branch. */
export const agentRewind = (dir: string, params: { name: string; to: string; note?: string | undefined }) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const project = yield* load(dir);
    const row = project.agents.find(agent => agent.name === params.name);
    if (!row) return yield* new InputError({ message: `no row ${params.name}` });
    if (row.owner !== env.sessionId) return yield* new GuardFailed({ guard: "owner", message: `${row.name} belongs to owner session ${row.owner}; only its owner can rewind it` });
    if (!row.pane || !row.sessionFile) return yield* new InputError({ message: `${row.name} needs a live pane and session file` });
    if (row.machine === "local" && row.pane.paneId === env.paneId) return yield* new InputError({ message: "cannot rewind the calling pane" });
    if (params.note?.includes("\n") || params.note?.includes("\r") || /[\x00-\x1f\x7f]/.test(params.note ?? "")) {
      return yield* new InputError({ message: "rewind note must be one line without control characters" });
    }
    if (row.machine !== "local") return yield* remoteRewind(row, params);
    const pane = yield* paneGet(row.pane.paneId);
    if (!pane || pane.terminal_id !== row.pane.terminalId || pane.agent_session?.value !== row.sessionFile) {
      return yield* new GuardFailed({ guard: "pane-binding", message: `${row.name}'s pane no longer matches its terminal and session file` });
    }
    const snapshot = yield* sessionIO(() => openSessionTree(row.sessionFile!));
    const entryId = yield* sessionIO(() => resolveSessionTarget(snapshot, params.to));
    if (!/^[A-Za-z0-9_.-]+$/.test(entryId)) return yield* new InputError({ message: "session entry id is not safe for a command argument" });
    const state = yield* agentGet(row.pane.paneId);
    yield* checkReadyIdentity(state, row.name);
    if (state.agent_status === "working") yield* paneSendKeys(row.pane.paneId, ["Escape"]);
    if (!agentReady(state)) {
      const waited = yield* call({ method: "agent.wait", params: { target: row.pane.paneId, until: ["idle", "done"], timeout_ms: 30_000 }, timeoutMs: 35_000 });
      yield* checkReadyIdentity(waited.agent, row.name);
      if (!agentReady(waited.agent)) return yield* new GuardFailed({ guard: "rewind-idle", message: `${row.name} did not become idle or done within 30 seconds; nothing submitted` });
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
