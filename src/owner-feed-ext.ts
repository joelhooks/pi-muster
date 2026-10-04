import { mkdirSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ownerFeed } from "./owner-feed.ts";
import { ownerPath, writeReader, retireReader } from "./owner-queue.ts";

/** Registration is inert. Session lifecycle owns its file watch and fallback poll. */
export function registerOwnerFeed(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>>) {
  let feed: ReturnType<typeof ownerFeed> | undefined;
  let session: string | undefined;
  let readerStartedAt: string | undefined;
  let watcher: FSWatcher | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const home = () => env.HOME ?? homedir();
  const stop = () => {
    watcher?.close(); watcher = undefined;
    if (poll) clearInterval(poll);
    if (pending) clearTimeout(pending);
    poll = pending = undefined;
    if (session && readerStartedAt) retireReader(session, home(), readerStartedAt);
    readerStartedAt = undefined;
    feed?.dispose(); feed = undefined; session = undefined;
  };
  const get = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (!feed || session !== id) {
      stop(); session = id;
      feed = ownerFeed({ session: id, home: home(), sendMessage: (message, options) => pi.sendMessage(message, options), appendEntry: (type, data) => pi.appendEntry(type, data) });
      feed.restore(ctx.sessionManager.getBranch());
    }
    return feed;
  };
  pi.on("session_start", (_event, ctx) => {
    stop(); const current = get(ctx); const id = ctx.sessionManager.getSessionId();
    const startedAt = new Date().toISOString(); readerStartedAt = startedAt;
    const tick = () => {
      try {
        // Do not advertise a reader that cannot read its queue, even when busy.
        current.inbox({ limit: 1 });
        if (ctx.isIdle()) current.flush();
        writeReader(id, home(), Date.now(), process.pid, startedAt);
      } catch { /* no heartbeat means writers fall back to intercom */ }
    };
    const schedule = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = undefined; tick(); }, 150); pending.unref?.();
    };
    const path = ownerPath(id, home());
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      watcher = watch(dirname(path), (_event, name) => { if (!name || String(name) === basename(path)) schedule(); });
      poll = setInterval(tick, 30000); poll.unref?.(); tick();
    } catch { stop(); /* unavailable reader: writers retain the outbox fallback */ }
  });
  pi.on("session_shutdown", stop);
  pi.on("before_agent_start", (_event, ctx) => get(ctx).beforeTurn());
  pi.on("agent_start", () => feed?.turnStarted());
  pi.on("agent_end", () => { feed?.turnEnded(); /* next poll checks Pi's real idle state */ });
  pi.registerTool({
    name: "owner_inbox", label: "Muster owner inbox",
    description: "Pull your own owner queue, never Joel's desk queue. Default: undelivered items. since includes recent delivered items. ack consumes only returned items from the next digest.",
    parameters: Type.Object({ since: Type.Optional(Type.String()), kinds: Type.Optional(Type.Array(StringEnum(["fyi", "progress", "done", "question", "blocked", "action"] as const))), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), ack: Type.Optional(Type.Boolean()) }),
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const result = get(ctx).inbox(input);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
