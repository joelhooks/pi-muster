import { availableParallelism, freemem, hostname, loadavg, platform } from "node:os";
import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createActor, createMachine } from "xstate";
import { randomBytes } from "node:crypto";

/**
 * Bounded full gates per machine: slots and a memory floor admit; load is reported, never
 * a gate (Joel, 2026-10-06: "let the machine fuckin cook"). Atomic mkdir slots retain dead-holder
 * takeover; exclusive deploy holds drain every slot and take the legacy lock.
 */
export function heavyLockPath(home: string): string {
  return join(home, ".local", "state", "muster", "heavy-job.lock");
}

export function exclusivePendingPath(home: string): string {
  return `${heavyLockPath(home)}.exclusive-pending`;
}

/** Reserved capacity is outside the configured normal slot count. */
export function deploySlotPath(home: string): string {
  return `${heavyLockPath(home)}.deploy-0`;
}

export interface Holder {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly startedAt: string;
  /** Only "exclusive" fences admission; "priority" is a capped single-slot window. */
  readonly mode?: "slot" | "exclusive" | "priority" | "grant";
  readonly grant?: HeavyGrant;
  readonly window?: string;
  readonly exclusiveAcquiredAt?: string;
  readonly exclusiveCapMs?: number;
}

export type Acquire = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly holder: Holder | null };
export type HeavyAcquire = { readonly ok: true; readonly release: () => void; readonly slot?: string } | { readonly ok: false; readonly reason: string };

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
    return decodeHolder(JSON.parse(readFileSync(join(lock, "holder.json"), "utf8")));
  } catch {
    return null;
  }
}

function decodeHolder(value: unknown): Holder | null {
  if (typeof value !== "object" || value === null || !("pid" in value) || !("host" in value) || !("command" in value) || !("startedAt" in value)) return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647 || typeof value.host !== "string" || typeof value.command !== "string" || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return null;
  const grant = "grant" in value ? decodeGrant(value.grant) : null;
  return { pid: value.pid, host: value.host, command: value.command, startedAt: value.startedAt, ...("mode" in value && (value.mode === "slot" || value.mode === "exclusive" || value.mode === "priority" || value.mode === "grant") ? { mode: value.mode } : {}),
    ...(grant ? { grant } : {}),
    ...("window" in value && typeof value.window === "string" ? { window: value.window } : {}),
    ...("exclusiveAcquiredAt" in value && typeof value.exclusiveAcquiredAt === "string" && Number.isFinite(Date.parse(value.exclusiveAcquiredAt)) ? { exclusiveAcquiredAt: value.exclusiveAcquiredAt } : {}),
    ...("exclusiveCapMs" in value && typeof value.exclusiveCapMs === "number" && value.exclusiveCapMs > 0 && Number.isFinite(value.exclusiveCapMs) ? { exclusiveCapMs: value.exclusiveCapMs } : {}),
  };
}

export type HolderHealth = "alive" | "dead" | "reused" | "unknown";

// macOS may append a network suffix to the same machine's hostname. Do not
// collapse arbitrary domains: foreign hosts must still fail closed.
function localHost(host: string): boolean {
  const normalize = (name: string) => name.toLowerCase().replace(/\.(local|localdomain)\.?$/, "");
  return normalize(host) === normalize(hostname());
}

function holderHealth(holder: Holder | null): HolderHealth {
  if (!holder || !localHost(holder.host)) return "unknown";
  if (!alive(holder.pid)) return "dead";
  try {
    // lstart has one-second resolution. A later start is positive evidence
    // of pid reuse; missing/denied/unparseable output is not grounds to reap.
    const started = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(holder.pid)], {
      encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"],
    }).trim());
    if (Number.isFinite(started) && started > Date.parse(holder.startedAt)) return "reused";
  } catch { /* EPERM or unavailable process metadata retains the live fence. */ }
  return "alive";
}

function stale(holder: Holder | null): boolean {
  const health = holderHealth(holder);
  return health === "dead" || health === "reused";
}

