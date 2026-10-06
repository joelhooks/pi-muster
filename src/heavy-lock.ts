import { freemem, hostname, loadavg } from "node:os";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { transition } from "xstate";
import { decodeHeavyJob, decodeHeavySampleCache, type HeavyJob } from "./domain.ts";
import { heavyJobMachine } from "./machines.ts";

export interface HeavyOptions {
  readonly home: string;
  /** Legacy options are inert, retained only for CLI callers. */
  readonly window?: string;
  readonly grant?: string;
  readonly now?: () => number;
}
export const jobsPath = (home: string) => join(home, ".local/state/muster/jobs");
const jobPath = (home: string, id: string) => join(jobsPath(home), `${id}.json`);

function atomicJSON(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}
export function readJobs(home: string): HeavyJob[] {
  let names: string[];
  try { names = readdirSync(jobsPath(home)); }
  catch (error) { if (isCode(error, "ENOENT")) return []; throw error; }
  return names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name =>
    decodeHeavyJob(JSON.parse(readFileSync(join(jobsPath(home), name), "utf8"))));
}
function isCode(error: unknown, code: string) { return error instanceof Error && "code" in error && error.code === code; }
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return isCode(error, "EPERM"); }
}
export function registerJob(options: HeavyOptions, command: string, cwd = process.cwd(), pid = process.pid): HeavyJob {
  let repo = cwd;
  try { repo = basename(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { /* Outside Git, cwd is the repo identity. */ }
  const job: HeavyJob = { id: randomUUID(), host: hostname(), repo, cwd, command, pid,
    startedAt: new Date((options.now ?? Date.now)()).toISOString(), state: "running",
    cpuPercent: 0, rssKB: 0, peakRssKB: 0, cpuSeconds: 0, sampledAt: null };
  atomicJSON(jobPath(options.home, job.id), job);
  return job;
}

export interface ProcessSample { readonly pid: number; readonly ppid: number; readonly cpuPercent: number; readonly rssKB: number; readonly cpuSeconds: number }
/** ps time supports [days-][hours:]minutes:seconds.fraction on both Darwin and Linux. */
export function parseCpuTime(value: string): number {
  const [days, time] = value.includes("-") ? value.split("-") : ["0", value];
  return Number(days) * 86400 + time!.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}
export function parseProcessSamples(text: string): ProcessSample[] {
  return text.trim().split("\n").flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5) return [];
    const [pid, ppid, cpuPercent, rssKB] = fields.slice(0, 4).map(Number);
    const cpuSeconds = parseCpuTime(fields[4]!);
    return [pid, ppid, cpuPercent, rssKB, cpuSeconds].every(n => n !== undefined && Number.isFinite(n) && n >= 0)
      ? [{ pid: pid!, ppid: ppid!, cpuPercent: cpuPercent!, rssKB: rssKB!, cpuSeconds }] : [];
  });
}
export function treeSample(pid: number, rows: readonly ProcessSample[]) {
  const children = new Map<number, ProcessSample[]>();
  for (const row of rows) { const group = children.get(row.ppid) ?? []; group.push(row); children.set(row.ppid, group); }
  const root = rows.find(row => row.pid === pid);
  const pending = root ? [root] : [];
  const seen = new Set<number>();
  let cpuPercent = 0, rssKB = 0, cpuSeconds = 0;
  while (pending.length) {
    const row = pending.pop()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid); cpuPercent += row.cpuPercent; rssKB += row.rssKB; cpuSeconds += row.cpuSeconds;
    pending.push(...children.get(row.pid) ?? []);
  }
  return { cpuPercent, rssKB, cpuSeconds };
}

/** A shared telemetry cache bounds all CLI samplers to one batched ps per five seconds.
 * The tiny mutex protects only cache writes; it never delays or admits a command.
 * No sampler owns another job's record. Terminal records are written only at finalization.
 */
