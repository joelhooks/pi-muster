import { availableParallelism, freemem, hostname, loadavg, platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createActor, createMachine } from "xstate";

/**
 * Bounded full gates per machine, with load/memory admission. Eight parallel
 * replay gates once drove load to 350. Atomic mkdir slots retain dead-holder
 * takeover; exclusive deploy holds drain every slot and take the legacy lock.
 */
export function heavyLockPath(home: string): string {
  return join(home, ".local", "state", "muster", "heavy-job.lock");
}

export function exclusivePendingPath(home: string): string {
  return `${heavyLockPath(home)}.exclusive-pending`;
}

export interface Holder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly startedAt: string;
  readonly mode?: "slot";
}

export type Acquire = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly holder: Holder | null };
export type HeavyAcquire = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly reason: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function readHolder(lock: string): Holder | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(lock, "holder.json"), "utf8"));
    if (typeof value !== "object" || value === null || !("pid" in value) || !("host" in value) || !("command" in value) || !("startedAt" in value)) return null;
    if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647 || typeof value.host !== "string" || typeof value.command !== "string" || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return null;
    return { pid: value.pid, host: value.host, command: value.command, startedAt: value.startedAt, ...("mode" in value && value.mode === "slot" ? { mode: "slot" as const } : {}) };
  } catch {
    return null;
  }
}

function stale(holder: Holder | null): boolean {
  return holder !== null && holder.host === hostname() && !alive(holder.pid);
}

