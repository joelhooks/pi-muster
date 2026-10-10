import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import { sessionIdFromFile } from "./argv.ts";
import { appendDesk, deskRecord, queuePath, readDesk } from "./desk.ts";
import { InputError, NotFound } from "./errors.ts";
import { agentGet, call, paneGet, paneList, paneSendText, workspaceList } from "./herdr.ts";
import { PROCESS_STATES } from "./machines.ts";
import { readRegistry } from "./registry.ts";
import { subscribedSwitchboards, switchboardSessionsDir } from "./comms-ratking.ts";
import { Comms, MusterEnv } from "./runtime.ts";
import { load } from "./store.ts";
import { KIND_GLYPH, answerPost, deadDesk, fleetGroups, fleetStats, formatAge, inbox, itemRef, latestPost, openCount, queueDir, queueEvents, readQueues, recentPosts } from "./switchboard.ts";
import type { InboxGroup, SystemView, UnregisteredSpace } from "./switchboard.ts";
import { openDeskItems } from "./tokens.ts";

export { readRegistry, registerProject, registryPath } from "./registry.ts";
export type { RegistryEntry } from "./registry.ts";

export const loadInbox = Effect.gen(function* () {
  return (yield* loadSystem).groups;
});

/** Inbox, heat, and fleet in one read. A project whose file is gone or unreadable drops out of the fleet line. */
export const loadSystemWith = (read = readQueues) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const now = env.now().getTime();
  const queues = read(queueDir(env.home));
  const entries = [...readRegistry(env.home).values()];
  const projects = yield* Effect.forEach(entries, (entry) => load(entry.dir).pipe(Effect.option));
  const live = projects.flatMap((project) => (project._tag === "Some" ? [project.value] : []));
  // Topology is optional: a disconnected Herdr must not hide the queues.
  const spaces = yield* workspaceList().pipe(Effect.orElseSucceed(() => []));
  const panes = yield* paneList().pipe(Effect.orElseSucceed(() => []));
  const outside = new Set(live.filter((project) => project.agents.some((agent) =>
    agent.role === "desk" && agent.pane && PROCESS_STATES.includes(agent.state) &&
    panes.some((pane) => pane.pane_id === agent.pane?.paneId && pane.terminal_id === agent.pane?.terminalId && pane.workspace_id !== project.spaceId),
  ) || panes.some((pane) => {
    const session = pane.agent_session;
    const ownerId = session?.kind === "id" ? session.value : session?.kind === "file" ? sessionIdFromFile(session.value) : null;
    return ownerId && project.agents.some((agent) => PROCESS_STATES.includes(agent.state) && agent.owner === ownerId) && pane.workspace_id !== project.spaceId;
  })
    || project.lanes.some((lane) => lane.slug === "desk" && lane.root &&
    panes.some((pane) => pane.pane_id === lane.root?.paneId && pane.terminal_id === lane.root?.terminalId && pane.workspace_id !== project.spaceId),
  )).map((project) => project.slug));
  const intercom = yield* Comms;
  const sessions = yield* intercom.sessions().pipe(Effect.catchCause(() => Effect.succeed(undefined)));
  const registeredSpaces = new Set(entries.map((entry) => entry.spaceId));
  const view: SystemView = {
    groups: fleetGroups(inbox(queues, now), entries.map((entry) => entry.slug), outside).map((group) => ({
      ...group, deadDesk: deadDesk(live.find((project) => project.slug === group.project), sessions),
    })),
    unregistered: spaces.filter((space) => !registeredSpaces.has(space.workspace_id)).map((space) => ({ spaceId: space.workspace_id, label: space.label })),
    posts: recentPosts(queues, now),
    fleet: entries.length > 0 ? fleetStats(live) : null,
    latest: latestPost(queues),
    events: queueEvents(queues, now),
    now,
  };
  return view;
});

export const loadSystem = loadSystemWith();

