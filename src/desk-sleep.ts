import { statSync } from "node:fs";
import { decodeReaderExit, decodeSleepJournalEntry, decodeSleepWatch, placeAgent, type AgentRow, type Project } from "./domain.ts";
import { localWakeRefusal } from "./remote.ts";
import type { EnvShape } from "./runtime.ts";
import { forEachJsonlLine } from "./restart-snapshot.ts";

export const DRAIN_ENV = "RATKING_EXIT_WHEN_DRAINED";
export const WAKE_PROMPT = "Woken because mail is waiting. Read your Rat King inbox, then continue.";
export const MIN_DESK_IDLE_MS = 2 * 60 * 60_000;
export const UNREADABLE_SLEEP_JOURNAL = "session journal is unreadable";

export const deskWakeConfigRefusal = (row: AgentRow, env: Pick<EnvShape, "home" | "wakeConfigHome">) =>
  localWakeRefusal(env.home, env.wakeConfigHome, row.restore?.env.HOME, row.profile.env.HOME, row.profile.policy?.env?.HOME);

/** Durable admission shared by wake, owner status and queue nudges. Live checks come separately. */
export function deskWakeRefusal(project: Project, row: AgentRow, env: Pick<EnvShape, "home" | "wakeConfigHome">): string | null {
  if (row.machine !== "local" || row.role !== "desk" || !row.sleep) return "local wake requires a sleep-mode desk";
  if (row.retirePending) return "row retirement is pending";
  if (!row.sessionFile) return "row has no session file to restore";
  const config = deskWakeConfigRefusal(row, env);
  if (config) return config;
  if (project.state === "archived") return "project is archived";
  const lane = project.lanes.find(lane => lane.slug === row.lane);
  if (lane?.state !== "open") return `lane ${row.lane} is ${lane?.state ?? "missing"}`;
  const placed = placeAgent(project.slug, project.policy, "restore", undefined, row.machine, undefined);
  return "refusal" in placed ? "project policy refuses restore on this machine" : null;
}

export function readSleepDrain(row: Pick<AgentRow, "sessionFile" | "sessionId">) {
  if (!row.sessionFile) return { kind: "missing" } as const;
  try { return { kind: "read", drainedAt: sleepJournal(row.sessionFile, row.sessionId).drainedAt } as const; }
  catch (error) { return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" } as const; }
}

export const wakeNoticeText = (name: string, messageId: string | null, result: string) =>
  `${name}: message ${messageId ?? "unknown"} · ${result}`;

export const sleepRefusals = (e: {
  desk: boolean; open: boolean; idleMs: number | null; paneStatus: string | null;
  packets: readonly string[]; launches: readonly string[]; watches: readonly string[];
}): string[] => [
  ...(!e.desk ? ["row is not a desk"] : []),
  ...(!e.open ? ["desk or its lane is not open and running"] : []),
  ...(e.idleMs === null ? ["session journal age is unavailable"] : e.idleMs <= MIN_DESK_IDLE_MS ? ["session journal has not been idle over 2 hours"] : []),
  ...(e.paneStatus === "working" ? ["pane is working"] : !["idle", "done"].includes(e.paneStatus ?? "") ? ["pane is not proven idle"] : []),
  ...e.packets.map(id => `packet in flight: ${id}`),
  ...e.launches.map(id => `launch in flight: ${id}`),
  ...e.watches.map(id => `live watch: ${id}`),
];

function decodeLine<A>(decode: () => A): A | undefined {
  try { return decode(); } catch { return undefined; }
}

/** Stream the journal; never treat an inherited or subsequently used drain marker as a clean exit. */
export function sleepJournal(file: string, id: string) {
  const before = statSync(file);
  if (!before.isFile()) throw new Error("not a session journal");
  const until: string[] = [];
  const watches = new Map<string, string>();
  let header = false, start = 0, drainedAt = 0;
  forEachJsonlLine(file, line => {
    if (header && !line.includes('"pi-until-') && !line.includes('"bellwether-herdr-watch-') && !line.includes('"ratking.reader.exit"') && !line.includes('"message"')) return;
    const value = decodeLine(() => decodeSleepJournalEntry(JSON.parse(line)));
    if (!value) return;
    const at = Date.parse(value.timestamp ?? "");
    if (!header) {
      if (value.type !== "session" || value.id !== id || !Number.isFinite(at)) throw new Error("session journal header does not match row");
      header = true;
      start = at;
      until.push(line);
      return;
    }
    if (value.customType?.startsWith("pi-until-")) until.push(line);
    if (value.type === "message") drainedAt = 0;
    if (at < start || !Number.isFinite(at) || value.type !== "custom") return;
    if (value.customType === "ratking.reader.exit") {
      const exit = decodeLine(() => decodeReaderExit(value.data));
      if (exit) drainedAt = exit.reason === "drained" ? at : 0;
    }
    if (value.customType?.startsWith("bellwether-herdr-watch-")) {
      const watch = decodeLine(() => decodeSleepWatch(value.data));
      if (!watch) return;
      if (value.customType === "bellwether-herdr-watch-finished") watches.delete(watch.id);
      if (value.customType === "bellwether-herdr-watch-started" || value.customType === "bellwether-herdr-watch-resumed") {
        watches.set(watch.id, `${watch.id}${watch.label ? ` (${watch.label})` : ""}`);
      }
    }
  });
  const after = statSync(file);
  if (!header || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("session journal changed while reading");
  return { mtimeMs: after.mtimeMs, watches: [...watches.values()], until: until.join("\n"), drainedAt };
}
