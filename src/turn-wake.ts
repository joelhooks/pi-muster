import type { Project, TurnRecord } from "./domain.ts";
import type { OwnerNoteInput } from "./owner-queue.ts";
import { sessionChain } from "./ops.ts";

/** In-process proof only; working and idle never become owner-queue posts. */
export class TurnLog {
  private records = new Map<string, TurnRecord>();
  private listeners = new Set<(record: TurnRecord) => void>();

  latest(agent: string): TurnRecord | undefined { return this.records.get(agent); }

  record(record: TurnRecord): void {
    const previous = this.records.get(record.agent);
    if (!previous || Date.parse(record.at) >= Date.parse(previous.at)) this.records.set(record.agent, record);
    for (const listener of this.listeners) listener(record);
  }

  waitWorking(agent: string, sinceMs: number, timeoutMs: number): Promise<boolean> {
    const matches = (record: TurnRecord | undefined) => record?.agent === agent &&
      record.state === "working" && Date.parse(record.at) >= sinceMs - 2000;
    if (matches(this.latest(agent))) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = (working: boolean) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(working);
      };
      const listener = (record: TurnRecord) => { if (matches(record)) finish(true); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.listeners.add(listener);
    });
  }
}

/** Turn delivery is already authenticated by pi-ratking. The catalog owns routing. */
export function turnWake(record: TurnRecord, project: Project): { owner: string; item: OwnerNoteInput } | null {
  if (record.state === "working" || record.state === "idle") return null;
  const row = project.agents.find(row => record.agent === `${project.slug}/${row.name}` && sessionChain(row).includes(record.session));
  if (!row) return null;
  const title = record.state === "crashed" ? `🐑 ${row.name} crashed (lease lapsed)`
    : record.state === "blocked" ? `🐑 ${row.name} blocked${record.reason ? `: ${record.reason}` : ""}`
    : `🐑 ${row.name} done`;
  return { owner: row.owner, item: {
    author: record.session, project: project.slug, lane: row.lane,
    kind: record.state === "done" ? "done" : "blocked", title,
    body: `turnId: ${record.turnId}${record.stopReason === undefined ? "" : `\nstopReason: ${record.stopReason}`}${record.reason === undefined ? "" : `\nreason: ${record.reason}`}`,
    // Done is normally silent. Turn completion must wake the owner too.
    mention: row.owner,
  } };
}

/** Diagnose recorded launch capability, not the environment of the status caller. */
export function turnUnsupported(row: Project["agents"][number]): string | null {
  if (!["running", "silent", "nudged", "restarted", "reported", "verified", "landed"].includes(row.state) ||
    (row.restore?.env ?? row.profile.env).RATKING_TURN_RECORDS === "1") return null;
  return `TurnUnsupported: ${row.name} was launched before turn records. Fix: agent_launch action:"restart" name:"${row.name}". Debug: comms_doctor row:"${row.name}"`;
}