export function tryAcquire(lock: string, command: string, pid = process.pid, mode?: "slot" | "exclusive" | "priority" | "grant"): Acquire {
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

export function describeHolder(holder: Holder | null, now = Date.now(), health = holderHealth(holder)): string {
  return holder ? `pid ${holder.pid} on ${holder.host} since ${holder.startedAt}: ${holder.command}; ${health}; age ${Math.max(0, Math.floor((now - Date.parse(holder.startedAt)) / 1000))}s` : "unknown holder";
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
  /** Explicit authorization: the library never infers a window from process.env. */
  readonly window?: string;
  readonly grant?: string;
  readonly now?: () => number;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly health?: (holder: Holder) => HolderHealth;
  /** Test-only short cap; never read from an environment variable. */
  readonly testOnlyCapMs?: number;
}

export interface HeavyGrant {
  readonly id: string;
  readonly label: string;
  readonly grantedBy: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class GrantRefused extends Error {}

export function heavyGrantsPath(home: string): string {
  return join(home, ".local/state/muster/heavy-grants");
}

function decodeGrant(value: unknown): HeavyGrant | null {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" || !/^[a-f0-9]{16}$/.test(value.id) ||
    !("label" in value) || typeof value.label !== "string" || !value.label.trim() || value.label.length > 128 ||
    !("grantedBy" in value) || typeof value.grantedBy !== "string" || !("cwd" in value) || typeof value.cwd !== "string" ||
    !("createdAt" in value) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    !("expiresAt" in value) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return null;
  const ttl = Date.parse(value.expiresAt) - Date.parse(value.createdAt);
  if (ttl <= 0 || ttl > 7_200_000) return null;
  return { id: value.id, label: value.label, grantedBy: value.grantedBy, cwd: value.cwd, createdAt: value.createdAt, expiresAt: value.expiresAt };
}

/** Status is read-only; admission and explicit listing reap expired records. */
export function listHeavyGrants(options: HeavyOptions, reap = true): HeavyGrant[] {
  const dir = heavyGrantsPath(options.home);
  if (!existsSync(dir)) return [];
  const now = (options.now ?? Date.now)();
  const live: HeavyGrant[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
    const grant = decodeGrant(JSON.parse(readFileSync(join(dir, name), "utf8")));
    if (!grant || name !== `${grant.id}.json`) throw new GrantRefused(`invalid heavy grant record: ${name}`);
    if (Date.parse(grant.expiresAt) <= now) {
      if (reap) rmSync(join(dir, name), { force: true });
    } else live.push(grant);
  }
  return live;
}

export function grantTtlMs(duration = "1h"): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(duration);
  if (!match) throw new GrantRefused("grant ttl must be a positive duration, e.g. 30m or 1h (maximum 2h)");
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const ttl = Number(match[1]) * (units[match[2]!] ?? 0);
  if (!Number.isFinite(ttl) || ttl < 1) throw new GrantRefused("grant ttl must be positive");
  return Math.min(ttl, 7_200_000);
}

function manageGrant<T>(options: HeavyOptions, command: string, action: () => T): T {
  const guard = tryAcquire(join(options.home, ".local/state/muster/heavy-admission.lock"), command);
  if (!guard.ok) {
    logExclusive(options, "refused", command, undefined, "grant");
    throw new GrantRefused("heavy admission decision busy; retry grant operation");
  }
  try { return action(); } finally { guard.release(); }
}

export function createHeavyGrant(options: HeavyOptions, label: string, duration = "1h", grantedBy = process.env.MUSTER_AGENT ?? process.env.PI_SESSION_ID ?? "cli"): HeavyGrant {
  return manageGrant(options, `grant ${label}`, () => {
    const now = (options.now ?? Date.now)();
    const grant: HeavyGrant = { id: randomBytes(8).toString("hex"), label, grantedBy, cwd: process.cwd(), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() };
    let ttl: number;
    try { ttl = grantTtlMs(duration); }
    catch (error) {
      logExclusive(options, "refused", `grant ${label}`, undefined, "grant", undefined, grant);
      throw error;
    }
    const issued = { ...grant, expiresAt: new Date(now + ttl).toISOString() };
    const live = listHeavyGrants(options);
    if (!decodeGrant(issued) || live.length >= 4) {
      logExclusive(options, "refused", `grant ${label}`, undefined, "grant", undefined, grant);
      throw new GrantRefused(live.length >= 4 ? `four live grants already issued: ${live.map((g) => `${g.id} (${g.label}, ${g.grantedBy}, expires ${g.expiresAt})`).join("; ")}` : "grant label must contain 1-128 characters");
    }
    mkdirSync(heavyGrantsPath(options.home), { recursive: true, mode: 0o700 });
    writeFileSync(join(heavyGrantsPath(options.home), `${grant.id}.json`), `${JSON.stringify(issued)}\n`, { flag: "wx", mode: 0o600 });
    logExclusive(options, "granted", `grant ${label}`, undefined, "grant", undefined, issued);
    return issued;
  });
}

export function revokeHeavyGrant(options: HeavyOptions, id: string): void {
  manageGrant(options, `revoke ${id}`, () => {
    const grant = validateGrant({ ...options, grant: id }, `revoke ${id}`);
    rmSync(join(heavyGrantsPath(options.home), `${grant.id}.json`));
    logExclusive(options, "revoked", `revoke ${id}`, undefined, "grant", undefined, grant);
  });
}

function validateGrant(options: HeavyOptions, command: string): HeavyGrant {
  const id = options.grant;
  let record: HeavyGrant | null = null;
  if (id && /^[a-f0-9]{16}$/.test(id)) {
    try { record = decodeGrant(JSON.parse(readFileSync(join(heavyGrantsPath(options.home), `${id}.json`), "utf8"))); }
    catch { /* Unknown ids are refused below. */ }
  }
  const grant = listHeavyGrants(options).find((g) => g.id === id);
  if (!grant || options.window !== undefined) {
    logExclusive(options, "refused", command, undefined, "grant", undefined, record ?? undefined);
    throw new GrantRefused(options.window !== undefined ? "grant cannot be combined with a deploy window" : `unknown or expired heavy grant: ${options.grant ?? "missing"}`);
  }
  return grant;
}

// A grant only changes admission order: waiting -> held -> closed. No hold clock.
const grantMachine = createMachine({
  initial: "waiting",
  states: {
    waiting: { on: { ACQUIRE: "held", CANCEL: "closed" } },
    held: { on: { CANCEL: "closed" } },
    closed: { type: "final" },
  },
});

export function grantRequest(options: HeavyOptions, command: string, ticket: () => string | undefined = () => undefined) {
  const grant = validateGrant(options, command);
  const actor = createActor(grantMachine).start();
  let unlock = () => {};
  let slot: string | undefined;
  const audit = (event: ExclusiveEvent) => logExclusive(options, event, command, undefined, "grant", slot, grant);
  audit("requested");
  const release = () => {
    if (actor.getSnapshot().matches("closed")) return;
    unlock();
    actor.send({ type: "CANCEL" });
    actor.stop();
    audit("released");
  };
  return {
    attempt: (): HeavyAcquire => {
      if (actor.getSnapshot().matches("held")) return { ok: true, release, slot };
      if (!actor.getSnapshot().matches("waiting")) return { ok: false, reason: "grant request closed" };
      const result = withAdmission(options, command, () => acquireHeavy(options, command, ticket(), false, validateGrant(options, command)));
      if (!result.ok) return result;
      unlock = result.release;
      slot = result.slot;
      actor.send({ type: "ACQUIRE" });
      audit("acquired");
      return { ok: true, release, slot };
    },
    release,
  };
}

export class ExclusiveRefused extends Error {
  constructor() { super("MUSTER_DEPLOY_WINDOW must be 1-64 characters [A-Za-z0-9._:-]; priority and --exclusive are deploy-only"); }
}

export function exclusiveCapMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const minutes = Number(env.MUSTER_EXCLUSIVE_CAP_MIN ?? 20);
  return (Number.isFinite(minutes) ? Math.min(20, Math.max(1, minutes)) : 20) * 60_000;
}