export function sampleJobs(options: HeavyOptions, now = (options.now ?? Date.now)(), ps = () => execFileSync("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,time="], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } })) {
  const path = join(jobsPath(options.home), "samples.json");
  const readCache = () => {
    try { return decodeHeavySampleCache(JSON.parse(readFileSync(path, "utf8"))); }
    catch (error) { if (isCode(error, "ENOENT")) return { sampledAt: 0, jobs: {} }; throw error; }
  };
  mkdirSync(jobsPath(options.home), { recursive: true, mode: 0o700 });
  let cache = readCache();
  const lock = join(jobsPath(options.home), "sampling");
  if (now - cache.sampledAt >= 5000) {
    try { mkdirSync(lock); }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      // Crash recovery uses the sampler's pid, never the sampled job's pid.
      try { if (!alive(Number(readFileSync(join(lock, "pid"), "utf8")))) rmSync(lock, { recursive: true }); }
      catch {
        // A crash between mkdir and the pid write leaves no owner. A ps pass is
        // bounded to two seconds; ten seconds without a pid proves it abandoned.
        try { if (now - statSync(lock).mtimeMs > 10000) rmSync(lock, { recursive: true }); } catch { /* Another sampler already recovered it. */ }
      }
      return cache;
    }
    try {
      writeFileSync(join(lock, "pid"), String(process.pid));
      cache = readCache();
      if (now - cache.sampledAt >= 5000) {
        const rows = parseProcessSamples(ps());
        const jobs: Record<string, { cpuPercent: number; rssKB: number; peakRssKB: number; cpuSeconds: number }> = {};
        for (const job of readJobs(options.home).filter(job => job.state === "running" && job.host === hostname())) {
          const sample = treeSample(job.pid, rows);
          const prior = cache.jobs[job.id];
          jobs[job.id] = { ...sample, peakRssKB: Math.max(job.peakRssKB, prior?.peakRssKB ?? 0, sample.rssKB),
            // Completed descendants disappear from ps. Retain the observed high-water CPU time.
            cpuSeconds: Math.max(job.cpuSeconds, prior?.cpuSeconds ?? 0, sample.cpuSeconds) };
        }
        cache = { sampledAt: now, jobs };
        atomicJSON(path, cache);
      }
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  return cache;
}
export function refreshJob(options: HeavyOptions, job: HeavyJob, now = (options.now ?? Date.now)()): void {
  const cache = sampleJobs(options, now);
  const current = decodeHeavyJob(JSON.parse(readFileSync(jobPath(options.home, job.id), "utf8")));
  if (current.state === "running") atomicJSON(jobPath(options.home, job.id), withSample(current, cache));
}
function withSample(job: HeavyJob, cache: ReturnType<typeof sampleJobs>): HeavyJob {
  const sample = cache.jobs[job.id];
  return sample ? { ...job, ...sample, sampledAt: cache.sampledAt } : job;
}
export function finishJob(options: HeavyOptions, job: HeavyJob, exit: number | null, now = (options.now ?? Date.now)(), cpuSeconds?: number): HeavyJob {
  const current = decodeHeavyJob(JSON.parse(readFileSync(jobPath(options.home, job.id), "utf8")));
  if (current.state !== "running") return current;
  const snapshot = heavyJobMachine.resolveState({ value: current.state });
  const [next] = transition(heavyJobMachine, snapshot, { type: exit === null ? "LOSE" : "FINISH" });
  const facts = { ...withSample(current, sampleJobs(options, now)), ...(cpuSeconds !== undefined ? { cpuSeconds } : {}), wallMs: Math.max(0, now - Date.parse(current.startedAt)), finishedAt: new Date(now).toISOString() };
  const finished = decodeHeavyJob(next.matches("lost") ? { ...facts, state: "lost", exit: null, lost: true } : { ...facts, state: "finished", exit });
  atomicJSON(jobPath(options.home, job.id), finished);
  return finished;
}
export function liveJobs(options: HeavyOptions, now = (options.now ?? Date.now)()): HeavyJob[] {
  const cache = sampleJobs(options, now);
  return readJobs(options.home).flatMap(job => {
    if (job.state !== "running") return [];
    if (job.host === hostname() && !alive(job.pid)) { finishJob(options, job, null, now); return []; }
    return [withSample(job, cache)];
  });
}

export interface HeavySlotView {
  readonly name: string; readonly held: boolean;
  readonly holder: { readonly pid: number; readonly host: string; readonly command: string; readonly startedAt: string; readonly mode: "job" } | null;
  readonly ageSeconds: number | null; readonly stale: boolean;
}
/** Fleet-compute reads slots, load, loadLimit, availableGB, minFreeGB, holders
 * (name, held, holder{pid,host,command,startedAt,mode}, ageSeconds, stale), exclusivePending.
 * slots is live count + 1, not capacity. Only mode=exclusive blocks fleet placement.
 * Full command strings identify fc-<runId> runs. Never truncate them.
 */
/** Fleet may use this floor for placement. Local execution never consults it. */
function configuredMemoryFloor(value = process.env.MUSTER_HEAVY_MIN_FREE_GB): number {
  const number = value?.trim() ? Number(value) : 16;
  return Number.isFinite(number) && number >= 0 ? number : 16;
}
export function heavySnapshot(options: HeavyOptions, now = (options.now ?? Date.now)()) {
  const jobs = liveJobs(options, now);
  return { slots: jobs.length + 1, load: loadavg()[0] ?? 0, loadLimit: Number.MAX_SAFE_INTEGER,
    availableGB: freemem() / 1024 ** 3, minFreeGB: configuredMemoryFloor(),
    holders: jobs.map((job, index) => ({ name: `slot-${index}`, held: true, holder: { pid: job.pid, host: job.host, command: job.command, startedAt: job.startedAt, mode: "job" as const }, ageSeconds: Math.max(0, Math.floor((now - Date.parse(job.startedAt)) / 1000)), stale: false })),
    exclusivePending: { name: "exclusive-pending", held: false, holder: null, ageSeconds: null, stale: false } satisfies HeavySlotView,
    jobs };
}
export type HeavySnapshot = ReturnType<typeof heavySnapshot>;
export function heavyStatus(options: HeavyOptions) {
  const snap = heavySnapshot(options);
  return [`jobs: ${snap.jobs.length}; load: ${snap.load.toFixed(1)}; available memory: ${snap.availableGB.toFixed(1)} GB (telemetry only)`,
    ...snap.jobs.map(job => `${job.id}: pid ${job.pid}; CPU ${job.cpuPercent.toFixed(1)}%; RSS ${job.rssKB} KB; peak ${job.peakRssKB} KB; ${job.command}`)].join("\n");
}
export function parseSince(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error("--since requires a duration such as 24h");
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const duration = Number(match[1]) * units[match[2]!]!;
  if (!Number.isFinite(duration)) throw new Error("--since must be finite");
  return duration;
}
export function heavyReport(options: HeavyOptions, since = "24h", now = (options.now ?? Date.now)()) {
  const cutoff = now - parseSince(since);
  liveJobs(options, now); // Status/report are the recovery pass for vanished wrappers.
  const jobs = readJobs(options.home).filter(job => job.state !== "running" && Date.parse(job.startedAt) >= cutoff);
  const group = (key: "repo" | "command") => {
    const groups = new Map<string, { count: number; wallMs: number; cpuSeconds: number; peakRssKB: number; lost: number }>();
    for (const job of jobs) {
      if (job.state === "running") continue;
      const row = groups.get(job[key]) ?? { count: 0, wallMs: 0, cpuSeconds: 0, peakRssKB: 0, lost: 0 };
      row.count++; row.wallMs += job.wallMs; row.cpuSeconds += job.cpuSeconds; row.peakRssKB = Math.max(row.peakRssKB, job.peakRssKB); row.lost += job.state === "lost" ? 1 : 0;
      groups.set(job[key], row);
    }
    return Array.from(groups, ([name, metrics]) => ({ [key]: name, ...metrics }));
  };
  return { since, repos: group("repo"), commands: group("command"), jobs };
}
