// Delivery is pi-ratking's. This feed watches only the session-local owner queue.
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
import { ownerPath, writeReaderAsync, retireReader } from "./owner-queue.ts";
import { Effect } from "effect";
import { decodeOwnerSession, decodeProject, decodeAgentRow, type AgentRow } from "./domain.ts";

export function restartFeedActivated(session: string, env: Readonly<Record<string, string | undefined>>): boolean {
  const gate = env.MUSTER_RESTART_GATE;
  if (!gate) return true;
  try { const stat = lstatSync(gate); return stat.isFile() && (stat.mode & 0o777) === 0o600 && decodeOwnerSession(JSON.parse(readFileSync(gate, "utf8"))) === session; }
  catch { return false; }
}
export function duplicateSessionPane(row: AgentRow, session: string, paneId: string | undefined, panes: readonly PaneInfo[]): boolean {
  if (row.state === "closed" || row.sessionId !== session || !paneId || !row.pane) return false;
  const matches = panes.filter(pane => pane.agent === "pi" && pane.agent_session?.kind === "path" && (pane.agent_session.value === row.sessionFile || pane.agent_session.value.endsWith(`_${session}.jsonl`)));
  const own = matches.find(pane => pane.pane_id === paneId);
  return matches.length > 1 && !!own && (row.pane.paneId !== own.pane_id || row.pane.terminalId !== own.terminal_id);
}
async function ownDuplicate(session: string, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  if (!env.HERDR_PANE_ID || (!env.MUSTER_PROJECT && !env.MUSTER_REMOTE_ROW)) return false;
  const row = env.MUSTER_REMOTE_ROW ? decodeAgentRow(JSON.parse(env.MUSTER_REMOTE_ROW)) : decodeProject(JSON.parse(readFileSync(join(env.MUSTER_PROJECT!, ".brain/data/muster/project.json"), "utf8"))).agents.find(row => row.sessionId === session && row.state !== "closed");
  if (!row) return false;
  const result = await Effect.runPromise(createHerdrClient().request({ method: "pane.list", params: {} }));
  return duplicateSessionPane(row, session, env.HERDR_PANE_ID, result.panes);
}
export function registerOwnerFeed(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>>, local?: { pull?: (ctx: ExtensionContext) => Promise<readonly string[]> }, duplicate = ownDuplicate) {
  let feed: ReturnType<typeof ownerFeed> | undefined;
  let session: string | undefined;
  let readerStartedAt: string | undefined;
  let watcher: FSWatcher | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let beating: Promise<void> | undefined;
  const home = () => env.HOME ?? homedir();
  const stop = () => {
    watcher?.close(); watcher = undefined;
    if (poll) clearInterval(poll); if (pending) clearTimeout(pending); poll = pending = undefined;
    if (session && readerStartedAt) {
      const [owner, root, startedAt] = [session, home(), readerStartedAt];
      retireReader(owner, root, startedAt); void beating?.finally(() => retireReader(owner, root, startedAt));
    }
    readerStartedAt = undefined; feed?.dispose(); feed = undefined; session = undefined;
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
    let forkNoticed = false;
    let ticking: Promise<void> | undefined; let again = false;
    const tick = () => {
      if (ticking) { again = true; return; }
      ticking = (async () => {
        if (!forkNoticed && await duplicate(id, env).catch(() => false) && feed === current) {
          forkNoticed = true;
          pi.sendMessage({ customType: "muster-session-fork", content: `This pane resumed session ${id} a second time. The catalog binding stays unchanged. Run /fork in this unbound pane. pi-ratking owns the name's single reader.`, display: true }, { triggerTurn: true });
        }
        await current.poll(() => ctx.isIdle(), () => feed === current && readerStartedAt === startedAt && restartFeedActivated(id, env));
        if (!beating && readerStartedAt === startedAt) beating = writeReaderAsync(id, home(), Date.now(), process.pid, startedAt).catch(() => {}).finally(() => { beating = undefined; });
      })().catch(() => {}).finally(() => { ticking = undefined; if (again && feed === current && readerStartedAt === startedAt) { again = false; tick(); } });
    };
    const schedule = () => { if (pending) clearTimeout(pending); pending = setTimeout(() => { pending = undefined; tick(); }, 150); pending.unref?.(); };
    try {
      const path = ownerPath(id, home()); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      watcher = watch(dirname(path), (_event, name) => { if (current.queueEvent(name === null ? undefined : String(name))) schedule(); });
      poll = setInterval(tick, 30000); poll.unref?.(); tick();
    } catch { stop(); }
  });
  const stopAndRelease = async () => { stop(); await beating; };
  pi.on("session_shutdown", stopAndRelease);
  pi.on("before_agent_start", (_event, ctx) => restartFeedActivated(ctx.sessionManager.getSessionId(), env) ? get(ctx).beforeTurn() : undefined);
  pi.on("agent_start", () => feed?.turnStarted());
  pi.on("agent_end", () => feed?.turnEnded());
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
      try { notes = await local?.pull?.(ctx) ?? []; } catch (error) { notes = [`remote inbox: ${String(error).replace(/[\r\n]+/g, " ")}`]; }
      const result = get(ctx).inbox(input);
      return { content: [{ type: "text", text: [ownerInboxText(result, result.cursor), ...notes].join("\n") }], details: { ...result, remoteNotes: notes } };
    },
  });
  return stopAndRelease;
}