export function deployCapMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const minutes = Number(env.MUSTER_DEPLOY_CAP_MIN ?? 5);
  return (Number.isFinite(minutes) ? Math.min(5, Math.max(1, minutes)) : 5) * 60_000;
}

function capMs(options: HeavyOptions, mode: "exclusive" | "priority" = "exclusive"): number {
  return Math.min(mode === "priority" ? deployCapMs() : exclusiveCapMs(), options.testOnlyCapMs ?? Infinity);
}

export type ExclusiveEvent = "requested" | "acquired" | "released" | "capped" | "reaped" | "refused" | "granted" | "revoked";
export function logExclusive(options: HeavyOptions, event: ExclusiveEvent, command: string, holder?: Holder, mode: "exclusive" | "priority" | "grant" = "exclusive", slot?: string, grant?: HeavyGrant): void {
  let parentCommand = "";
  try {
    parentCommand = execFileSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim().slice(0, 200);
  } catch { /* Missing parent metadata does not suppress the audit event. */ }
  const dir = join(options.home, ".local/state/muster");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "heavy-exclusive.jsonl"), `${JSON.stringify({
    ts: new Date((options.now ?? Date.now)()).toISOString(), event, mode: holder?.mode === "priority" ? "priority" : mode, window: holder?.window ?? options.window ?? null,
    ...(mode === "grant" ? { grant: grant?.id ?? options.grant ?? null, label: grant?.label ?? null, grantedBy: grant?.grantedBy ?? null } : {}),
    pid: holder?.pid ?? process.pid, ppid: process.ppid, parentCommand, cwd: process.cwd(), command: command.slice(0, 200), ...(slot ? { slot } : {}),
  })}\n`, { mode: 0o600 });
}

function sameHolder(a: Holder | null, b: Holder): boolean {
  return a?.pid === b.pid && a.host === b.host && a.command === b.command && a.window === b.window &&
    (b.exclusiveAcquiredAt ? a.exclusiveAcquiredAt === b.exclusiveAcquiredAt : true);
}

