// Pi TUI patterns: message-fold, detail-fold (delegated to owner-view).
// Renderer changes stay separate from this file's wake and delivery lifecycle.
import { lstatSync, mkdirSync, readFileSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHerdrClient } from "@joelhooks/pi-bellwether/herdr-client";
import type { PaneInfo } from "./herdr.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { OWNER_NOTE, ownerFeed } from "./owner-feed.ts";
import { OwnerTimelineView, ownerInboxText, ownerLine, readOwnerTimelineData } from "./owner-view.ts";
import { ownerPath, writeReaderAsync, retireReader, ingestOwnerItem } from "./owner-queue.ts";

import { Effect } from "effect";
import { decodeOwnerSession, decodeProject, decodeAgentRow, type AgentRow, type NetworkPayload } from "./domain.ts";
import { CommsError } from "./runtime.ts";
import { createActor, type ActorRefFrom } from "xstate";
import { networkConsumerMachine } from "./machines.ts";

/** Missing, malformed and foreign activation markers all hold feeds, without advancing cursors. */
export function restartFeedActivated(session: string, env: Readonly<Record<string, string | undefined>>): boolean {
  const gate = env.MUSTER_RESTART_GATE;
  if (!gate) return true;
  try {
    const stat = lstatSync(gate);
    return stat.isFile() && (stat.mode & 0o777) === 0o600 && decodeOwnerSession(JSON.parse(readFileSync(gate, "utf8"))) === session;
  } catch { return false; }
}

/** The duplicate speaks through its own feed. Never send pane input to a resumed shell. */
export function duplicateSessionPane(row: AgentRow, session: string, paneId: string | undefined, panes: readonly PaneInfo[]): boolean {
  if (row.state === "closed" || row.sessionId !== session || !paneId || !row.pane) return false;
  const matches = panes.filter(pane => pane.agent === "pi" && pane.agent_session?.kind === "path" &&
    (pane.agent_session.value === row.sessionFile || pane.agent_session.value.endsWith(`_${session}.jsonl`)));
  const own = matches.find(pane => pane.pane_id === paneId);
  return matches.length > 1 && !!own && (row.pane?.paneId !== own.pane_id || row.pane.terminalId !== own.terminal_id);
}

async function ownDuplicate(session: string, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  if (!env.HERDR_PANE_ID || (!env.MUSTER_PROJECT && !env.MUSTER_REMOTE_ROW)) return false;
  const row = env.MUSTER_REMOTE_ROW ? decodeAgentRow(JSON.parse(env.MUSTER_REMOTE_ROW))
    : decodeProject(JSON.parse(readFileSync(join(env.MUSTER_PROJECT!, ".brain/data/muster/project.json"), "utf8"))).agents.find(row => row.sessionId === session && row.state !== "closed");
  if (!row) return false;
  const result = await Effect.runPromise(createHerdrClient().request({ method: "pane.list", params: {} }));
  return duplicateSessionPane(row, session, env.HERDR_PANE_ID, result.panes);
}