export function inboxText(groups: readonly InboxGroup[], unregistered: readonly UnregisteredSpace[] = []): string {
  const lines = groups.length === 0 ? ["Inbox clear: nothing waits on Joel."] : [`${openCount(groups)} open across ${groups.length} project${groups.length === 1 ? "" : "s"} (blocked, then approvals, then decisions; oldest first):`];
  for (const group of groups) {
    lines.push("", `${group.project} (${group.items.length})${group.items.length ? "" : " · quiet"}${group.outsideSpace ? " · owner/desk outside space" : ""}`);
    for (const item of group.items) {
      lines.push(`- ${KIND_GLYPH[item.kind]} ${itemRef(item)} ${item.title} · ${formatAge(item.ageMs)} · from ${item.from}`);
      if (item.body) lines.push(`  ${item.body.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  for (const space of unregistered) lines.push(`\n${space.label} · unregistered · project_open adopts it`);
  return lines.join("\n");
}

/** Session ids are filenames, not a second queue or a transcript store. */
export { switchboardSessionsDir };

export function registerSwitchboardSession(home: string, sessionId: string, ratkingName?: string): () => void {
  const dir = switchboardSessionsDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, encodeURIComponent(sessionId));
  writeFileSync(path, ratkingName?.trim() ?? "");
  return () => { try { unlinkSync(path); } catch { /* Already removed. */ } };
}

/** Queue writes remain authoritative; a disconnected or stale session never fails the write. Returns notes for the receipt. */
export const nudgeSwitchboards = (project: string, record: { id: string; kind: string; resolves?: string | undefined }) =>
  Effect.gen(function* () {
    if (!record.resolves && !["blocked", "approval", "decision"].includes(record.kind)) return [] as string[];
    const env = yield* MusterEnv;
    const intercom = yield* Comms;
    const dir = switchboardSessionsDir(env.home);
    const named = process.env.MUSTER_SWITCHBOARD_SESSION?.trim();
    const targets = new Set([...(named ? [named] : []), ...(existsSync(dir) ? readdirSync(dir).map(decodeURIComponent) : [])]);
    const text = `☎️ Desk queue changed: [${project}#${record.resolves ?? record.id}] ${record.resolves ? "resolved" : record.kind}. Read desk_inbox for the current fleet; don't answer without Joel.`;
    const mode = intercom.mode ? yield* intercom.mode().pipe(Effect.orElseSucceed(() => "intercom" as const)) : "intercom";
    if (mode === "ratking") {
      // Each subscribed Switchboard by the Rat King name it recorded. Never the literal `switchboard`: that DID is
      // the legacy desk_phone consumer's. Never this Switchboard itself.
      if (process.env.MUSTER_SWITCHBOARD === "1") return [];
      const others = [...targets].filter(target => target !== env.sessionId);
      const recorded = subscribedSwitchboards(env.home);
      // One send per name, addressed by the subscribing session, which resolves to the name it recorded.
      const byName = new Map(others.flatMap(target => recorded[target] && recorded[target] !== process.env.RATKING_NAME ? [[recorded[target], target] as const] : []));
      const notes: string[] = [];
      if (others.length && !byName.size) notes.push("switchboard nudge skipped: no subscribed Switchboard recorded a Rat King name; it reads the queue on its next turn");
      for (const [name, session] of byName) {
        const result = yield* intercom.send(session, text).pipe(Effect.catchCause(() => Effect.succeed({ status: "failed" as const, detail: "send failed" })));
        if (result.status !== "delivered" && result.status !== "accepted") notes.push(`switchboard nudge to ${name}: ${result.status}${result.detail ? ` (${result.detail})` : ""}`);
      }
      return notes;
    }
    const live = yield* intercom.sessions();
    for (const target of targets) {
      if (target === env.sessionId || (live && !live.includes(target))) continue;
      yield* (intercom.relay ?? intercom.send)(target, text).pipe(Effect.catchCause(() => Effect.void));
    }
    return [] as string[];
  }).pipe(Effect.catchCause(() => Effect.succeed([] as string[])));

/** Focus only a terminal-verified desk binding. Never submit the reference. */
export const focusDesk = (slug: string, reference?: string) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const entry = readRegistry(env.home).get(slug);
  if (!entry?.spaceId) return { live: false, typed: false };
  yield* call({ method: "workspace.focus", params: { workspace_id: entry.spaceId } });
  const project = yield* load(entry.dir).pipe(Effect.orElseSucceed(() => null));
  const binding = project?.lanes.find((lane) => lane.slug === "desk" && lane.state === "open")?.root;
  if (!binding) return { live: false, typed: false };
  const pane = yield* paneGet(binding.paneId);
  if (!pane || pane.terminal_id !== binding.terminalId || pane.workspace_id !== entry.spaceId) return { live: false, typed: false };
  const agent = yield* agentGet(binding.paneId).pipe(Effect.orElseSucceed(() => null));
  if (!agent || !agent.agent || agent.terminal_id !== binding.terminalId || agent.workspace_id !== entry.spaceId) return { live: false, typed: false };
  yield* call({ method: "agent.focus", params: { target: binding.paneId } });
  const typed = Boolean(reference && agent.agent_status === "idle" && agent.interactive_ready === true);
  if (typed) yield* paneSendText(binding.paneId, `${reference} `);
  return { live: true, typed };
});

/** Borrow the current Switchboard consumer's lease; this tool never acquires or polls a mailbox. */
export const deskPhone = (input: { action: "send" | "poll" | "sync"; card?: unknown; page?: string | undefined }) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const [{ readDeskPhoneConfig }, { deskPhoneSnapshot, sendDeskPhone, syncDeskPhone }, { openNetworkMailbox, readNetworkIdentities }, { DeskInboxError }] = yield* Effect.promise(() => Promise.all([
    import("./desk-phone-store.ts"), import("./desk-phone.ts"), import("./comms-network.ts"), import("./desk-inbox.ts"),
  ]));
  const identities = yield* readDeskPhoneConfig(env.home);
  const own = yield* Effect.try({ try: () => readNetworkIdentities(env.home).switchboard?.did, catch: () => new DeskInboxError("desk_phone Switchboard identity cache is unavailable") });
  if (own !== identities.switchboard) return yield* Effect.fail(new DeskInboxError("desk_phone configured DID differs from the Switchboard network identity"));
  const mailbox = yield* openNetworkMailbox({ home: env.home, agent: "switchboard", configPath: process.env.MUSTER_NETWORK_CONFIG });
  const lease = yield* mailbox.lease.resolve(identities.switchboard);
  if (lease.did !== identities.switchboard || lease.harness.$type !== "sh.mschf.ratking.runtime.lease#pi" || lease.harness.sessionId !== env.sessionId || Date.parse(lease.expiresAt) <= env.now().getTime()) return yield* Effect.fail(new DeskInboxError("desk_phone requires this session's existing Switchboard network consumer and live lease; no second lease will be acquired"));
  const context = { home: env.home, identities, mailbox };
  switch (input.action) {
    case "send": return yield* sendDeskPhone({ ...context, card: input.card, page: input.page ?? "phone-rats-nest" });
    case "sync": return yield* syncDeskPhone(context);
    case "poll": return yield* deskPhoneSnapshot(env.home, identities);
  }
});