/** Admission backstop. Plain snapshot/status never calls this. */
export function reapExclusive(options: HeavyOptions): void {
  const lock = heavyLockPath(options.home);
  const pending = exclusivePendingPath(options.home);
  const candidates = [pending, lock, deploySlotPath(options.home), ...existingSlots(lock).map((n) => slotPath(lock, n))];
  for (const path of candidates) {
    const holder = readHolder(path);
    if (!holder || (path !== pending && holder.mode !== "exclusive" && holder.mode !== "priority")) continue;
    const mode = holder.mode === "priority" ? "priority" : "exclusive";
    // A pending request has no hold clock until every slot has drained.
    const acquiredAt = holder.exclusiveAcquiredAt ?? (path === lock && holder.window === undefined ? holder.startedAt : undefined);
    // Dead/reused reserved-slot holders can be reclaimed before the cap.
    // Remote and unverified holders retain their fence. Never signal reused pids.
    const health = (options.health ?? holderHealth)(holder);
    if (!localHost(holder.host) || health === "unknown") continue;
    const deadDeploy = path === deploySlotPath(options.home) && (health === "dead" || health === "reused");
    if (!deadDeploy && (!acquiredAt || (options.now ?? Date.now)() - Date.parse(acquiredAt) <= Math.min(capMs(options, mode), holder.exclusiveCapMs ?? Infinity) + 120_000)) continue;
    logExclusive(options, "reaped", holder.command, holder);
    console.error(`muster-heavy: REAPED ${mode} window ${holder.window ?? "legacy"}, pid ${holder.pid}: ${deadDeploy ? "holder dead or reused" : "hold exceeded cap + 2 min"}`);
    if (health === "alive") {
      const kill = options.kill ?? process.kill;
      // Backstop escalation is immediate: unlike the cooperative holder it may
      // be frozen. Finish signalling before opening admission to another job.
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        try { kill(holder.pid, signal); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
        }
      }
    }
    for (const heldPath of candidates) {
      if (sameHolder(readHolder(heldPath), holder)) rmSync(heldPath, { recursive: true, force: true });
    }
  }
}

function settings(options: HeavyOptions) {
  const adapter = options.adapter ?? machineAdapter;
  return {
    adapter,
    count: heavySlotCount(adapter.performanceCores(), options.slots ?? process.env.MUSTER_HEAVY_SLOTS),
    minFreeGB: positive(options.minFreeGB ?? process.env.MUSTER_HEAVY_MIN_FREE_GB, "MUSTER_HEAVY_MIN_FREE_GB") ?? 16,
  };
}

/** Only memory refuses admission; slots bound concurrency. Load stays in status as information. */
export function admissionReason(sample: MachineSample, minFreeGB: number): string | null {
  if (![sample.cores, sample.load, sample.freeGB].every(Number.isFinite) || sample.cores <= 0 || sample.load < 0 || sample.freeGB < 0) return "machine load/memory unavailable";
  return sample.freeGB < minFreeGB ? `available memory ${sample.freeGB.toFixed(1)} GB below ${minFreeGB} GB` : null;
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
  // Only a marked exclusive hold fences the machine. Older code writes unmarked holders; they are one busy slot.
  if (allowSlot && holder !== null && holder.mode !== "exclusive") return null;
  return `${lock.split("/").at(-1)}: ${describeHolder(holder)}`;
}

export function heavyQueuePath(home: string): string {
  return join(home, ".local/state/muster/heavy-queue");
}

export interface HeavyTicket extends Holder {
  readonly enqueuedAt: number;
  readonly cwd: string;
  readonly mode: "slot" | "exclusive" | "priority" | "grant";
}

export interface HeavyQueueView {
  readonly name: string;
  readonly position: number;
  readonly ticket: HeavyTicket | null;
  readonly pid: number | null;
  readonly health: HolderHealth;
  readonly ageSeconds: number | null;
  readonly command: string | null;
}

function readTicket(path: string): HeavyTicket | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const holder = decodeHolder(value);
    if (!holder || typeof value !== "object" || value === null || !("enqueuedAt" in value) || typeof value.enqueuedAt !== "number" || !Number.isSafeInteger(value.enqueuedAt) || value.enqueuedAt < 0 || !("cwd" in value) || typeof value.cwd !== "string" || (holder.mode !== "slot" && holder.mode !== "exclusive" && holder.mode !== "priority" && holder.mode !== "grant")) return null;
    if (holder.mode === "priority" && (!holder.window || !/^[A-Za-z0-9._:-]{1,64}$/.test(holder.window))) return null;
    if (holder.mode === "grant" && !holder.grant) return null;
    return { ...holder, mode: holder.mode, enqueuedAt: value.enqueuedAt, cwd: value.cwd };
  } catch { return null; }
}

/** Unknown/partially written and foreign tickets retain their place. Status is read-only. */
export function heavyQueue(options: HeavyOptions, now = (options.now ?? Date.now)(), reap = false): HeavyQueueView[] {
  const dir = heavyQueuePath(options.home);
  if (!existsSync(dir)) return [];
  const rows: HeavyQueueView[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const ticket = readTicket(path);
    const health = ticket ? (options.health ?? holderHealth)(ticket) : "unknown";
    if (reap && (health === "dead" || health === "reused")) {
      rmSync(path, { force: true });
      continue;
    }
    rows.push({ name, position: rows.length + 1, ticket, pid: ticket?.pid ?? null, health,
      ageSeconds: ticket ? Math.max(0, Math.floor((now - ticket.enqueuedAt) / 1000)) : null, command: ticket?.command ?? null });
  }
  // Preserve arrival-name FIFO within each class. Unknown tickets retain their
  // ordinary place; priority is a validated, audited window, not a role flag.
  const tier = (row: HeavyQueueView) => row.ticket?.mode === "priority" || (row.ticket?.mode === "exclusive" && row.ticket.window) ? 2 : row.ticket?.mode === "grant" ? 1 : 0;
  rows.sort((a, b) => tier(b) - tier(a));
  return rows.map((row, index) => ({ ...row, position: index + 1 }));
}

