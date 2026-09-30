import { Effect } from "effect";

import { appendDesk, deskRecord, queuePath, readDesk } from "./desk.ts";
import { InputError, NotFound } from "./errors.ts";
import { PROCESS_STATES } from "./machines.ts";
import { readRegistry } from "./registry.ts";
import { Intercom, MusterEnv } from "./runtime.ts";
import { load } from "./store.ts";
import { KIND_GLYPH, answerPost, fleetStats, formatAge, inbox, itemRef, latestPost, openCount, queueDir, readQueues, recentPosts } from "./switchboard.ts";
import type { InboxGroup, SystemView } from "./switchboard.ts";
import { openDeskItems } from "./tokens.ts";

export { readRegistry, registerProject, registryPath } from "./registry.ts";
export type { RegistryEntry } from "./registry.ts";

export const loadInbox = Effect.gen(function* () {
  const env = yield* MusterEnv;
  return inbox(readQueues(queueDir(env.home)), env.now().getTime());
});

/** Inbox, heat, and fleet in one read. A project whose file is gone or unreadable drops out of the fleet line. */
export const loadSystem = Effect.gen(function* () {
  const env = yield* MusterEnv;
  const now = env.now().getTime();
  const queues = readQueues(queueDir(env.home));
  const entries = [...readRegistry(env.home).values()];
  const projects = yield* Effect.forEach(entries, (entry) => load(entry.dir).pipe(Effect.option));
  const live = projects.flatMap((project) => (project._tag === "Some" ? [project.value] : []));
  const view: SystemView = {
    groups: inbox(queues, now),
    posts: recentPosts(queues, now),
    fleet: entries.length > 0 ? fleetStats(live) : null,
    latest: latestPost(queues),
    now,
  };
  return view;
});

export function inboxText(groups: readonly InboxGroup[]): string {
  if (groups.length === 0) return "Inbox clear: nothing waits on Joel.";
  const lines = [`${openCount(groups)} open across ${groups.length} project${groups.length === 1 ? "" : "s"} (blocked, then approvals, then decisions; oldest first):`];
  for (const group of groups) {
    lines.push("", `${group.project} (${group.items.length})`);
    for (const item of group.items) {
      lines.push(`- ${KIND_GLYPH[item.kind]} ${itemRef(item)} ${item.title} · ${formatAge(item.ageMs)} · from ${item.from}`);
      if (item.body) lines.push(`  ${item.body.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}

export interface DeskAnswerInput {
  readonly project: string;
  readonly id: string;
  readonly answer: string;
  readonly kind?: "done" | "fyi" | undefined;
}

/**
 * Resolve one open item in its own project's queue, then nudge that project's
 * desk over intercom when Muster knows it. The queue line is the answer; the
 * nudge only saves the desk a wait for its next turn.
 */
export const deskAnswer = (params: DeskAnswerInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const intercom = yield* Intercom;
    const path = queuePath(params.project, env.home);
    const open = openDeskItems(readDesk(path));
    const item = open.find((candidate) => candidate.id === params.id);
    if (!item) return yield* new NotFound({ kind: "desk item", id: `${params.project}#${params.id}`, message: `no open item ${params.id} in ${params.project}'s queue` });
    const record = yield* Effect.try({
      try: () => deskRecord(answerPost(params.answer, item, params.kind ?? "done"), env.createId().slice(0, 8), env.now()),
      catch: (error) => new InputError({ message: error instanceof Error ? error.message : String(error) }),
    });
    appendDesk(path, record);

    const known = readRegistry(env.home).get(params.project);
    const project = known ? yield* load(known.dir).pipe(Effect.catch(() => Effect.succeed(null))) : null;
    const desks = project?.agents.filter((agent) => agent.role === "desk" && PROCESS_STATES.includes(agent.state)) ?? [];
    const nudged: string[] = [];
    for (const desk of desks) {
      const message = `☎️ Joel answered ${itemRef({ project: params.project, id: item.id })} "${item.title}": ${params.answer.trim()}`;
      const result = yield* intercom.send(desk.sessionId, message);
      nudged.push(`${desk.name}: ${result.status}`);
    }
    return { record, item, remaining: open.length - 1, nudged };
  });
