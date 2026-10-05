import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

import { queuePath } from "./desk.ts";
import { FEED_CLAIM, NOTE, NOTE_GLYPH, deskFeed, summaryText } from "./desk-feed.ts";
import type { InboxSummary, NoteMessage } from "./desk-feed.ts";
import type { DeskItem } from "./domain.ts";
import { readRegistry } from "./registry.ts";

const DEBOUNCE_MS = 150;
/** fs.watch can miss events on some filesystems; the poll is the floor. */
const POLL_MS = 30_000;
const BODY_PREVIEW = 280;
const KIND_COLOR: Readonly<Record<string, string>> = { blocked: "error", approval: "warning", decision: "accent", done: "success", fyi: "muted" };
const OWNER = "pi-muster";

type Claims = { [FEED_CLAIM]?: string };

/**
 * Which desk this session is. The env names it when Muster launched the desk;
 * a desk resumed by hand has no env, so its session id is looked up among the
 * desk rows of every registered project.
 */
export function deskProjectFor(sessionId: string, env: Readonly<Record<string, string | undefined>>, home: string): string | null {
  const named = env.HERDR_DESK_PROJECT?.trim();
  if (named) return named;
  for (const entry of readRegistry(home).values()) {
    try {
      const project = JSON.parse(readFileSync(join(entry.dir, ".brain", "data", "muster", "project.json"), "utf8")) as {
        slug: string;
        agents: ReadonlyArray<{ role: string; sessionId: string; state: string }>;
      };
      if (project.agents.some((agent) => agent.role === "desk" && agent.sessionId === sessionId && agent.state !== "closed")) return project.slug;
    } catch {
      // A moved or unreadable project names no desk.
    }
  }
  return null;
}

const clock = (ts: string) => {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** Desk notes: each new queue line lands in the desk's feed as a card with the desk's inbox as its footer. */
export function registerDeskFeed(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>>) {
  let feed: ReturnType<typeof deskFeed> | undefined;
  let watcher: FSWatcher | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const claims = globalThis as Claims;

  const stop = () => {
    watcher?.close();
    watcher = undefined;
    if (poll) clearInterval(poll);
    if (pending) clearTimeout(pending);
    poll = pending = undefined;
    feed = undefined;
  };

  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      feed?.flush();
    }, DEBOUNCE_MS);
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    // Another desk feed in this process (the dark-wizard extension) already delivers: never twice.
    if (claims[FEED_CLAIM] && claims[FEED_CLAIM] !== OWNER) return;
    const home = env.HOME ?? homedir();
    const project = deskProjectFor(ctx.sessionManager.getSessionId(), env, home);
    if (!project) return;
    claims[FEED_CLAIM] = OWNER;
    const path = queuePath(project, home);
    feed = deskFeed({
      project,
      path,
      home,
      session: ctx.sessionManager.getSessionId(),
      // agent_end still counts as streaming in Pi; never steer a card into another turn.
      sendMessage: (message: NoteMessage) => pi.sendMessage(message, { triggerTurn: false }),
      appendEntry: (type, data) => pi.appendEntry(type, data),
    });
    feed.restore(ctx.sessionManager.getBranch() as ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    watcher = watch(dir, (_type, name) => {
      if (!name || name === basename(path)) schedule();
    });
    poll = setInterval(schedule, POLL_MS);
    // Lines posted while the desk was down or reloading arrive now, not at Joel's next turn.
    schedule();
  });
  pi.on("session_shutdown", () => {
    if (feed && claims[FEED_CLAIM] === OWNER) delete claims[FEED_CLAIM];
    stop();
  });
  pi.on("before_agent_start", () => feed?.beforeTurn());
  pi.on("agent_start", () => feed?.turnStarted());
  pi.on("agent_end", () => {
    feed?.turnEnded();
  });

  pi.registerMessageRenderer(NOTE, (message, options, theme) => {
    const details = message.details as { project?: string; items?: readonly DeskItem[]; inbox?: InboxSummary; flow?: string } | undefined;
    if (!details?.items || !details.inbox) return undefined;
    const box = new Box((options as { outputPad?: number }).outputPad ?? 1, 1, (text: string) => theme.bg("customMessageBg", text));
    if (details.flow) {
      const flow = details.flow;
      box.addChild({ invalidate() {}, render: width => [theme.fg(flow.startsWith("⚠") ? "warning" : "dim", truncateToWidth(flow, width))] });
      if (!details.items.length) return box;
    }
    details.items.forEach((item, index) => {
      if (index > 0) box.addChild(new Spacer(1));
      const kind = theme.fg((KIND_COLOR[item.kind] ?? "muted") as never, theme.bold(item.kind));
      box.addChild(new Text(`${NOTE_GLYPH[item.kind] ?? "•"} ${kind}  ${theme.bold(item.title)}`, 0, 0));
      const meta = [item.from, clock(item.ts), `#${item.id}`, item.resolves ? `resolves #${item.resolves}` : ""].filter(Boolean);
      box.addChild(new Text(theme.fg("dim", meta.join(" · ")), 0, 0));
      if (item.body) {
        const body = item.body.trim();
        const shown = options.expanded || body.length <= BODY_PREVIEW ? body : `${body.slice(0, BODY_PREVIEW - 1).trimEnd()}…`;
        box.addChild(new Text(shown, 0, 0));
      }
      if (options.expanded && item.refs?.length) box.addChild(new Text(theme.fg("dim", `↳ ${item.refs.join(", ")}`), 0, 0));
    });
    box.addChild(new Spacer(1));
    box.addChild(new Text(theme.fg("muted", `📥 ${details.project ?? "desk"} desk · ${summaryText(details.inbox)}`), 0, 0));
    return box;
  });
}