export function tryAcquire(lock: string, command: string, pid = process.pid, mode?: "slot"): Acquire {
  mkdirSync(join(lock, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const holder = readHolder(lock);
      if (stale(holder)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      return { ok: false, holder };
    }
    const holder: Holder = { pid, host: hostname(), command, startedAt: new Date().toISOString(), ...(mode ? { mode } : {}) };
    try {
      writeFileSync(join(lock, "holder.json"), `${JSON.stringify(holder)}\n`);
    } catch (error) {
      rmSync(lock, { recursive: true, force: true });
      throw error;
    }
    return {
      ok: true,
      release: () => {
        const current = readHolder(lock);
        if (current?.pid === pid && current.host === holder.host && current.command === holder.command && current.startedAt === holder.startedAt) rmSync(lock, { recursive: true, force: true });
      },
    };
  }
  return { ok: false, holder: readHolder(lock) };
}

/** Environment-facing adapter; heavySlotCount owns the pure decision. */
export function heavySlots(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return heavySlotCount(machineAdapter.performanceCores(), env.MUSTER_HEAVY_SLOTS);
}

/** Slot 0 keeps the original path, so sessions on older code still see it held. */
export function slotPath(lock: string, slot: number): string {
  return slot === 0 ? lock : `${lock}.${slot}`;
}

/** Low-level hotfix compatibility API. Gates must use tryAcquireHeavy for admission. */
export function tryAcquireSlot(lock: string, command: string, slots = heavySlots(), pid = process.pid): Acquire {
  let first: Acquire | null = null;
  for (let slot = 0; slot < slots; slot++) {
    const result = tryAcquire(slotPath(lock, slot), command, pid, "slot");
    if (result.ok) return result;
    first ??= result;
  }
  return first ?? { ok: false, holder: null };
}

export function describeHolder(holder: Holder | null): string {
  return holder ? `pid ${holder.pid} on ${holder.host} since ${holder.startedAt}: ${holder.command}` : "unknown holder";
}

function positive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive`);
  return number;
}

/** performanceCores is hw.perflevel0.physicalcpu, or availableParallelism / 2. */
export function heavySlotCount(performanceCores: number, override?: string): number {
  const configured = positive(override, "MUSTER_HEAVY_SLOTS");
  if (configured !== undefined && !Number.isInteger(configured)) throw new Error("MUSTER_HEAVY_SLOTS must be an integer");
  if (configured !== undefined) return configured;
  if (!Number.isFinite(performanceCores) || performanceCores < 0) throw new Error("performance cores must be finite and non-negative");
  return Math.max(1, Math.floor(performanceCores / 3));
}

export interface MachineSample {
  readonly cores: number;
  readonly load: number;
  readonly freeGB: number;
}

export interface HeavyAdapter {
  readonly performanceCores: () => number;
  readonly sample: () => MachineSample;
}

export function parseVmStat(text: string): number {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = ["Pages free", "Pages inactive", "Pages speculative"].map((label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(text)?.[1]));
  if (!pageSize || pages.some((value) => !Number.isFinite(value))) throw new Error("cannot read available memory from vm_stat");
  return pages.reduce((sum, value) => sum + value, 0) * pageSize / 1024 ** 3;
}

export function parseMemInfo(text: string): number {
  const kb = Number(/^MemAvailable:\s+(\d+)\s+kB$/m.exec(text)?.[1]);
  if (!Number.isFinite(kb)) throw new Error("cannot read MemAvailable from /proc/meminfo");
  return kb * 1024 / 1024 ** 3;
}

export const machineAdapter: HeavyAdapter = {
  performanceCores: () => {
    if (platform() === "darwin") {
      try {
        const cores = Number(execFileSync("sysctl", ["-n", "hw.perflevel0.physicalcpu"], { encoding: "utf8", timeout: 2000 }));
        if (Number.isFinite(cores) && cores > 0) return cores;
      } catch { /* Intel Macs and platforms without performance-core topology. */ }
    }
    return availableParallelism() / 2;
  },
  sample: () => ({
    cores: availableParallelism(),
    load: loadavg()[0] ?? 0,
    freeGB: platform() === "darwin"
      ? parseVmStat(execFileSync("vm_stat", [], { encoding: "utf8", timeout: 2000 }))
      : platform() === "linux" ? parseMemInfo(readFileSync("/proc/meminfo", "utf8")) : freemem() / 1024 ** 3,
  }),
};

export interface HeavyOptions {
  readonly home: string;
  readonly adapter?: HeavyAdapter;
  readonly slots?: string;
  readonly minFreeGB?: string;
}

function settings(options: HeavyOptions) {
  const adapter = options.adapter ?? machineAdapter;
  return {
    adapter,
    count: heavySlotCount(adapter.performanceCores(), options.slots ?? process.env.MUSTER_HEAVY_SLOTS),
    minFreeGB: positive(options.minFreeGB ?? process.env.MUSTER_HEAVY_MIN_FREE_GB, "MUSTER_HEAVY_MIN_FREE_GB") ?? 16,
  };
}

export function admissionReason(sample: MachineSample, minFreeGB: number): string | null {
  if (![sample.cores, sample.load, sample.freeGB].every(Number.isFinite) || sample.cores <= 0 || sample.load < 0 || sample.freeGB < 0) return "machine load/memory unavailable";
  const reasons: string[] = [];
  if (sample.load > sample.cores * 2.5) reasons.push(`load ${sample.load.toFixed(1)} above ${sample.cores * 2.5}`);
  if (sample.freeGB < minFreeGB) reasons.push(`available memory ${sample.freeGB.toFixed(1)} GB below ${minFreeGB} GB`);
  return reasons.length ? reasons.join("; ") : null;
}

function pressureReason(adapter: HeavyAdapter, minFreeGB: number): string | null {
  try {
    return admissionReason(adapter.sample(), minFreeGB);
  } catch (error) {
    return `machine load/memory unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function existingSlots(lock: string): number[] {
  const parent = join(lock, "..");
  const prefix = `${lock.split("/").at(-1)}.`;
  if (!existsSync(parent)) return [];
  return readdirSync(parent).filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length))).sort((a, b) => a - b);
}

// Missing/partially written holders fail closed; status never calls this.
function blocker(lock: string, allowSlot = false): string | null {
  if (!existsSync(lock)) return null;
  const holder = readHolder(lock);
  if (stale(holder)) {
    rmSync(lock, { recursive: true, force: true });
    return null;
  }
  if (allowSlot && holder?.mode === "slot") return null;
  return `${lock.split("/").at(-1)}: ${describeHolder(holder)}`;
}

export function tryAcquireHeavy(options: HeavyOptions, command: string): HeavyAcquire {
  const { adapter, count, minFreeGB } = settings(options);
  const lock = heavyLockPath(options.home);
  const blocked = blocker(exclusivePendingPath(options.home)) ?? blocker(lock, true);
  if (blocked) return { ok: false, reason: blocked };
  const pressure = pressureReason(adapter, minFreeGB);
  if (pressure) return { ok: false, reason: pressure };
  const holders: string[] = [];
  for (let n = 0; n < count; n++) {
    const slot = tryAcquire(slotPath(lock, n), command, process.pid, "slot");
    if (!slot.ok) {
      holders.push(`slot-${n}: ${describeHolder(slot.holder)}`);
      continue;
    }
    // An exclusive request may have arrived while we were acquiring.
    const fence = blocker(exclusivePendingPath(options.home)) ?? blocker(lock, true);
    if (fence) {
      slot.release();
      return { ok: false, reason: fence };
    }
    return slot;
  }
  return { ok: false, reason: `all ${count} heavy slots busy: ${holders.join("; ")}` };
}

