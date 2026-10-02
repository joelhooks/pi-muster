import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  admissionReason, exclusivePendingPath, exclusiveRequest, heavyLockPath, heavySlotCount, heavyStatus,
  parseMemInfo, parseVmStat, readHolder, slotPath, tryAcquire, tryAcquireHeavy,
} from "./heavy-lock.ts";
import type { HeavyAdapter, HeavyOptions } from "./heavy-lock.ts";

const homes: string[] = [];
const adapter: HeavyAdapter = { performanceCores: () => 12, sample: () => ({ cores: 16, load: 20, freeGB: 64 }) };
function setup(): HeavyOptions {
  const home = mkdtempSync(join(tmpdir(), "heavy-slots-test-"));
  homes.push(home);
  return { home, adapter, slots: "2", minFreeGB: "16" };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

// Node's preload changes only the test child's adapter, never real machine state.
function cli(options: HeavyOptions, args: string[], sampleCode = "({ cores: 16, load: 20, freeGB: 64 })") {
  const source = `import { machineAdapter } from ${JSON.stringify(pathToFileURL(resolve("src/heavy-lock.ts")).href)}; let calls = 0; machineAdapter.performanceCores = () => 12; machineAdapter.sample = () => { calls++; return ${sampleCode}; };`;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(source)}`, "bin/muster-heavy.ts", ...args], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, HOME: options.home, MUSTER_HEAVY_SLOTS: "2", MUSTER_HEAVY_MIN_FREE_GB: "16" },
  });
}

describe("heavy gate slots", () => {
  it("derives the count from performance cores (fallback takes half the available CPUs)", () => {
    expect(heavySlotCount(12)).toBe(4);
    expect(heavySlotCount(8)).toBe(2);
    expect(heavySlotCount(16 / 2)).toBe(2);
    expect(heavySlotCount(1)).toBe(1);
    expect(heavySlotCount(12, "7")).toBe(7);
    for (const value of ["0", "-1", "2.5", "no", "Infinity", ""]) expect(() => heavySlotCount(12, value)).toThrow();
  });

  it("admits N concurrent holders and names every holder when full", () => {
    const options = setup();
    const a = tryAcquireHeavy(options, "gate a");
    const b = tryAcquireHeavy(options, "gate b");
    expect(a.ok && b.ok).toBe(true);
    const c = tryAcquireHeavy(options, "gate c");
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toContain("gate a");
      expect(c.reason).toContain("gate b");
    }
    if (a.ok) a.release();
    const d = tryAcquireHeavy(options, "gate d");
    expect(d.ok).toBe(true);
    if (b.ok) b.release();
    if (d.ok) d.release();
  });

  it("takes over a stale slot and pending marker", () => {
    const options = setup();
    tryAcquire(slotPath(heavyLockPath(options.home), 0), "dead gate", 999_999_99, "slot");
    tryAcquire(exclusivePendingPath(options.home), "dead deploy", 999_999_99);
    const held = tryAcquireHeavy(options, "live gate");
    expect(held.ok).toBe(true);
    expect(readHolder(heavyLockPath(options.home))?.command).toBe("live gate");
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    if (held.ok) held.release();
  });

  it("counts an unmarked legacy holder as one busy slot and leaves it untouched", () => {
    const options = setup();
    const legacy = tryAcquire(heavyLockPath(options.home), "old gate");
    const held = tryAcquireHeavy(options, "new gate");
    expect(held.ok).toBe(true);
    expect(readHolder(heavyLockPath(options.home))?.command).toBe("old gate");
    if (held.ok) held.release();
    if (legacy.ok) legacy.release();
  });

  it("fences new admission only behind a slot 0 marked exclusive", () => {
    const options = setup();
    const hold = tryAcquire(heavyLockPath(options.home), "deploy", process.pid, "exclusive");
    const held = tryAcquireHeavy(options, "new gate");
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.reason).toContain("deploy");
    if (hold.ok) hold.release();
  });

  it("pending fences new jobs, drains every existing slot, holds and releases all", () => {
    const options = setup();
    const lock = heavyLockPath(options.home);
    const a = tryAcquireHeavy(options, "gate a");
    const b = tryAcquireHeavy(options, "gate b");
    // A slot from an earlier, larger configuration must drain too.
    const extra = tryAcquire(slotPath(lock, 4), "extra gate", process.pid, "slot");
    const deploy = exclusiveRequest(options, "deploy hold");
    expect(deploy.attempt().ok).toBe(false);
    expect(readHolder(exclusivePendingPath(options.home))?.command).toBe("deploy hold");
    if (a.ok) a.release();
    expect(tryAcquireHeavy(options, "blocked new gate").ok).toBe(false);
    expect(deploy.attempt().ok).toBe(false);
    // The legacy fence stays held while the other slots drain.
    expect(tryAcquire(lock, "old code").ok).toBe(false);
    if (b.ok) b.release();
    expect(deploy.attempt().ok).toBe(false);
    if (extra.ok) extra.release();
    expect(deploy.attempt().ok).toBe(true);
    for (const n of [0, 1, 4]) expect(readHolder(slotPath(lock, n))?.command).toBe("deploy hold");
    expect(tryAcquireHeavy(options, "blocked new gate").ok).toBe(false);
    deploy.release();
    for (const n of [0, 1, 4]) expect(existsSync(slotPath(lock, n))).toBe(false);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    expect(deploy.attempt().ok).toBe(false);
  });

  it("cancels a draining request without releasing somebody else's live slot", () => {
    const options = setup();
    const held = tryAcquireHeavy(options, "live gate");
    const deploy = exclusiveRequest(options, "cancelled hold");
    expect(deploy.attempt().ok).toBe(false);
    deploy.release();
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    expect(readHolder(heavyLockPath(options.home))?.command).toBe("live gate");
    if (held.ok) held.release();
  });

  it("serializes exclusive requesters and preserves a live old lock", () => {
    const options = setup();
    const legacy = tryAcquire(heavyLockPath(options.home), "old window");
    const a = exclusiveRequest(options, "hold a");
    const b = exclusiveRequest(options, "hold b");
    expect(a.attempt().ok).toBe(false);
    expect(b.attempt().ok).toBe(false);
    b.release();
    expect(readHolder(exclusivePendingPath(options.home))?.command).toBe("hold a");
    expect(readHolder(heavyLockPath(options.home))?.command).toBe("old window");
    if (legacy.ok) legacy.release();
    expect(a.attempt().ok).toBe(true);
    a.release();
  });

  it("fails closed on an unknown legacy holder", () => {
    const options = setup();
    const legacy = tryAcquire(heavyLockPath(options.home), "holder");
    writeFileSync(join(heavyLockPath(options.home), "holder.json"), "{}");
    expect(tryAcquireHeavy(options, "gate").ok).toBe(false);
    if (legacy.ok) legacy.release();
    expect(existsSync(heavyLockPath(options.home))).toBe(true);
  });

  it("reads status without taking or clearing any locks, including stale ones", () => {
    const options = setup();
    const lock = heavyLockPath(options.home);
    tryAcquire(slotPath(lock, 1), "dead gate", 999_999_99, "slot");
    tryAcquire(exclusivePendingPath(options.home), "dead hold", 999_999_99);
    const before = readFileSync(join(slotPath(lock, 1), "holder.json"), "utf8");
    const status = heavyStatus(options, Date.now() + 2000);
    expect(status).toContain("heavy slots: 2");
    expect(status).toContain("slot-0: free");
    expect(status).toContain("slot-1: pid 99999999");
    expect(status).toContain("age 2s; stale");
    expect(status).toContain("exclusive-pending: pid 99999999");
    expect(status).toContain("load: 20.0");
    expect(status).toContain("available memory: 64.0 GB");
    expect(readFileSync(join(slotPath(lock, 1), "holder.json"), "utf8")).toBe(before);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(true);
    const empty = setup();
    expect(cli(empty, ["status"]).stdout).toContain("slot-1: free");
    expect(existsSync(join(empty.home, ".local"))).toBe(false);
  });
});

describe("machine pressure admission", () => {
  it("parses reclaimable macOS pages and Linux MemAvailable", () => {
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\nPages inactive: 65536.\nPages speculative: 65536.')).toBe(3);
    expect(parseMemInfo("MemFree: 1 kB\nMemAvailable: 16777216 kB\n")).toBe(16);
    expect(() => parseVmStat("bad")).toThrow();
    expect(() => parseMemInfo("MemFree: 20 kB")).toThrow();
  });

  it("refuses high load or low memory without creating slots", () => {
    for (const sample of [{ cores: 16, load: 41, freeGB: 64 }, { cores: 16, load: 20, freeGB: 15 }]) {
      const options = setup();
      const result = tryAcquireHeavy({ ...options, adapter: { ...adapter, sample: () => sample } }, "gate");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/load|memory/);
      expect(existsSync(heavyLockPath(options.home))).toBe(false);
    }
    expect(admissionReason({ cores: 16, load: 40, freeGB: 16 }, 16)).toBeNull();
    expect(admissionReason({ cores: 16, load: NaN, freeGB: 64 }, 16)).toContain("unavailable");
    const options = setup();
    const unreadable = tryAcquireHeavy({ ...options, adapter: { ...adapter, sample: () => { throw new Error("vm_stat failed"); } } }, "gate");
    expect(unreadable).toEqual({ ok: false, reason: "machine load/memory unavailable: vm_stat failed" });
    expect(existsSync(heavyLockPath(options.home))).toBe(false);
  });

  it("CLI waits and prints why under fake high load or low memory, then starts", () => {
    for (const pressure of ["{ cores: 16, load: 41, freeGB: 64 }", "{ cores: 16, load: 20, freeGB: 15 }"]) {
      for (const flags of [[], ["--exclusive"]]) {
        const options = setup();
        const result = cli(options, [...flags, "--wait", "0.05", "--", process.execPath, "-e", "console.log('started')"], `calls === 1 ? ${pressure} : { cores: 16, load: 20, freeGB: 64 }`);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toMatch(/waiting, (load|available memory)/);
        expect(result.stdout).toContain("started");
        expect(existsSync(heavyLockPath(options.home))).toBe(false);
        expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
      }
    }
  });

  it("CLI holds every slot during an exclusive command and propagates its exit code", () => {
    const options = setup();
    const paths = [0, 1].map((n) => join(slotPath(heavyLockPath(options.home), n), "holder.json"));
    const command = `const fs = require('node:fs'); console.log(${JSON.stringify(paths)}.every(p => fs.existsSync(p))); process.exit(3);`;
    const result = cli(options, ["--exclusive", "--", process.execPath, "-e", command]);
    expect(result.status).toBe(3);
    expect(result.stdout.trim()).toBe("true");
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    for (const n of [0, 1]) expect(existsSync(slotPath(heavyLockPath(options.home), n))).toBe(false);
  });

  it("CLI cleans exclusive reservations on timeout and spawn failure", () => {
    const options = setup();
    const held = tryAcquireHeavy(options, "gate");
    const timeout = cli(options, ["--exclusive", "--wait", "0.05", "--", "true"]);
    expect(timeout.status).toBe(75);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    expect(readHolder(heavyLockPath(options.home))?.command).toBe("gate");
    if (held.ok) held.release();
    const failed = cli(options, ["--exclusive", "--", "/no-such-heavy-command"]);
    expect(failed.status).toBe(127);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    for (const n of [0, 1]) expect(existsSync(slotPath(heavyLockPath(options.home), n))).toBe(false);
    expect(cli(options, ["--wait", "NaN", "--", "true"]).status).toBe(2);
  });
});