export interface DeskAnswerInput {
  readonly project: string;
  readonly id: string;
  readonly answer: string;
  readonly kind?: "done" | "fyi" | undefined;
}

/**
 * Resolve one open item in its own project's queue, then nudge that project's
 * desk by name when Muster knows it. The queue line is the answer; the
 * nudge only saves the desk a wait for its next turn.
 */
export const deskAnswer = (params: DeskAnswerInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const intercom = yield* Comms;
    const path = queuePath(params.project, env.home);
    const open = openDeskItems(readDesk(path));
    const item = open.find((candidate) => candidate.id === params.id);
    if (!item) return yield* new NotFound({ kind: "desk item", id: `${params.project}#${params.id}`, message: `no open item ${params.id} in ${params.project}'s queue` });
    const record = yield* Effect.try({
      try: () => deskRecord(answerPost(params.answer, item, params.kind ?? "done"), env.createId().slice(0, 8), env.now()),
      catch: (error) => new InputError({ message: error instanceof Error ? error.message : String(error) }),
    });
    appendDesk(path, record);
    yield* nudgeSwitchboards(params.project, record);

    const known = readRegistry(env.home).get(params.project);
    const project = known ? yield* load(known.dir).pipe(Effect.catch(() => Effect.succeed(null))) : null;
    const desks = project?.agents.filter((agent) => agent.role === "desk" && PROCESS_STATES.includes(agent.state)) ?? [];
    // Legacy intercom queues a send to a session that isn't connected and still reports "sent",
    // so liveness comes from the session list when there is one. Under ratking there is none.
    const live = desks.length ? yield* intercom.sessions().pipe(Effect.catchCause(() => Effect.succeed(undefined))) : undefined;
    const nudged: string[] = [];
    for (const desk of desks) {
      const message = `☎️ Joel answered ${itemRef({ project: params.project, id: item.id })} "${item.title}": ${params.answer.trim()}`;
      const result = yield* (intercom.relay ?? intercom.send)({ kind: "alias", project: params.project, row: desk.name }, message).pipe(Effect.catchCause(() => Effect.succeed({ status: "unavailable" as const })));
      const status = result.status === "delivered" && live && !live.includes(desk.sessionId) ? "queued, no live session" : result.status === "delivered" ? "sent" : result.status;
      nudged.push(`${desk.name} (${desk.sessionId}): ${status}`);
    }
    return { record, item, remaining: open.length - 1, nudged };
  });
