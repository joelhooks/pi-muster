import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STAMPS = "__pi_muster_dependency_stamps_v1__";
type ProcessState = typeof globalThis & { [STAMPS]?: Map<string, string> };

/** npm rewrites the hidden lock for the installed tree, not just the desired tree. */
export function dependencyStamp(root: string): string {
  let lock: Buffer;
  try { lock = readFileSync(join(root, "node_modules", ".package-lock.json")); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    lock = readFileSync(join(root, "package-lock.json"));
  }
  return createHash("sha256").update(lock).digest("hex");
}

/** Kept independent of Effect/Bellwether; extension tests prove parity with registration. */
export function musterToolNames(env: Readonly<NodeJS.ProcessEnv>): string[] {
  const worker = env.MUSTER_ROLE === "worker";
  return [
    "owner_inbox",
    ...((worker || env.MUSTER_ROLE === "boss") && env.MUSTER_OWNER ? ["owner_note"] : []),
    "owner_reply",
    ...(env.MUSTER_AGENT && env.MUSTER_PROJECT && env.MUSTER_OWNER ? ["packet_report"] : []),
    "skill_find",
    ...(worker ? ["context_mark"] : [
      "thinking_set", "desk_inbox", "desk_answer", "desk_report", "desk_rulings", "project_digest",
      "project_open", "project_move", "lane_open", "lane_deliver", "lane_close", "agent_launch",
      "agent_rewind", "agent_close", "packet_verify", "packet_land", "desk_post", "project_status", "project_update", "project_review",
    ]),
  ];
}

type Failure = { kind: "stale" } | { kind: "load"; line: string };
function restartMessage(failure: Failure, ctx: ExtensionContext): string {
  const file = ctx.sessionManager.getSessionFile();
  // JSON quoting is shell-safe for ordinary paths; escape shell expansion inside double quotes.
  const quoted = file ? JSON.stringify(file).replace(/[$`]/g, "\\$&") : "<session file>";
  const reason = failure.kind === "stale"
    ? "pi-muster's dependencies changed after this Pi started, and /reload can't load them."
    : `pi-muster failed to load: ${failure.line}.`;
  return `⚠ ${reason} Restart Pi on this session: pi --session ${quoted}.`;
}

function registerStubs(pi: ExtensionAPI, env: Readonly<NodeJS.ProcessEnv>, failure: Failure) {
  for (const name of musterToolNames(env)) {
    pi.registerTool({
      name, label: `Muster unavailable: ${name}`,
      description: "Muster could not load. Returns the failure and the command to restart this session.",
      // Accept old calls too: validation must not hide the recovery message.
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute(_id, _params, _signal, _update, ctx) {
        return { content: [{ type: "text", text: restartMessage(failure, ctx) }], details: { ok: false, reason: failure.kind }, isError: true };
      },
    });
  }
  pi.on("session_start", (_event, ctx) => {
    pi.sendMessage({ customType: "muster-load-warning", content: restartMessage(failure, ctx), display: true }, { triggerTurn: false });
  });
}

/** First stamp → unchanged import, changed stamp → stubs. Never bless an upgraded tree in this process. */
export async function guardedLoad({ pi, root, load, env = process.env }: {
  pi: ExtensionAPI;
  root: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  load: () => Promise<{ default: (pi: ExtensionAPI) => void | Promise<void> }>;
}): Promise<void> {
  let failure: Failure;
  try {
    const state: ProcessState = globalThis;
    const stamps = state[STAMPS] ??= new Map();
    const key = realpathSync(root);
    const stamp = dependencyStamp(root);
    const loaded = stamps.get(key);
    if (loaded !== undefined && loaded !== stamp) {
      registerStubs(pi, env, { kind: "stale" });
      return;
    }
    stamps.set(key, stamp);
    const main = await load();
    await main.default(pi);
    return;
  } catch (error) {
    failure = { kind: "load", line: (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0] ?? "unknown error" };
  }
  registerStubs(pi, env, failure);
}