// Request lifecycle: waiting -> reserved -> draining -> held -> closed. CANCEL from every
// live state releases owned locks. Pending survives retries, preventing starvation.
const exclusiveMachine = createMachine({
  initial: "waiting",
  states: {
    waiting: { on: { RESERVE: "reserved", CANCEL: "closed" } },
    reserved: { on: { DRAIN: "draining", CANCEL: "closed" } },
    draining: { on: { ACQUIRE: "held", CANCEL: "closed" } },
    held: { on: { CANCEL: "closed" } },
    closed: { type: "final" },
  },
});

export function exclusiveRequest(options: HeavyOptions, command: string) {
  const { adapter, count, minFreeGB } = settings(options);
  const lock = heavyLockPath(options.home);
  const actor = createActor(exclusiveMachine).start();
  const slots = new Set(Array.from({ length: count }, (_, n) => n));
  const releases: (() => void)[] = [];
  const release = () => {
    for (const unlock of releases.splice(0).reverse()) unlock();
    actor.send({ type: "CANCEL" });
    actor.stop();
  };
  const attempt = (): HeavyAcquire => {
    if (actor.getSnapshot().matches("closed")) return { ok: false, reason: "exclusive request closed" };
    if (actor.getSnapshot().matches("held")) return { ok: true, release };
    if (actor.getSnapshot().matches("waiting")) {
      const pending = tryAcquire(exclusivePendingPath(options.home), command);
      if (!pending.ok) return { ok: false, reason: `exclusive-pending: ${describeHolder(pending.holder)}` };
      releases.push(pending.release);
      actor.send({ type: "RESERVE" });
    }
    // Retain the legacy lock while draining: old sessions cannot see pending.
    if (actor.getSnapshot().matches("reserved")) {
      const legacy = tryAcquire(heavyLockPath(options.home), command);
      if (!legacy.ok) return { ok: false, reason: `heavy-job.lock: ${describeHolder(legacy.holder)}` };
      releases.push(legacy.release);
      actor.send({ type: "DRAIN" });
    }
    const pressure = pressureReason(adapter, minFreeGB);
    if (pressure) return { ok: false, reason: pressure };
    for (const n of existingSlots(lock)) slots.add(n);
    const acquired: (() => void)[] = [];
    const busy: string[] = [];
    try {
      for (const n of slots) {
        if (n === 0) continue; // Already held as the legacy fence.
        const slot = tryAcquire(slotPath(lock, n), command);
        if (slot.ok) acquired.push(slot.release);
        else busy.push(`slot-${n}: ${describeHolder(slot.holder)}`);
      }
      if (busy.length) {
        for (const unlock of acquired.reverse()) unlock();
        return { ok: false, reason: `exclusive draining: ${busy.join("; ")}` };
      }
      releases.push(...acquired);
      actor.send({ type: "ACQUIRE" });
      return { ok: true, release };
    } catch (error) {
      for (const unlock of acquired.reverse()) unlock();
      release();
      throw error;
    }
  };
  return { attempt, release };
}

export function heavyStatus(options: HeavyOptions, now = Date.now()): string {
  const { adapter, count, minFreeGB } = settings(options);
  const lock = heavyLockPath(options.home);
  const sample = adapter.sample();
  const lines = [`heavy slots: ${count}`, `load: ${sample.load.toFixed(1)} (limit ${sample.cores * 2.5}); available memory: ${sample.freeGB.toFixed(1)} GB (minimum ${minFreeGB} GB)`];
  const slots = new Set([...Array.from({ length: count }, (_, n) => n), ...existingSlots(lock)]);
  for (const [name, path] of [...Array.from(slots, (n) => [`slot-${n}`, slotPath(lock, n)] as const), ["exclusive-pending", exclusivePendingPath(options.home)] as const]) {
    if (!path || !existsSync(path)) {
      lines.push(`${name}: free`);
      continue;
    }
    const holder = readHolder(path);
    const age = holder ? Math.max(0, Math.floor((now - Date.parse(holder.startedAt)) / 1000)) : null;
    lines.push(`${name}: ${describeHolder(holder)}; age ${age ?? "unknown"}s${stale(holder) ? "; stale" : ""}`);
  }
  return lines.join("\n");
}
