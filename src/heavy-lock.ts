import { hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * A few full test gates at a time on this machine (`heavySlots`, default 4). Eight
 * parallel replay gates once took a machine to load 350 with swap nearly full. The lock is a
 * directory (mkdir is atomic) holding the holder's pid; a dead holder is stale
 * and gets taken over.
 */
export function heavyLockPath(home: string): string {
  return join(home, ".local", "state", "muster", "heavy-job.lock");
}

export interface Holder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly startedAt: string;
}

export type Acquire = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly holder: Holder | null };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readHolder(lock: string): Holder | null {
  try {
    return JSON.parse(readFileSync(join(lock, "holder.json"), "utf8")) as Holder;
  } catch {
    return null;
  }
}

export function tryAcquire(lock: string, command: string, pid = process.pid): Acquire {
  mkdirSync(join(lock, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readHolder(lock);
      if (holder && holder.host === hostname() && !alive(holder.pid)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      return { ok: false, holder };
    }
    const holder: Holder = { pid, host: hostname(), command, startedAt: new Date().toISOString() };
    writeFileSync(join(lock, "holder.json"), `${JSON.stringify(holder)}\n`);
    return {
      ok: true,
      release: () => {
        if (readHolder(lock)?.pid === pid) rmSync(lock, { recursive: true, force: true });
      },
    };
  }
  return { ok: false, holder: readHolder(lock) };
}

/** Full gates allowed at once on this machine. One was too strict for a 16-core, 128 GB Mac Studio. */
export function heavySlots(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(env.MUSTER_HEAVY_SLOTS);
  return Number.isInteger(value) && value > 0 ? value : 4;
}

/** Slot 0 keeps the original path, so sessions on older code still see it held. */
export function slotPath(lock: string, slot: number): string {
  return slot === 0 ? lock : `${lock}.${slot}`;
}

/** Take the first free slot; when all are held, report the first slot's holder. */
export function tryAcquireSlot(lock: string, command: string, slots = heavySlots(), pid = process.pid): Acquire {
  let first: Acquire | null = null;
  for (let slot = 0; slot < slots; slot++) {
    const result = tryAcquire(slotPath(lock, slot), command, pid);
    if (result.ok) return result;
    first ??= result;
  }
  return first ?? { ok: false, holder: null };
}

export function describeHolder(holder: Holder | null): string {
  return holder ? `pid ${holder.pid} on ${holder.host} since ${holder.startedAt}: ${holder.command}` : "unknown holder";
}
