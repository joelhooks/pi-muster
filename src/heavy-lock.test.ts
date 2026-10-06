import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHeavyJob } from "./domain.ts";
import { finishJob, heavyReport, heavySnapshot, jobsPath, machineAdapter, parseMemInfo, parseVmStat, parseCpuTime, parseProcessSamples, parseSince, readJobs, registerJob, sampleJobs, treeSample } from "./heavy-lock.ts";

const homes: string[] = [];
function setup() { const home = mkdtempSync(join(tmpdir(), "heavy-jobs-test-")); homes.push(home); return { home }; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function cli(home: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [resolve("bin/muster-heavy.ts"), ...args], { encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: home, ...env } });
}

describe("job registry", () => {
  it("records one atomic job with full command and terminal metrics", () => {
    const options = setup();
    const command = `sh -c fc-run123 ${"long-argument ".repeat(100)}`;
    const job = registerJob({ ...options, now: () => 10000 }, command);
    expect(job).toMatchObject({ host: hostname(), pid: process.pid, cwd: process.cwd(), command, state: "running", startedAt: "1970-01-01T00:00:10.000Z" });
    expect(readdirSync(jobsPath(options.home))).toEqual([`${job.id}.json`]);
    expect(finishJob(options, job, 7, 12000, 1.23)).toMatchObject({ state: "finished", exit: 7, wallMs: 2000, cpuSeconds: 1.23 });
    expect(finishJob(options, job, null, 13000).state).toBe("finished");
  });
  it("preserves a claimed tmpdir through registration and terminal decoding", () => {
    const options = setup();
    const dir = "/Volumes/gate-tmp/run-123-example";
    const job = registerJob(options, "RAM job", process.cwd(), process.pid, dir);
    expect(readJobs(options.home)[0]?.tmpdir).toBe(dir);
    expect(finishJob(options, job, 0).tmpdir).toBe(dir);
    expect(readJobs(options.home)[0]?.tmpdir).toBe(dir);
    expect(() => decodeHeavyJob({ ...job, tmpdir: 42 })).toThrow();
  });
  it("rejects malformed records and impossible terminal variants", () => {
    const options = setup(); const job = registerJob(options, "test");
    expect(() => decodeHeavyJob({ ...job, state: "lost", exit: 0, lost: true })).toThrow();
    writeFileSync(join(jobsPath(options.home), `${job.id}.json`), '{"pid":"wrong"}');
    expect(() => readJobs(options.home)).toThrow();
  });
  it("status finalizes a dead local pid as lost, never a foreign pid", () => {
    const options = setup(); const job = registerJob(options, "vanished", process.cwd(), 2147483647);
    const foreign = registerJob(options, "foreign", process.cwd(), 2147483646);
    writeFileSync(join(jobsPath(options.home), `${foreign.id}.json`), JSON.stringify({ ...foreign, host: "foreign-host" }));
    const snapshot = heavySnapshot(options);
    expect(readJobs(options.home).find(row => row.id === job.id)).toMatchObject({ state: "lost", exit: null, lost: true });
    expect(snapshot.jobs.map(row => row.id)).toEqual([foreign.id]);
    expect(snapshot.holders[0]?.stale).toBe(false);
  });
  it("keeps every field fleet-compute placement reads and advertises spare slot capacity", () => {
    vi.stubEnv("MUSTER_HEAVY_MIN_FREE_GB", undefined);
    const options = setup();
    registerJob(options, "sh -c fc-contract sleep 20"); registerJob(options, "second sleep 20");
    const snapshot = JSON.parse(JSON.stringify(heavySnapshot(options)));
    expect(snapshot.slots).toBe(snapshot.holders.length + 1);
    for (const key of ["slots", "load", "loadLimit", "availableGB", "minFreeGB"]) expect(typeof snapshot[key]).toBe("number");
    expect(snapshot.minFreeGB).toBe(16); expect(snapshot.loadLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(snapshot.exclusivePending).toEqual({ name: "exclusive-pending", held: false, holder: null, ageSeconds: null, stale: false });
    expect(snapshot.holders).toHaveLength(2);
    for (const holder of snapshot.holders) {
      for (const key of ["name", "held", "holder", "ageSeconds", "stale"]) expect(holder).toHaveProperty(key);
      for (const key of ["pid", "host", "command", "startedAt", "mode"]) expect(holder.holder).toHaveProperty(key);
      expect(holder.holder.mode).toBe("job"); expect(holder.held).toBe(true);
    }
    expect(snapshot.holders.map((row: { holder: { command: string } }) => row.holder.command)).toContain("sh -c fc-contract sleep 20");
  });
});

describe("available memory compatibility", () => {
  it("includes large inactive and speculative vm_stat pages in the status contract", () => {
    const fixture = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 16384.\nPages inactive: 2818048.\nPages speculative: 131072.\n";
    const freeGB = parseVmStat(fixture);
    expect(freeGB).toBe(45.25); // 0.25 GB free + 43 GB inactive + 2 GB speculative.
    vi.spyOn(machineAdapter, "sample").mockReturnValue({ cores: 16, load: 20, freeGB });
    expect(heavySnapshot(setup()).availableGB).toBe(45.25);
  });
  it("uses Linux MemAvailable rather than MemFree", () => {
    const freeGB = parseMemInfo("MemFree: 1048576 kB\nMemAvailable: 47185920 kB\n");
    expect(freeGB).toBe(45);
    vi.spyOn(machineAdapter, "sample").mockReturnValue({ cores: 16, load: 20, freeGB });
    expect(heavySnapshot(setup()).availableGB).toBe(45);
  });
  it("rejects missing memory data rather than falling back to raw free memory", () => {
    expect(() => parseVmStat("unreadable")).toThrow("cannot read available memory");
    expect(() => parseMemInfo("MemFree: 1048576 kB\n")).toThrow("cannot read MemAvailable");
  });
});

describe("informational memory floor", () => {
  it.each([
    { configured: "32", expected: 32 },
    { configured: "0", expected: 0 },
    { configured: "", expected: 16 },
    { configured: "bad", expected: 16 },
    { configured: "-1", expected: 16 },
    { configured: "Infinity", expected: 16 },
  ])("reports $configured as $expected without gating registration", ({ configured, expected }) => {
    vi.stubEnv("MUSTER_HEAVY_MIN_FREE_GB", configured);
    const options = setup();
    const job = registerJob(options, "runs immediately");
    const snapshot = heavySnapshot(options);
    expect(snapshot.minFreeGB).toBe(expected);
    expect(snapshot.jobs.map(row => row.id)).toContain(job.id);
  });
});

describe("batched process telemetry", () => {
  it("parses Darwin/Linux CPU durations and sums a full descendant tree", () => {
    expect(parseCpuTime("01:02.50")).toBe(62.5);
    expect(parseCpuTime("1-02:03:04")).toBe(93784);
    const rows = parseProcessSamples("10 1 5.0 100 00:01.00\n11 10 75.0 200 00:02.50\n12 11 100.0 300 00:03.25\n13 1 99 999 00:09.00\nmalformed");
    expect(treeSample(10, rows)).toEqual({ cpuPercent: 180, rssKB: 600, cpuSeconds: 6.75 });
  });
  it("uses one ps across live jobs and caches it for five seconds, preserving peak RSS", () => {
    const options = setup();
    const first = registerJob(options, "one", process.cwd(), 10);
    const second = registerJob(options, "two", process.cwd(), 20);
    let calls = 0;
    const ps = () => { calls++; return "10 1 25 100 00:01.00\n11 10 50 200 00:02.00\n20 1 80 500 00:03.00"; };
    const initial = sampleJobs(options, 10000, ps);
    expect(initial.jobs[first.id]).toMatchObject({ cpuPercent: 75, rssKB: 300, peakRssKB: 300, cpuSeconds: 3 });
    expect(initial.jobs[second.id]?.cpuPercent).toBe(80);
    sampleJobs(options, 14999, ps); expect(calls).toBe(1);
    const next = sampleJobs(options, 15000, () => { calls++; return "10 1 1 50 00:01.50\n20 1 2 100 00:04.00"; });
    expect(calls).toBe(2); expect(next.jobs[first.id]).toMatchObject({ rssKB: 50, peakRssKB: 300, cpuSeconds: 3 });
  });
  it("recovers a crashed sampler without delaying commands", () => {
    const options = setup(); registerJob(options, "one");
    mkdirSync(join(jobsPath(options.home), "sampling"));
    writeFileSync(join(jobsPath(options.home), "sampling/pid"), "2147483647");
    sampleJobs(options, 10000, () => "");
    expect(sampleJobs(options, 10000, () => "").sampledAt).toBe(10000);
  });
});

describe("cost report", () => {
  it("groups count, wall, CPU and maximum RSS per repo and command within --since", () => {
    const options = setup();
    const old = registerJob({ ...options, now: () => 1000 }, "old"); finishJob(options, old, 0, 2000, 9);
    for (let i = 0; i < 2; i++) { const job = registerJob({ ...options, now: () => 10000 }, "same"); finishJob(options, job, i, 11000, 2); }
    const report = heavyReport(options, "5s", 12000);
    expect(report.repos).toHaveLength(1);
    expect(report.repos[0]).toMatchObject({ count: 2, wallMs: 2000, cpuSeconds: 4, lost: 0 });
    expect(report.commands).toEqual([expect.objectContaining({ command: "same", count: 2, cpuSeconds: 4 })]);
    expect(parseSince("24h")).toBe(86400000); expect(() => parseSince("potato")).toThrow();
  });
});

describe("register-and-run CLI", () => {
  it("ignores all legacy admission settings in one line and keeps command stderr and exit", () => {
    const { home } = setup();
    const result = cli(home, ["--wait", "nonsense", "--exclusive", "--grant", "expired", "--", "sh", "-c", "printf command-stderr >&2; exit 7"], { MUSTER_HEAVY_SLOTS: "0", MUSTER_HEAVY_MIN_FREE_GB: "999999", MUSTER_DEPLOY_WINDOW: "invalid window" });
    expect(result.status, result.stderr).toBe(7);
    expect(result.stderr.match(/ignored legacy admission settings/g)).toHaveLength(1);
    for (const name of ["--wait", "--exclusive", "--grant", "MUSTER_HEAVY_SLOTS", "MUSTER_HEAVY_MIN_FREE_GB", "MUSTER_DEPLOY_WINDOW"]) expect(result.stderr).toContain(name);
    expect(result.stderr).toContain("command-stderr"); expect(result.stderr).not.toMatch(/real\s+\d/);
    expect(readJobs(home)[0]).toMatchObject({ state: "finished", exit: 7 });
  }, 25000);
  it("accepts inert grant management and does not create admission files", () => {
    const { home } = setup(); const result = cli(home, ["grant", "label", "--ttl", "1h"]);
    expect(result.status).toBe(0); expect(result.stderr).toContain("grant"); expect(readJobs(home)).toEqual([]);
  }, 25000);
  it("records CPU-seconds even for a job shorter than the sampling interval", () => {
    const { home } = setup();
    const result = cli(home, ["--", process.execPath, "-e", "const t=Date.now()+200; while(Date.now()<t){}"]);
    expect(result.status, result.stderr).toBe(0);
    const job = readJobs(home)[0]!;
    expect(job.cpuSeconds).toBeGreaterThan(0.05);
    expect(job.state).toBe("finished");
    const report = cli(home, ["report", "--since", "24h", "--json"]);
    expect(JSON.parse(report.stdout).jobs[0].cpuSeconds).toBe(job.cpuSeconds);
  }, 25000);
  it.each([
    { command: ["sh", "-c", "exit 143"], exit: 143 },
    { command: ["sh", "-c", "kill -TERM $$"], exit: 128 },
    { command: ["/no/such/muster-command"], exit: 127 },
  ])("propagates command $command as $exit", ({ command, exit }) => {
    const { home } = setup(); const result = cli(home, ["--", ...command]);
    expect(result.status, result.stderr).toBe(exit); expect(readJobs(home)[0]).toMatchObject({ state: "finished", exit });
  }, 25000);
  it("starts two commands concurrently and forwards a signal, leaving finalized records", async () => {
    const { home } = setup();
    const start = (label: string) => spawn(process.execPath, [resolve("bin/muster-heavy.ts"), "--wait", "3600", "--", "sh", "-c", `echo ${label}; sleep 20`], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    const a = start("first"); const b = start("second");
    const finished = [a, b].map(child => new Promise<number | null>(resolve => child.on("close", code => resolve(code))));
    try {
      await Promise.all([a, b].map(child => new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); })));
      const snapshot = heavySnapshot({ home });
      expect(snapshot.holders).toHaveLength(2); expect(snapshot.slots).toBe(3);
      expect(snapshot.holders.every(row => row.holder.command.includes("sleep 20"))).toBe(true);
    } finally { a.kill("SIGTERM"); b.kill("SIGTERM"); await Promise.all(finished); }
    expect(readJobs(home).every(job => job.state === "finished" && job.exit === 128)).toBe(true);
  }, 25000);
});