export function enqueueHeavy(options: HeavyOptions, command: string, mode: "slot" | "exclusive" | "priority" | "grant") {
  const grant = mode === "grant" ? validateGrant(options, command) : undefined;
  if (mode === "priority") validateWindow(options, command, mode);
  const dir = heavyQueuePath(options.home);
  mkdirSync(dir, { recursive: true });
  const enqueuedAt = (options.now ?? Date.now)();
  let startedAt = new Date().toISOString();
  try {
    startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!Number.isFinite(Date.parse(startedAt))) startedAt = new Date().toISOString();
  } catch { /* Same conservative timestamp fallback as lock holders. */ }
  const ticket: HeavyTicket = { pid: process.pid, host: hostname(), startedAt, enqueuedAt, command: command.slice(0, 200), cwd: process.cwd(), mode, ...(grant ? { grant } : {}), ...(mode === "priority" || mode === "exclusive" ? { window: options.window } : {}) };
  for (let stamp = enqueuedAt; ; stamp++) {
    const name = `${String(stamp).padStart(16, "0")}-${process.pid}.json`;
    const path = join(dir, name);
    try { writeFileSync(path, `${JSON.stringify(ticket)}\n`, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
    return { name, release: () => { rmSync(path, { force: true }); } };
  }
}

export function waitAge(seconds: number | null): string {
  return seconds === null ? "unknown age" : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function heavyQueueState(options: HeavyOptions, ticket?: string, reap = false) {
  const rows = heavyQueue(options, (options.now ?? Date.now)(), reap);
  const own = rows.find((row) => row.name === ticket);
  // Missing tickets and in-process gates are newest, never implicitly first.
  const older = own ? own.position - 1 : rows.length;
  const { count } = settings(options);
  const lock = heavyLockPath(options.home);
  let freeSlots = 0;
  for (let n = 0; n < count; n++) {
    const path = slotPath(lock, n);
    if (reap ? blocker(path) === null : !existsSync(path) || stale(readHolder(path))) freeSlots++;
  }
  return { rows, own, older, freeSlots };
}

/** Serialize the queue decision with slot acquisition/removal across processes. */
function withAdmission(options: HeavyOptions, command: string, attempt: () => HeavyAcquire): HeavyAcquire {
  const guard = tryAcquire(join(options.home, ".local/state/muster/heavy-admission.lock"), command);
  if (!guard.ok) return { ok: false, reason: "heavy admission decision busy" };
  try { return attempt(); } finally { guard.release(); }
}

export function tryAcquireHeavy(options: HeavyOptions, command: string, ticket?: string): HeavyAcquire {
  return withAdmission(options, command, () => acquireHeavy(options, command, ticket));
}

function acquireHeavy(options: HeavyOptions, command: string, ticket?: string, priority = false, grant?: HeavyGrant): HeavyAcquire {
  listHeavyGrants(options);
  const { adapter, count, minFreeGB } = settings(options);
  const lock = heavyLockPath(options.home);
  reapExclusive(options);
  const blocked = blocker(exclusivePendingPath(options.home)) ?? blocker(lock, true);
  if (blocked) return { ok: false, reason: blocked };
  const pressure = pressureReason(adapter, minFreeGB);
  if (pressure) return { ok: false, reason: pressure };
  const queue = heavyQueueState(options, ticket, true);
  if (priority) {
    for (const path of [deploySlotPath(options.home), ...Array.from(new Set([0, ...existingSlots(lock)]), (n) => slotPath(lock, n))]) {
      if (blocker(path) !== null && readHolder(path)?.mode === "priority") return { ok: false, reason: "priority window already held" };
    }
    const olderPriority = queue.rows.filter((row) => row.ticket?.mode === "priority" && (!queue.own || row.position < queue.own.position));
    if (olderPriority.length) return { ok: false, reason: `heavy queue: ${olderPriority.length} older priority waiters` };
  }
  if (grant && queue.rows.some((row) => row.ticket?.mode === "priority" || (row.ticket?.mode === "exclusive" && row.ticket.window))) return { ok: false, reason: "deploy-window waiter ahead of grant" };
  if (grant && !queue.own && queue.rows.some((row) => row.ticket?.mode === "grant")) return { ok: false, reason: "older grant waiters" };
  const older = grant && !queue.own ? 0 : queue.older;
  if (!priority && older >= queue.freeSlots && older > 0) return { ok: false, reason: `heavy queue: ${queue.older} older waiters, ${queue.freeSlots} free slots` };
  const holders: string[] = [];
  const candidates = [
    ...(priority ? [{ name: "deploy-0", path: deploySlotPath(options.home) }] : []),
    ...Array.from({ length: count }, (_, n) => ({ name: `slot-${n}`, path: slotPath(lock, n) })),
  ];
  for (const { name, path } of candidates) {
    const slot = tryAcquire(path, command, process.pid, priority ? "priority" : grant ? "grant" : "slot");
    if (!slot.ok) {
      holders.push(`${name}: ${describeHolder(slot.holder)}`);
      continue;
    }
    // An exclusive request may have arrived while we were acquiring.
    const fence = blocker(exclusivePendingPath(options.home)) ?? blocker(lock, true);
    if (fence) {
      slot.release();
      return { ok: false, reason: fence };
    }
    try {
      if (priority) {
        const holder = readHolder(path);
        if (!holder) throw new Error("priority holder lost before metadata write");
        writeFileSync(join(path, "holder.json"), JSON.stringify({ ...holder, window: options.window, exclusiveAcquiredAt: new Date((options.now ?? Date.now)()).toISOString(), exclusiveCapMs: capMs(options, "priority") }));
      }
      if (grant) {
        const holder = readHolder(path);
        if (!holder) throw new Error("grant holder lost before metadata write");
        writeFileSync(join(path, "holder.json"), JSON.stringify({ ...holder, grant }));
      }
      if (queue.own) rmSync(join(heavyQueuePath(options.home), queue.own.name), { force: true });
    } catch (error) {
      slot.release();
      throw error;
    }
    return { ...slot, slot: name };
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
    held: { on: { CAP: "capped", CANCEL: "closed" } },
    capped: { on: { CANCEL: "closed" } },
    closed: { type: "final" },
  },
});

function validateWindow(options: HeavyOptions, command: string, mode: "exclusive" | "priority"): void {
  if (!options.window || !/^[A-Za-z0-9._:-]{1,64}$/.test(options.window)) {
    logExclusive(options, "refused", command, undefined, mode);
    throw new ExclusiveRefused();
  }
}

// Priority never reserves a drain: waiting -> held -> capped -> closed.
const priorityMachine = createMachine({
  initial: "waiting",
  states: {
    waiting: { on: { ACQUIRE: "held", CANCEL: "closed" } },
    held: { on: { CAP: "capped", CANCEL: "closed" } },
    capped: { on: { CANCEL: "closed" } },
    closed: { type: "final" },
  },
});

export function priorityRequest(options: HeavyOptions, command: string, ticket: () => string | undefined = () => undefined) {
  validateWindow(options, command, "priority");
  let slot: string | undefined;
  const audit = (event: ExclusiveEvent) => logExclusive(options, event, command, undefined, "priority", slot);
  audit("requested");
  const actor = createActor(priorityMachine).start();
  let unlock = () => {};
  let acquiredAtMs: number | undefined;
  const release = () => {
    if (actor.getSnapshot().matches("closed")) return;
    unlock();
    actor.send({ type: "CANCEL" });
    actor.stop();
    audit("released");
  };
  return {
    attempt: (): HeavyAcquire => {
      if (actor.getSnapshot().matches("held")) return { ok: true, release, slot };
      if (!actor.getSnapshot().matches("waiting")) return { ok: false, reason: "priority request closed" };
      const result = withAdmission(options, command, () => acquireHeavy(options, command, ticket(), true));
      if (!result.ok) return result;
      unlock = result.release;
      slot = result.slot;
      acquiredAtMs = (options.now ?? Date.now)();
      actor.send({ type: "ACQUIRE" });
      audit("acquired");
      return { ok: true, release, slot };
    },
    release,
    capMs: capMs(options, "priority"),
    get acquiredAtMs() { return acquiredAtMs; },
    capped: () => {
      if (!actor.getSnapshot().matches("held")) return;
      actor.send({ type: "CAP" });
      audit("capped");
      console.error(`muster-heavy: CAPPED priority window ${options.window}: hold reached ${capMs(options, "priority") / 60_000} min`);
    },
  };
}

export function exclusiveRequest(options: HeavyOptions, command: string, ticket: () => string | undefined = () => undefined) {
  validateWindow(options, command, "exclusive");
  logExclusive(options, "requested", command);
  const { adapter, count, minFreeGB } = settings(options);
  const lock = heavyLockPath(options.home);
  const actor = createActor(exclusiveMachine).start();
  const slots = new Set(Array.from({ length: count }, (_, n) => n));
  const releases: (() => void)[] = [];
  const ownedPaths: string[] = [];
  let acquiredAtMs: number | undefined;
  const decorate = (path: string, acquiredAt?: string) => {
    const holder = readHolder(path);
    if (!holder || holder.pid !== process.pid) throw new Error("exclusive holder lost before metadata write");
    writeFileSync(join(path, "holder.json"), JSON.stringify({ ...holder, window: options.window, exclusiveCapMs: capMs(options), ...(acquiredAt ? { exclusiveAcquiredAt: acquiredAt } : {}) }));
  };
  const release = () => {
    if (actor.getSnapshot().matches("closed")) return;
    for (const unlock of releases.splice(0).reverse()) unlock();
    actor.send({ type: "CANCEL" });
    actor.stop();
    logExclusive(options, "released", command);
  };
  const attempt = (): HeavyAcquire => {
    if (actor.getSnapshot().matches("closed") || actor.getSnapshot().matches("capped")) return { ok: false, reason: "exclusive request closed" };
    reapExclusive(options);
    if (actor.getSnapshot().matches("held")) return { ok: true, release };
    if (actor.getSnapshot().matches("waiting")) {
      // Reap even under pressure, but do not fence runnable slot jobs until
      // this request itself is eligible. Once reserved, retain drain priority.
      const blocked = blocker(exclusivePendingPath(options.home));
      if (blocked) return { ok: false, reason: blocked };
      const pressure = pressureReason(adapter, minFreeGB);
      if (pressure) return { ok: false, reason: pressure };
      const queue = heavyQueueState(options, ticket(), true);
      // Only the head may reserve a deploy drain, even if every slot is busy.
      if (queue.older > 0) return { ok: false, reason: `heavy queue: ${queue.older} older waiters before exclusive drain` };
      const pending = tryAcquire(exclusivePendingPath(options.home), command);
      if (!pending.ok) return { ok: false, reason: `exclusive-pending: ${describeHolder(pending.holder)}` };
      releases.push(pending.release);
      ownedPaths.push(exclusivePendingPath(options.home));
      decorate(exclusivePendingPath(options.home));
      actor.send({ type: "RESERVE" });
    }
    // Retain the legacy lock while draining: old sessions cannot see pending.
    if (actor.getSnapshot().matches("reserved")) {
      const legacy = tryAcquire(heavyLockPath(options.home), command, process.pid, "exclusive");
      if (!legacy.ok) return { ok: false, reason: `heavy-job.lock: ${describeHolder(legacy.holder)}` };
      releases.push(legacy.release);
      ownedPaths.push(lock);
      decorate(lock);
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
      const deploy = tryAcquire(deploySlotPath(options.home), command, process.pid, "exclusive");
      if (deploy.ok) acquired.push(deploy.release);
      else busy.push(`deploy-0: ${describeHolder(deploy.holder)}`);
      if (busy.length) {
        for (const unlock of acquired.reverse()) unlock();
        return { ok: false, reason: `exclusive draining: ${busy.join("; ")}` };
      }
      releases.push(...acquired);
      for (const n of slots) if (n !== 0) ownedPaths.push(slotPath(lock, n));
      ownedPaths.push(deploySlotPath(options.home));
      acquiredAtMs = (options.now ?? Date.now)();
      const acquiredAt = new Date(acquiredAtMs).toISOString();
      for (const path of ownedPaths) decorate(path, acquiredAt);
      actor.send({ type: "ACQUIRE" });
      logExclusive(options, "acquired", command);
      const own = heavyQueue(options).find((row) => row.name === ticket());
      if (own) rmSync(join(heavyQueuePath(options.home), own.name), { force: true });
      return { ok: true, release };
    } catch (error) {
      for (const unlock of acquired.reverse()) unlock();
      release();
      throw error;
    }
  };
  return { attempt: () => withAdmission(options, command, attempt), release, capMs: capMs(options), get acquiredAtMs() { return acquiredAtMs; }, capped: () => {
    if (!actor.getSnapshot().matches("held")) return;
    actor.send({ type: "CAP" });
    logExclusive(options, "capped", command);
    console.error(`muster-heavy: CAPPED exclusive window ${options.window}: hold reached ${capMs(options) / 60_000} min`);
  } };
}

export interface HeavySlotView {
  readonly name: string;
  readonly holder: Holder | null;
  readonly held: boolean;
  readonly ageSeconds: number | null;
  readonly health: HolderHealth | null;
  readonly stale: boolean;
  readonly window: string | null;
  readonly exclusiveAgeSeconds: number | null;
  readonly remainingSeconds: number | null;
}

/** `muster-heavy status --json` is a contract: fleet-compute placement reads slots, load, loadLimit,
 * availableGB, minFreeGB, holders[] (name, held, holder{pid,host,command,startedAt,mode}, ageSeconds, stale)
 * and exclusivePending. Adding fields is safe; ping the fleet desk before renaming or removing these.
 * holder.mode is a free string (slot, grant, exclusive, ...): placement treats only "exclusive" as exclusive.
 * Ping the fleet desk before adding a mode that should block placement (fleet-compute 7dd8cc8). */
export interface HeavySnapshot {
  readonly slots: number;
  readonly load: number;
  readonly loadLimit: number;
  readonly availableGB: number;
  readonly minFreeGB: number;
  readonly holders: readonly HeavySlotView[];
  readonly deploySlot: HeavySlotView;
  readonly exclusivePending: HeavySlotView;
  readonly queue: readonly HeavyQueueView[];
  readonly grants: readonly HeavyGrant[];
}

/** Read-only: one sample of the machine and every slot. Never takes or clears a lock. */
export function heavySnapshot(options: HeavyOptions, now = Date.now()): HeavySnapshot {
  const { adapter, count, minFreeGB } = settings(options);
  const lock = heavyLockPath(options.home);
  const sample = adapter.sample();
  const view = (name: string, path: string): HeavySlotView => {
    if (!existsSync(path)) return { name, holder: null, held: false, ageSeconds: null, health: null, stale: false, window: null, exclusiveAgeSeconds: null, remainingSeconds: null };
    const holder = readHolder(path);
    const ageSeconds = holder ? Math.max(0, Math.floor((now - Date.parse(holder.startedAt)) / 1000)) : null;
    const health = holderHealth(holder);
    const exclusive = name === "exclusive-pending" || holder?.mode === "exclusive" || holder?.window !== undefined;
    const acquiredAt = holder?.exclusiveAcquiredAt ?? (holder?.mode === "exclusive" && holder.window === undefined ? holder.startedAt : undefined);
    const exclusiveAgeSeconds = exclusive && acquiredAt ? Math.max(0, Math.floor((now - Date.parse(acquiredAt)) / 1000)) : null;
    const remainingSeconds = exclusive ? Math.max(0, Math.ceil((Math.min(capMs(options, holder?.mode === "priority" ? "priority" : "exclusive"), holder?.exclusiveCapMs ?? Infinity) - (acquiredAt ? Math.max(0, now - Date.parse(acquiredAt)) : 0)) / 1000)) : null;
    return { name, holder, held: true, ageSeconds, health, stale: health === "dead" || health === "reused", window: holder?.window ?? null, exclusiveAgeSeconds, remainingSeconds };
  };
  const slots = new Set([...Array.from({ length: count }, (_, n) => n), ...existingSlots(lock)]);
  return {
    slots: count,
    load: sample.load,
    loadLimit: sample.cores * 2.5,
    availableGB: sample.freeGB,
    minFreeGB,
    holders: Array.from(slots, (n) => view(`slot-${n}`, slotPath(lock, n))),
    deploySlot: view("deploy-0", deploySlotPath(options.home)),
    exclusivePending: view("exclusive-pending", exclusivePendingPath(options.home)),
    queue: heavyQueue(options, now),
    grants: listHeavyGrants({ ...options, now: () => now }, false),
  };
}

export function heavyStatus(options: HeavyOptions, now = Date.now()): string {
  const snap = heavySnapshot(options, now);
  const lines = [`heavy slots: ${snap.slots} + 1 deploy`, `grants: ${snap.grants.length}/4 live`, `load: ${snap.load.toFixed(1)} (not an admission rule); available memory: ${snap.availableGB.toFixed(1)} GB (minimum ${snap.minFreeGB} GB)`];
  for (const slot of [...snap.holders, snap.deploySlot, snap.exclusivePending]) {
    if (slot.name === "deploy-0" && slot.held && slot.holder?.mode === "priority") {
      lines.push(`${slot.name}: ⚡ window ${slot.window}; ${describeHolder(slot.holder, now, slot.health ?? "unknown")}${slot.stale ? "; stale" : ""}; hold age ${slot.exclusiveAgeSeconds}s; left ${slot.remainingSeconds}s`);
      continue;
    }
    lines.push(slot.held ? `${slot.name}: ${slot.holder?.mode === "grant" ? `🎟️ grant ${slot.holder.grant?.label ?? "unknown"}; ` : ""}${describeHolder(slot.holder, now, slot.health ?? "unknown")}${slot.stale ? "; stale" : ""}${slot.remainingSeconds !== null ? `; ${slot.holder?.mode === "priority" ? "⚡ " : ""}window ${slot.window ?? "legacy"}; hold age ${slot.exclusiveAgeSeconds === null ? "pending" : `${slot.exclusiveAgeSeconds}s`}; cap remaining ${slot.remainingSeconds}s` : ""}` : `${slot.name}: free`);
  }
  lines.push(`heavy queue: ${snap.queue.length}`);
  for (const row of snap.queue) lines.push(`position ${row.position}: pid ${row.pid ?? "unknown"}; ${row.health}; wait ${waitAge(row.ageSeconds)}; ${row.ticket?.mode === "priority" ? `⚡ window ${row.ticket.window}; ` : ""}${row.ticket?.mode === "grant" ? `🎟️ grant ${row.ticket.grant?.label}; ` : ""}${row.command ?? "unknown ticket"}`);
  return lines.join("\n");
}