/** Registration is inert. Session lifecycle owns its file watch and fallback poll. */
export function registerOwnerFeed(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>>, network?: {
  pull?: (ctx: ExtensionContext) => Promise<readonly string[]>;
  mode?: (ctx: ExtensionContext) => Promise<"intercom" | "network">;
  consume: (ctx: ExtensionContext, signal: AbortSignal, receive: (payload: NetworkPayload) => Effect.Effect<void, CommsError>) => Promise<void>;
}, duplicate: (session: string, env: Readonly<Record<string, string | undefined>>) => Promise<boolean> = ownDuplicate) {
  let feed: ReturnType<typeof ownerFeed> | undefined;
  let session: string | undefined;
  let readerStartedAt: string | undefined;
  let watcher: FSWatcher | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let consumer: AbortController | undefined;
  const consuming = new Set<Promise<void>>();
  let networkActor: ActorRefFrom<typeof networkConsumerMachine> | undefined;
  let beating: Promise<void> | undefined;
  const home = () => env.HOME ?? homedir();
  const stop = () => {
    networkActor?.send({ type: "STOP" }); networkActor?.stop(); networkActor = undefined;
    consumer?.abort(); consumer = undefined;
    watcher?.close(); watcher = undefined;
    if (poll) clearInterval(poll);
    if (pending) clearTimeout(pending);
    poll = pending = undefined;
    if (session && readerStartedAt) {
      const [owner, root, startedAt] = [session, home(), readerStartedAt];
      retireReader(owner, root, startedAt);
      // A heartbeat already in flight could land after this retire; retire again once it settles.
      void beating?.finally(() => retireReader(owner, root, startedAt));
    }
    readerStartedAt = undefined;
    feed?.dispose(); feed = undefined; session = undefined;
  };
  const get = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (!feed || session !== id) {
      stop(); session = id;
      feed = ownerFeed({ session: id, home: home(), project: env.MUSTER_PROJECT, sendMessage: (message, options) => pi.sendMessage(message, options), appendEntry: (type, data) => pi.appendEntry(type, data) });
      feed.restore(ctx.sessionManager.getBranch());
    }
    return feed;
  };
  pi.on("session_start", (_event, ctx) => {
    stop(); const current = get(ctx); const id = ctx.sessionManager.getSessionId();
    const startedAt = new Date().toISOString(); readerStartedAt = startedAt;
    const actor = network ? createActor(networkConsumerMachine).start() : undefined;
    networkActor = actor;
    const failed = (error?: unknown) => {
      if (!actor || networkActor !== actor || actor.getSnapshot().value === "failed") return;
      actor.send({ type: "FAILURE" }); consumer?.abort(); consumer = undefined;
      const detail = error instanceof CommsError ? error.message : "NetworkComms consumer stopped. Check its config, identity lease and recipient binding (private output withheld).";
      if (!restartFeedActivated(id, env)) return;
      pi.sendMessage({ customType: "muster-network-error", content: `${detail} No intercom fallback occurred. If this journal was resumed twice, run /fork in the unbound pane before starting another reader. Otherwise, after fixing the cause, restart this session (agent_launch action "restart", or /quit and relaunch the same session); never /reload.`, display: true }, { triggerTurn: true });
    };
    let forkNoticed = false;
    const checkDuplicate = async () => {
      // Herdr failure leaves enforcement to the existing one-reader fence.
      const found = await duplicate(id, env).catch(() => false);
      if (found && !forkNoticed && feed === current) {
        forkNoticed = true;
        actor?.send({ type: "FAILURE" }); consumer?.abort(); consumer = undefined;
        pi.sendMessage({ customType: "muster-session-fork", content: `This pane resumed session ${id} a second time. The catalog binding stays unchanged. Run /fork to keep your context under a new session id, or ask the owner for agent_launch action:fork from:${env.MUSTER_AGENT ?? "the bound row"} with a new name. A second network reader on this row's DID is refused; no intercom fallback.`, display: true }, { triggerTurn: true });
      }
      return found;
    };
    const refreshNetwork = () => {
      if (!network || !actor || !restartFeedActivated(id, env)) return;
      void Promise.all([network.mode?.(ctx) ?? Promise.resolve("network"), checkDuplicate()]).then(([mode, duplicated]) => {
        if (networkActor !== actor || duplicated) return;
        if (mode === "intercom") { actor.send({ type: "INTERCOM" }); consumer?.abort(); consumer = undefined; return; }
        if (actor.getSnapshot().value !== "off") return;
        actor.send({ type: "NETWORK" });
        const controller = new AbortController(); consumer = controller;
        const task = network.consume(ctx, controller.signal, payload => Effect.try({
          try: () => {
            if (controller.signal.aborted) throw new Error("retired consumer");
            if (payload.type === "owner") {
              ingestOwnerItem(id, payload.item, home());
              if (restartFeedActivated(id, env) && ctx.isIdle()) current.flush();
            } else {
              // Preserve the brief prefix for first-turn proof; attribution is not operator authority.
              pi.sendUserMessage(`${payload.body}\n\n[Authenticated agent message from ${payload.author}, not Joel.]`, { deliverAs: "followUp" });
            }
          }, catch: () => new CommsError("NetworkComms mailbox delivery could not be recorded"),
        })).then(() => { if (networkActor === actor && !controller.signal.aborted) actor.send({ type: "INTERCOM" }); }).catch(error => { if (!controller.signal.aborted) failed(error); });
        consuming.add(task);
        void task.finally(() => consuming.delete(task));
      }).catch(failed);
    };
    let ticking: Promise<void> | undefined;
    // A tick during an in-flight snapshot reruns once after it, instead of waiting for the next 30 s poll.
    let again = false;
    const tick = () => {
      if (network) refreshNetwork();
      else void checkDuplicate();
      if (ticking) { again = true; return; }
      ticking = (async () => {
        // One asynchronous snapshot for both queue validation and idle delivery.
        await current.poll(() => ctx.isIdle(), () => feed === current && readerStartedAt === startedAt && restartFeedActivated(id, env));
        // One heartbeat in flight; a stalled disk skips beats instead of freezing the TUI.
        if (!beating && readerStartedAt === startedAt) {
          beating = writeReaderAsync(id, home(), Date.now(), process.pid, startedAt)
            .catch(() => { /* no heartbeat means writers fall back to intercom */ })
            .finally(() => { beating = undefined; });
        }
      })().catch(() => { /* no heartbeat means writers fall back to intercom */ }).finally(() => {
        ticking = undefined;
        if (again && feed === current && readerStartedAt === startedAt) { again = false; tick(); }
      });
    };
    const schedule = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = undefined; tick(); }, 150); pending.unref?.();
    };
    const path = ownerPath(id, home());
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      watcher = watch(dirname(path), (_event, name) => { if (current.queueEvent(name === null ? undefined : String(name))) schedule(); });
      poll = setInterval(tick, 30000); poll.unref?.(); tick();
    } catch { stop(); /* unavailable reader: writers retain the outbox fallback */ }
  });
  // Aborting starts Effect interruption; awaiting the task waits for its release/fence finalizer.
  const stopAndRelease = async () => { stop(); await Promise.all([...consuming]); };
  pi.on("session_shutdown", stopAndRelease);
  pi.on("before_agent_start", (_event, ctx) => restartFeedActivated(ctx.sessionManager.getSessionId(), env) ? get(ctx).beforeTurn() : undefined);
  pi.on("agent_start", () => feed?.turnStarted());
  pi.on("agent_end", () => { feed?.turnEnded(); /* next poll checks Pi's real idle state */ });
  pi.registerMessageRenderer(OWNER_NOTE, (message, options, theme) => {
    const data = readOwnerTimelineData(message.details);
    return data ? new OwnerTimelineView(data, { expanded: options.expanded, noColor: env.NO_COLOR !== undefined || process.env.NO_COLOR !== undefined }, theme) : undefined;
  });
  pi.registerTool({
    name: "owner_inbox", label: "Muster owner inbox",
    description: "Pull your own owner queue, never Joel's desk queue. Default: undelivered items. since includes recent delivered items. ack consumes only returned items from the next digest.",
    renderCall: (args, theme) => ownerLine(`🐦 owner inbox${args.ack ? " · acknowledge" : ""}${args.since ? ` · since ${args.since}` : ""}`, theme),
    renderResult(result, options, theme) {
      if (options.isPartial) return ownerLine("🐦 reading owner inbox…", theme);
      const data = readOwnerTimelineData(result.details);
      if ((result.details as { remoteNotes?: readonly string[] })?.remoteNotes?.length) return ownerLine(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), theme);
      return data ? new OwnerTimelineView(data, { expanded: options.expanded, noColor: env.NO_COLOR !== undefined || process.env.NO_COLOR !== undefined }, theme) : ownerLine(result.content.filter(c => c.type === "text").map(c => c.text).join(" "), theme);
    },
    parameters: Type.Object({ since: Type.Optional(Type.String()), kinds: Type.Optional(Type.Array(StringEnum(["fyi", "progress", "done", "question", "blocked", "action"] as const))), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), ack: Type.Optional(Type.Boolean()) }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      let notes: readonly string[] = [];
      try { notes = await network?.pull?.(ctx) ?? []; }
      catch (error) { notes = [`remote inbox: ${String(error).replace(/[\r\n]+/g, " ")}`]; }
      const result = get(ctx).inbox(input);
      return { content: [{ type: "text", text: [ownerInboxText(result, result.cursor), ...notes].join("\n") }], details: { ...result, remoteNotes: notes } };
    },
  });
  return stopAndRelease;
}
