// Pi TUI patterns: message-fold, detail-fold (delegated to owner-view).
// Renderer changes stay separate from this file's wake and delivery lifecycle.
import { mkdirSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { OWNER_NOTE, ownerFeed } from "./owner-feed.ts";
import { OwnerTimelineView, ownerInboxText, ownerLine, readOwnerTimelineData } from "./owner-view.ts";
import { ownerPath, writeReaderAsync, retireReader, ingestOwnerItem } from "./owner-queue.ts";

import { Effect } from "effect";
import type { NetworkPayload } from "./domain.ts";
import { CommsError } from "./runtime.ts";
import { createActor, type ActorRefFrom } from "xstate";
import { networkConsumerMachine } from "./machines.ts";

/** Registration is inert. Session lifecycle owns its file watch and fallback poll. */
export function registerOwnerFeed(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>>, network?: {
  mode?: (ctx: ExtensionContext) => Promise<"intercom" | "network">;
  consume: (ctx: ExtensionContext, signal: AbortSignal, receive: (payload: NetworkPayload) => Effect.Effect<void, CommsError>) => Promise<void>;
}) {
  let feed: ReturnType<typeof ownerFeed> | undefined;
  let session: string | undefined;
  let readerStartedAt: string | undefined;
  let watcher: FSWatcher | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let consumer: AbortController | undefined;
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
      pi.sendMessage({ customType: "muster-network-error", content: `${detail} No intercom fallback occurred. Reload or toggle comms off then on after fixing it.`, display: true }, { triggerTurn: true });
    };
    const refreshNetwork = () => {
      if (!network || !actor) return;
      void (network.mode?.(ctx) ?? Promise.resolve("network")).then(mode => {
        if (networkActor !== actor) return;
        if (mode === "intercom") { actor.send({ type: "INTERCOM" }); consumer?.abort(); consumer = undefined; return; }
        if (actor.getSnapshot().value !== "off") return;
        actor.send({ type: "NETWORK" });
        const controller = new AbortController(); consumer = controller;
        void network.consume(ctx, controller.signal, payload => Effect.try({
          try: () => {
            if (controller.signal.aborted) throw new Error("retired consumer");
            if (payload.type === "owner") {
              ingestOwnerItem(id, payload.item, home());
              if (ctx.isIdle()) current.flush();
            } else {
              // Preserve the brief prefix for first-turn proof; attribution is not operator authority.
              pi.sendUserMessage(`${payload.body}\n\n[Authenticated agent message from ${payload.author}, not Joel.]`, { deliverAs: "followUp" });
            }
          }, catch: () => new CommsError("NetworkComms mailbox delivery could not be recorded"),
        })).then(() => { if (networkActor === actor && !controller.signal.aborted) actor.send({ type: "INTERCOM" }); }).catch(error => { if (!controller.signal.aborted) failed(error); });
      }).catch(failed);
    };
    let ticking: Promise<void> | undefined;
    const tick = () => {
      refreshNetwork();
      if (ticking) return;
      ticking = (async () => {
        // One asynchronous snapshot for both queue validation and idle delivery.
        await current.poll(() => ctx.isIdle(), () => feed === current && readerStartedAt === startedAt);
        // One heartbeat in flight; a stalled disk skips beats instead of freezing the TUI.
        if (!beating && readerStartedAt === startedAt) {
          beating = writeReaderAsync(id, home(), Date.now(), process.pid, startedAt)
            .catch(() => { /* no heartbeat means writers fall back to intercom */ })
            .finally(() => { beating = undefined; });
        }
      })().catch(() => { /* no heartbeat means writers fall back to intercom */ }).finally(() => { ticking = undefined; });
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
  pi.on("session_shutdown", stop);
  pi.on("before_agent_start", (_event, ctx) => get(ctx).beforeTurn());
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
      return data ? new OwnerTimelineView(data, { expanded: options.expanded, noColor: env.NO_COLOR !== undefined || process.env.NO_COLOR !== undefined }, theme) : ownerLine(result.content.filter(c => c.type === "text").map(c => c.text).join(" "), theme);
    },
    parameters: Type.Object({ since: Type.Optional(Type.String()), kinds: Type.Optional(Type.Array(StringEnum(["fyi", "progress", "done", "question", "blocked", "action"] as const))), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), ack: Type.Optional(Type.Boolean()) }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const result = get(ctx).inbox(input);
      return { content: [{ type: "text", text: ownerInboxText(result, result.cursor) }], details: result };
    },
  });
}
