import type { Project, TurnRecord } from "./domain.ts";

/** In-process turn evidence for tokens and launch proof; pi-ratking renders the owner notice. */
export class TurnLog {
  private records = new Map<string, TurnRecord>();
  private listeners = new Set<(record: TurnRecord) => void>();

  latest(agent: string): TurnRecord | undefined { return this.records.get(agent); }

  snapshot(): ReadonlyMap<string, TurnRecord> { return new Map(this.records); }

  record(record: TurnRecord): void {
    const previous = this.records.get(record.agent);
    if (!previous || Date.parse(record.at) >= Date.parse(previous.at)) this.records.set(record.agent, record);
    for (const listener of this.listeners) listener(record);
  }

  /** True on a working record since sinceMs; with ranAfterBusy, a done record since then counts too. */
  waitWorking(agent: string, sinceMs: number, timeoutMs: number, ranAfterBusy = false): Promise<boolean> {
    const matches = (record: TurnRecord | undefined) => record?.agent === agent &&
      (record.state === "working" || (ranAfterBusy && record.state === "done")) && Date.parse(record.at) >= sinceMs - 2000;
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

/** All token publishers and the inbound listener share the same in-process evidence. */
const processTurns = new TurnLog();
export const turnLog = (): TurnLog => processTurns;

/** Diagnose recorded launch capability, not the environment of the status caller. */
export function turnUnsupported(row: Project["agents"][number]): string | null {
  if (!["running", "silent", "nudged", "restarted", "reported", "verified", "landed"].includes(row.state) ||
    (row.restore?.env ?? row.profile.env).RATKING_TURN_RECORDS === "1") return null;
  return `TurnUnsupported: ${row.name} was launched before turn records. Fix: agent_launch action:"restart" name:"${row.name}". Debug: comms_doctor row:"${row.name}"`;
}
