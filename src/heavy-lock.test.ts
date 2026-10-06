import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  admissionReason, priorityRequest, deployCapMs, enqueueHeavy, heavyQueue, exclusiveCapMs, reapExclusive, exclusivePendingPath, exclusiveRequest, heavyLockPath, heavySlotCount, heavySnapshot, heavyStatus,
  parseMemInfo, parseVmStat, readHolder, slotPath, tryAcquire, tryAcquireHeavy,
} from "./heavy-lock.ts";
import * as heavy from "./heavy-lock.ts";
import type { HeavyAdapter, HeavyOptions } from "./heavy-lock.ts";

const homes: string[] = [];
const adapter: HeavyAdapter = { performanceCores: () => 12, sample: () => ({ cores: 16, load: 20, freeGB: 64 }) };
function setup(): HeavyOptions {
  const home = mkdtempSync(join(tmpdir(), "heavy-slots-test-"));
  homes.push(home);
  return { home, adapter, slots: "2", minFreeGB: "16", window: "test-deploy" };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("status --json contract", () => {
  it("keeps every field fleet-compute placement reads (ping the fleet desk before changing these)", () => {
    const options = setup();
    const held = tryAcquireHeavy(options, "contract");
    expect(held.ok).toBe(true);
    const snap = JSON.parse(JSON.stringify(heavySnapshot(options)));
    for (const key of ["slots", "load", "loadLimit", "availableGB", "minFreeGB"]) expect(typeof snap[key], key).toBe("number");
    expect(Array.isArray(snap.holders)).toBe(true);
    expect(snap).toHaveProperty("exclusivePending");
    const holder = snap.holders.find((slot: { held: boolean }) => slot.held);
    for (const key of ["name", "held", "holder", "ageSeconds", "stale"]) expect(holder, key).toHaveProperty(key);
    for (const key of ["pid", "host", "command", "startedAt", "mode"]) expect(holder.holder, key).toHaveProperty(key);
  });
});

// Node's preload changes only the test child's adapter, never real machine state.
function cli(options: HeavyOptions, args: string[], sampleCode = "({ cores: 16, load: 20, freeGB: 64 })", fakeClock = false, window: string | null = args.includes("--exclusive") ? "test-deploy" : null, extraPreload = "") {
  const source = `import { machineAdapter } from ${JSON.stringify(pathToFileURL(resolve("src/heavy-lock.ts")).href)}; let calls = 0; machineAdapter.performanceCores = () => 12; machineAdapter.sample = () => { calls++; return ${sampleCode}; }; ${fakeClock ? "let now = Date.now(); Date.now = () => now; const realTimer = globalThis.setTimeout; globalThis.setTimeout = (fn, ms) => { if (ms > 5000) return realTimer(fn, ms); now += ms; queueMicrotask(fn); };" : ""} ${extraPreload}`;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(source)}`, "bin/muster-heavy.ts", ...args], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, HOME: options.home, MUSTER_HEAVY_SLOTS: "2", MUSTER_HEAVY_MIN_FREE_GB: "16", MUSTER_DEPLOY_WINDOW: window ?? undefined, MUSTER_HEAVY_GRANT: options.grant },
  });
}

// A real process group is needed to prove descendant cleanup. Trigger the cap
// only after both processes exist and the descendant installed its handler;
// 300ms of wall time was not proof of readiness on a loaded machine.
function cappedGroup(options: HeavyOptions, exclusive: boolean) {
  const pidFile = join(options.home, "descendant.pid");
  const readyFile = join(options.home, "descendant.ready");
  const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 1000);`;
  const command = `const {spawn} = require('node:child_process'); const fs = require('node:fs'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  const source = `import {existsSync} from 'node:fs'; import {runHeavy} from ${JSON.stringify(pathToFileURL(resolve("bin/muster-heavy.ts")).href)}; await runHeavy(${JSON.stringify([...(exclusive ? ["--exclusive"] : []), "--", process.execPath, "-e", command])}, {home:${JSON.stringify(options.home)}, window:'cap-test', slots:'2', minFreeGB:'16', now:()=>0, adapter:{performanceCores:()=>12,sample:()=>({cores:16,load:${exclusive ? 20 : 45},freeGB:64})}, testOnlyCapMs:300}, {setTimeout:(fn, ms)=> { if (ms !== 300) return setTimeout(fn, ms === 15000 ? 50 : ms); const ready = () => existsSync(${JSON.stringify(pidFile)}) && existsSync(${JSON.stringify(readyFile)}) ? setTimeout(fn, 0) : setTimeout(ready, 1); return ready(); }, clearTimeout});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 10000, env: { ...process.env, HOME: options.home } });
  expect(existsSync(readyFile), result.stderr).toBe(true);
  return { result, pid: Number(readFileSync(pidFile, "utf8")) };
}

describe("desk heavy grants", () => {
  const audit = (options: HeavyOptions) => readFileSync(join(options.home, ".local/state/muster/heavy-exclusive.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  function desk() { return { ...setup(), window: undefined, now: () => Date.now() }; }

  it("creates, lists, revokes and clamps grant TTL with an injected clock", () => {
    const options = { ...desk(), now: () => 1_800_000_000_000 };
    const grant = heavy.createHeavyGrant(options, "test-gate", "9h", "desk");
    expect(grant.id).toMatch(/^[a-f0-9]{16}$/);
    expect(grant).toMatchObject({ label: "test-gate", grantedBy: "desk", cwd: process.cwd() });
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(7_200_000);
    expect(heavy.listHeavyGrants(options)).toEqual([grant]);
    heavy.revokeHeavyGrant(options, grant.id);
    expect(heavy.listHeavyGrants(options)).toEqual([]);
    expect(audit(options)).toMatchObject([{ mode: "grant", event: "granted", label: "test-gate", grantedBy: "desk" }, { mode: "grant", event: "revoked", label: "test-gate", grantedBy: "desk" }]);
    expect(heavy.grantTtlMs()).toBe(3_600_000);
    for (const ttl of ["0h", "-1m", "garbage"]) expect(() => heavy.grantTtlMs(ttl)).toThrow();
  });

  it("refuses a fifth machine-wide grant and lists all four live ones", () => {
    const options = desk();
    const grants = Array.from({ length: 4 }, (_, i) => heavy.createHeavyGrant(options, `gate-${i}`));
    expect(() => heavy.createHeavyGrant(options, "fifth")).toThrow(/four live grants/);
    const result = cli(options, ["grant", "fifth"]);
    expect(result.status, result.stderr).toBe(64);
    for (const grant of grants) expect(result.stderr).toContain(grant.id);
    expect(heavy.listHeavyGrants(options)).toHaveLength(4);
    expect(audit(options).at(-1)).toMatchObject({ mode: "grant", event: "refused", label: "fifth" });
  });

  it("offers create/list/revoke CLI commands with the default TTL", () => {
    const options = desk();
    const created = cli(options, ["grant", "gate"]);
    expect(created.status, created.stderr).toBe(0);
    const id = created.stdout.trim();
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    const listed = cli(options, ["grant", "--list"]);
    expect(listed.status).toBe(0);
    const [grant] = JSON.parse(listed.stdout);
    expect(grant.id).toBe(id);
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(3_600_000);
    expect(cli(options, ["grant", "--revoke", id]).status).toBe(0);
    expect(JSON.parse(cli(options, ["grant", "--list"]).stdout)).toEqual([]);
    expect(cli(options, ["grant", "bad", "--ttl", "0h"]).status).toBe(64);
  });

  it("admits ahead of three older ordinary waiters but behind a deploy waiter, FIFO within grants", () => {
    let clock = 1_800_000_000_000;
    // All tickets belong to this live test process. OS lstart probes are irrelevant
    // to ordering; arrival/release events, not wall time or probe speed, drive FIFO.
    const options: HeavyOptions = { ...desk(), slots: "1", now: () => clock, health: () => "alive" };
    const arrive = (owner: HeavyOptions, command: string, mode: "slot" | "grant" | "priority") => {
      clock++;
      return enqueueHeavy(owner, command, mode);
    };
    for (let i = 0; i < 3; i++) arrive(options, `ordinary-${i}`, "slot");
    const first = { ...options, grant: heavy.createHeavyGrant(options, "critical").id };
    const second = { ...options, grant: heavy.createHeavyGrant(options, "later").id };
    const firstTicket = arrive(first, "first grant", "grant");
    const secondTicket = arrive(second, "second grant", "grant");
    const deployOptions = { ...options, window: "deploy-test" };
    const deployTicket = arrive(deployOptions, "deploy", "priority");
    const firstRequest = heavy.grantRequest(first, "first grant", () => firstTicket.name);
    const secondRequest = heavy.grantRequest(second, "second grant", () => secondTicket.name);
    expect(firstRequest.attempt().ok).toBe(false);
    expect(secondRequest.attempt().ok).toBe(false);
    const deploy = priorityRequest(deployOptions, "deploy", () => deployTicket.name);
    expect(deploy.attempt()).toMatchObject({ ok: true, slot: "deploy-0" });
    expect(secondRequest.attempt().ok).toBe(false);
    expect(firstRequest.attempt()).toMatchObject({ ok: true, slot: "slot-0" });
    expect(readHolder(heavyLockPath(options.home))).toMatchObject({ mode: "grant", grant: { label: "critical" } });
    expect(tryAcquireHeavy(options, "ordinary").ok).toBe(false);
    firstRequest.release();
    expect(secondRequest.attempt()).toMatchObject({ ok: true, slot: "slot-0" });
    secondRequest.release();
    deploy.release();
    expect(heavyQueue(options).map((row) => row.command)).toEqual(["ordinary-0", "ordinary-1", "ordinary-2"]);
  });

  it("never takes deploy-0 or bypasses load/memory, even without a queue ticket", () => {
    const options = { ...desk(), slots: "1" };
    const granted = { ...options, grant: heavy.createHeavyGrant(options, "gate").id };
    const held = tryAcquireHeavy(options, "ordinary");
    const request = heavy.grantRequest(granted, "critical");
    expect(request.attempt().ok).toBe(false);
    expect(existsSync(`${heavyLockPath(options.home)}.deploy-0`)).toBe(false);
    if (held.ok) held.release();
    for (const sample of [{ cores: 16, load: 20, freeGB: 15 }]) {
      const pressure = heavy.grantRequest({ ...granted, adapter: { ...adapter, sample: () => sample } }, "pressure");
      expect(pressure.attempt()).toMatchObject({ ok: false, reason: expect.stringMatching(/load|memory/) });
      pressure.release();
    }
    expect(request.attempt()).toMatchObject({ ok: true, slot: "slot-0" });
    request.release();
  });

  it("reaps expiry on list/admission, refuses unknown or expired grants with exit 64, and keeps admitted work running", () => {
    let clock = Date.now();
    const options = { ...desk(), now: () => clock };
    const grant = heavy.createHeavyGrant(options, "gate", "1s", "desk");
    const granted = { ...options, grant: grant.id };
    const request = heavy.grantRequest(granted, "long gate");
    expect(request.attempt().ok).toBe(true);
    clock += 1000;
    expect(request.attempt().ok).toBe(true);
    expect(heavy.listHeavyGrants(options)).toEqual([]);
    expect(readHolder(heavyLockPath(options.home))?.mode).toBe("grant");
    request.release();
    const expiring = heavy.createHeavyGrant(options, "waiting", "1s");
    const waiting = heavy.grantRequest({ ...options, grant: expiring.id }, "waiting");
    clock += 1000;
    expect(() => waiting.attempt()).toThrow(/unknown or expired/);
    waiting.release();
    expect(existsSync(join(heavy.heavyGrantsPath(options.home), `${expiring.id}.json`))).toBe(false);
    for (const id of [grant.id, "../escape", "f".repeat(16)]) {
      const result = cli({ ...options, grant: id }, ["--", "true"]);
      expect(result.status, result.stderr).toBe(64);
      expect(result.stderr).toContain("unknown or expired heavy grant");
    }
    expect(audit(options).at(-1)).toMatchObject({ mode: "grant", event: "refused" });
  });

  it("prints grant labels on holders and queue entries, live count and lifecycle audit", () => {
    const options = desk();
    const grant = heavy.createHeavyGrant(options, "runtime-gate", "1h", "desk");
    const granted = { ...options, grant: grant.id };
    const ticket = enqueueHeavy(granted, "gate", "grant");
    expect(heavyStatus(options)).toContain("🎟️ grant runtime-gate");
    expect(heavyStatus(options)).toContain("grants: 1/4 live");
    const request = heavy.grantRequest(granted, "gate", () => ticket.name);
    expect(request.attempt().ok).toBe(true);
    expect(heavyStatus(options)).toContain("slot-0: 🎟️ grant runtime-gate");
    expect(heavySnapshot(options).grants).toEqual([grant]);
    expect(heavySnapshot(options).holders[0]?.holder).toMatchObject({ mode: "grant", grant });
    request.release();
    expect(audit(options).map((line) => line.event)).toEqual(["granted", "requested", "acquired", "released"]);
    for (const line of audit(options)) expect(line).toMatchObject({ mode: "grant", label: "runtime-gate", grantedBy: "desk" });
    expect(audit(options).find((line) => line.event === "acquired")).toMatchObject({ slot: "slot-0" });
  });

  it("runs a granted CLI job without a deploy hold cap and rejects window mixing", () => {
    const options = desk();
    const granted = { ...options, grant: heavy.createHeavyGrant(options, "cli-gate").id };
    const result = cli(granted, ["--", process.execPath, "-e", "process.exit(3)"], undefined, false, null, "globalThis.setTimeout = () => { throw new Error('grant must have no cap timer'); };");
    expect(result.status, result.stderr).toBe(3);
    expect(audit(options).map((line) => line.event)).toEqual(["granted", "requested", "acquired", "released"]);
    expect(cli(granted, ["--", "true"], undefined, false, "deploy").status).toBe(64);
    expect(cli(granted, ["--exclusive", "--", "true"]).status).toBe(64);
  });
});

describe("heavy FIFO queue", () => {
  function ticket(options: HeavyOptions, ms: number, pid = process.pid, extra = {}) {
    const dir = join(options.home, ".local/state/muster/heavy-queue");
    mkdirSync(dir, { recursive: true });
    const name = `${String(ms).padStart(16, "0")}-${pid}.json`;
    writeFileSync(join(dir, name), JSON.stringify({ pid, host: hostname(), startedAt: new Date().toISOString(), enqueuedAt: ms, command: `waiter-${ms}`, cwd: process.cwd(), mode: "slot", ...extra }), { flag: "wx" });
    return name;
  }

  it("admits three waiters FIFO even when the newest polls first", () => {
    const options = { ...setup(), slots: "1" };
    const names = [1, 2, 3].map((ms) => ticket(options, ms));
    for (let head = 0; head < names.length; head++) {
      for (let newer = 2; newer > head; newer--) expect(tryAcquireHeavy(options, "newer", names[newer]).ok).toBe(false);
      const result = tryAcquireHeavy(options, "head", names[head]);
      expect(result.ok).toBe(true);
      expect(existsSync(join(options.home, ".local/state/muster/heavy-queue", names[head]!))).toBe(false);
      if (result.ok) result.release();
    }
  });

  it("admits the two oldest with two free slots, but not a third or a no-ticket caller", () => {
    const options = setup();
    const names = [1, 2, 3].map((ms) => ticket(options, ms));
    expect(tryAcquireHeavy(options, "third", names[2]).ok).toBe(false);
    expect(tryAcquireHeavy(options, "no ticket").ok).toBe(false);
    const second = tryAcquireHeavy(options, "second", names[1]);
    const first = tryAcquireHeavy(options, "first", names[0]);
    expect(second.ok).toBe(true);
    expect(first.ok).toBe(true);
    if (first.ok) first.release();
    if (second.ok) second.release();
    const third = tryAcquireHeavy(options, "third", names[2]);
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
    const newest = tryAcquireHeavy(options, "empty queue");
    expect(newest.ok).toBe(true);
    if (newest.ok) newest.release();
  });

  it("a no-ticket caller defers to a live waiter on one slot", () => {
    const options = { ...setup(), slots: "1" };
    const name = ticket(options, 1);
    expect(tryAcquireHeavy(options, "packet_land gate")).toMatchObject({ ok: false, reason: expect.stringContaining("older waiters") });
    rmSync(join(options.home, ".local/state/muster/heavy-queue", name));
    const admitted = tryAcquireHeavy(options, "packet_land gate");
    expect(admitted.ok).toBe(true);
    if (admitted.ok) admitted.release();
  });

  it("exclusive drain waits behind older tickets, then fences all new admission", () => {
    const options = setup();
    const old = ticket(options, 1);
    const own = ticket(options, 2, process.pid, { mode: "exclusive" });
    const deploy = exclusiveRequest(options, "deploy", () => own);
    expect(deploy.attempt().ok).toBe(false);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    const first = tryAcquireHeavy(options, "old", old);
    expect(first.ok).toBe(true);
    expect(deploy.attempt().ok).toBe(false);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(true);
    expect(tryAcquireHeavy(options, "new").ok).toBe(false);
    if (first.ok) first.release();
    expect(deploy.attempt().ok).toBe(true);
    expect(existsSync(join(options.home, ".local/state/muster/heavy-queue", own))).toBe(false);
    deploy.release();
  });

  it("reaps dead and reused tickets but retains unknown foreign tickets", () => {
    const options = { ...setup(), slots: "1" };
    const dead = ticket(options, 1, 99999999);
    const reused = ticket(options, 2, process.pid, { startedAt: "2000-01-01T00:00:00.000Z" });
    const foreign = ticket(options, 3, process.pid, { host: "foreign.invalid" });
    expect(tryAcquireHeavy(options, "gate").ok).toBe(false);
    const dir = join(options.home, ".local/state/muster/heavy-queue");
    expect(existsSync(join(dir, dead))).toBe(false);
    expect(existsSync(join(dir, reused))).toBe(false);
    expect(existsSync(join(dir, foreign))).toBe(true);
    expect(heavyStatus(options)).toContain("unknown");
  });

  it("status lists queue position, age and command without reaping", () => {
    const options = setup();
    ticket(options, 1000, 99999999);
    ticket(options, 2000);
    expect(heavySnapshot(options, 253000)).toMatchObject({ queue: [
      { position: 1, pid: 99999999, health: "dead", ageSeconds: 252, command: "waiter-1000" },
      { position: 2, pid: process.pid, health: "alive", ageSeconds: 251, command: "waiter-2000" },
    ] });
    expect(heavyStatus(options, 253000)).toContain("position 1: pid 99999999; dead; wait 4m12s; waiter-1000");
    expect(JSON.parse(cli(options, ["status", "--json"]).stdout).queue).toHaveLength(2);
    expect(readdirSync(join(options.home, ".local/state/muster/heavy-queue"))).toHaveLength(2);
  });

  it("polls the head at 1s and distant waiters at 5s using injected timers", () => {
    const preload = `import { readFileSync, readdirSync } from 'node:fs'; import { join } from 'node:path'; const timer = globalThis.setTimeout; globalThis.setTimeout = (fn, ms) => { const dir = join(process.env.HOME, '.local/state/muster/heavy-queue'); const files = readdirSync(dir); const ticket = JSON.parse(readFileSync(join(dir, files.at(-1)), 'utf8')); console.error('TICKET:' + JSON.stringify(ticket)); console.error('POLL:' + ms); return timer(fn, ms); };`;
    for (const older of [0, 2]) {
      const options = setup();
      for (let n = 0; n < older; n++) ticket(options, n + 1);
      const result = cli(options, ["--wait", "6", "--", "true", "x".repeat(300)], "({ cores: 16, load: 20, freeGB: 15 })", true, null, preload);
      expect(result.status).toBe(75);
      expect(result.stderr).toContain(`POLL:${older === 0 ? 1000 : 5000}`);
      const payload = JSON.parse(result.stderr.split('\n').find((line) => line.startsWith('TICKET:'))!.slice(7));
      expect(payload).toMatchObject({ host: hostname(), cwd: process.cwd(), mode: "slot" });
      expect(payload.command).toHaveLength(200);
      expect(Number.isFinite(Date.parse(payload.startedAt))).toBe(true);
      expect(typeof payload.enqueuedAt).toBe("number");
      expect(readdirSync(join(options.home, ".local/state/muster/heavy-queue"))).toHaveLength(older);
    }
  });

  it("a --wait 0 refusal never creates a ticket", () => {
    const options = setup();
    expect(cli(options, ["--wait", "0", "--", "true"], "({ cores: 16, load: 20, freeGB: 15 })").status).toBe(75);
    expect(existsSync(join(options.home, ".local/state/muster/heavy-queue"))).toBe(false);
  });

  it.each([false, true])("CLI tickets clean up on acquire, timeout and signal (exclusive=%s)", (exclusive) => {
    const options = setup();
    const flags = exclusive ? ["--exclusive"] : [];
    const dir = join(options.home, ".local/state/muster/heavy-queue");
    const success = cli(options, [...flags, "--wait", "2", "--", "true"], "calls === 1 ? { cores: 16, load: 20, freeGB: 15 } : { cores: 16, load: 20, freeGB: 64 }", true);
    expect(success.status, success.stderr).toBe(0);
    expect(success.stderr).toContain("waiting: position 1 of 1");
    expect(readdirSync(dir)).toEqual([]);
    const timeout = cli(options, [...flags, "--wait", "1", "--", "true"], "({ cores: 16, load: 20, freeGB: 15 })", true);
    expect(timeout.status).toBe(75);
    expect(readdirSync(dir)).toEqual([]);
    const signal = cli(options, [...flags, "--wait", "10", "--", "true"], "({ cores: 16, load: 20, freeGB: 15 })", false, exclusive ? "test-deploy" : null, "const realTimer = globalThis.setTimeout; globalThis.setTimeout = (fn, ms) => realTimer(() => process.emit('SIGTERM'), 0);");
    expect(signal.status).toBe(128);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("reserved deploy slot", () => {
  const path = (options: HeavyOptions) => `${heavyLockPath(options.home)}.deploy-0`;

  it("admits a deploy immediately with all four normal slots held, never an ordinary gate", () => {
    const options = { ...setup(), slots: "4" };
    const gates = Array.from({ length: 4 }, (_, n) => tryAcquireHeavy(options, `gate ${n}`));
    expect(gates.every((gate) => gate.ok)).toBe(true);
    expect(tryAcquireHeavy(options, "ordinary overflow").ok).toBe(false);
    expect(existsSync(path(options))).toBe(false);
    const request = priorityRequest(options, "deploy");
    expect(request.attempt()).toMatchObject({ ok: true, slot: "deploy-0" });
    expect(readHolder(path(options))).toMatchObject({ mode: "priority", window: "test-deploy" });
    request.release();
    for (const gate of gates) if (gate.ok) gate.release();
  });

  it("keeps a second priority request waiting despite free normal slots, then ahead of ordinary tickets", () => {
    const options = { ...setup(), slots: "1" };
    const first = priorityRequest(options, "first");
    expect(first.attempt().ok).toBe(true);
    const ordinary = enqueueHeavy({ ...options, now: () => 1 }, "ordinary", "slot");
    const own = enqueueHeavy({ ...options, now: () => 2 }, "second", "priority");
    const second = priorityRequest(options, "second", () => own.name);
    expect(second.attempt()).toMatchObject({ ok: false, reason: "priority window already held" });
    first.release();
    expect(second.attempt()).toMatchObject({ ok: true, slot: "deploy-0" });
    second.release(); ordinary.release();
  });

  it("falls back to a normal slot ahead of ordinary waiters when the reserved slot is unknown", () => {
    const options = { ...setup(), slots: "1" };
    mkdirSync(path(options), { recursive: true });
    const older = enqueueHeavy({ ...options, now: () => 1 }, "ordinary", "slot");
    const request = priorityRequest(options, "fallback");
    expect(request.attempt()).toMatchObject({ ok: true, slot: "slot-0" });
    const audit = readFileSync(join(options.home, ".local/state/muster/heavy-exclusive.jsonl"), "utf8");
    expect(audit).toContain('"slot":"slot-0"');
    request.release(); older.release();
  });

  it("exclusive drains an active deploy, then holds and blocks deploy-0", () => {
    const options = setup();
    const deploy = priorityRequest(options, "active deploy");
    expect(deploy.attempt().ok).toBe(true);
    const exclusive = exclusiveRequest(options, "exclusive");
    expect(exclusive.attempt()).toMatchObject({ ok: false, reason: expect.stringContaining("deploy-0") });
    const next = priorityRequest(options, "next deploy");
    expect(next.attempt().ok).toBe(false);
    deploy.release();
    expect(exclusive.attempt().ok).toBe(true);
    expect(readHolder(path(options))?.command).toBe("exclusive");
    expect(next.attempt().ok).toBe(false);
    exclusive.release();
    expect(existsSync(path(options))).toBe(false);
    expect(next.attempt().ok).toBe(true);
    next.release();
  });

  it("refuses deploy-0 under memory pressure", () => {
    const options = { ...setup(), adapter: { ...adapter, sample: () => ({ cores: 16, load: 99, freeGB: 15 }) } };
    const request = priorityRequest(options, "low-memory deploy");
    expect(request.attempt()).toMatchObject({ ok: false, reason: expect.stringContaining("available memory") });
    expect(existsSync(path(options))).toBe(false);
    request.release();
  });

  it("explicit reaper frees a dead deploy-0 without waiting for its cap", () => {
    const options = setup();
    const request = priorityRequest(options, "dead deploy");
    expect(request.attempt().ok).toBe(true);
    writeFileSync(join(path(options), "holder.json"), JSON.stringify({ ...readHolder(path(options)), pid: 99999999 }));
    expect(heavySnapshot(options).deploySlot).toMatchObject({ held: true, health: "dead" });
    reapExclusive(options);
    expect(existsSync(path(options))).toBe(false);
    request.release();
  });

  it("reports the reserved slot and its remaining seconds in text and JSON", () => {
    const now = Date.now();
    const options = { ...setup(), slots: "4", now: () => now };
    expect(heavyStatus(options)).toContain("heavy slots: 4 + 1 deploy");
    expect(heavyStatus(options)).toContain("deploy-0: free");
    const request = priorityRequest(options, "deploy");
    expect(request.attempt().ok).toBe(true);
    expect(heavyStatus(options, now + 2000)).toContain("deploy-0: ⚡ window test-deploy");
    expect(heavyStatus(options, now + 2000)).toContain("left 298s");
    expect(JSON.parse(cli(options, ["status", "--json"]).stdout).deploySlot).toMatchObject({ name: "deploy-0", held: true, window: "test-deploy" });
    request.release();
  });
});

describe("priority deploy windows", () => {
  const events = (home: string) => readFileSync(join(home, ".local/state/muster/heavy-exclusive.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

  it("jumps three older ordinary waiters without draining or fencing slots", () => {
    const options = { ...setup(), now: () => Date.now() - 10000 };
    const gate = tryAcquireHeavy(options, "running gate");
    const older = [1, 2, 3].map((n) => enqueueHeavy(options, `ordinary ${n}`, "slot"));
    const own = enqueueHeavy({ ...options, now: Date.now }, "deploy", "priority");
    expect(heavyQueue(options).map((row) => row.name)).toEqual([own.name, ...older.map((row) => row.name)]);
    const deploy = priorityRequest(options, "deploy", () => own.name);
    expect(deploy.attempt().ok).toBe(true);
    expect(readHolder(heavyLockPath(options.home))?.command).toBe("running gate");
    expect(readHolder(`${heavyLockPath(options.home)}.deploy-0`)?.mode).toBe("priority");
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    deploy.release();
    if (gate.ok) gate.release();
    for (const row of older) row.release();
  });

  it("serializes priority requests FIFO while an ordinary job can use another slot", () => {
    const options = { ...setup(), slots: "3" };
    const first = enqueueHeavy({ ...options, now: () => 1 }, "first", "priority");
    const second = enqueueHeavy({ ...options, now: () => 2 }, "second", "priority");
    const a = priorityRequest(options, "first", () => first.name);
    const b = priorityRequest(options, "second", () => second.name);
    expect(b.attempt().ok).toBe(false);
    expect(a.attempt().ok).toBe(true);
    expect(b.attempt().ok).toBe(false);
    const gate = tryAcquireHeavy(options, "ordinary");
    expect(gate.ok).toBe(true);
    a.release();
    expect(b.attempt().ok).toBe(true);
    b.release();
    if (gate.ok) gate.release();
  });

  it("bypasses load-only pressure but retains memory and invalid-sample refusal", () => {
    for (const [sample, ok] of [
      [{ cores: 16, load: 45, freeGB: 64 }, true],
      [{ cores: 16, load: 45, freeGB: 15 }, false],
      [{ cores: 16, load: NaN, freeGB: 64 }, false],
    ] as const) {
      const options = { ...setup(), adapter: { ...adapter, sample: () => sample } };
      const request = priorityRequest(options, "deploy");
      expect(request.attempt().ok).toBe(ok);
      request.release();
    }
    const options = setup();
    expect(cli(options, ["--", "true"], "({ cores:16, load:45, freeGB:64 })", false, "load-window").status).toBe(0);
  });

  it.each(["", "bad window", "x".repeat(65), "../window", "ok\n"])("refuses and audits invalid priority window %j", (window) => {
    const options = setup();
    const result = cli(options, ["--", "true"], undefined, false, window);
    expect(result.status).toBe(64);
    expect(events(options.home)).toMatchObject([{ event: "refused", mode: "priority", window }]);
    expect(existsSync(heavyLockPath(options.home))).toBe(false);
    expect(existsSync(join(options.home, ".local/state/muster/heavy-queue"))).toBe(false);
  });

  it("CLI writes a priority ticket on refusal, jumps older gates and cleans up after acquisition", () => {
    const options = { ...setup(), now: () => Date.now() - 10000 };
    const older = [1, 2, 3].map((n) => enqueueHeavy(options, `ordinary ${n}`, "slot"));
    const preload = `import {readFileSync, readdirSync} from 'node:fs'; import {join} from 'node:path'; const timer = globalThis.setTimeout; globalThis.setTimeout = (fn, ms) => { const dir = join(process.env.HOME, '.local/state/muster/heavy-queue'); for (const name of readdirSync(dir)) { const ticket = JSON.parse(readFileSync(join(dir, name), 'utf8')); if (ticket.mode === 'priority') console.error('PRIORITY:' + JSON.stringify(ticket)); } return timer(fn, ms); };`;
    const result = cli(options, ["--wait", "2", "--", "true"], "calls === 1 ? {cores:16, load:45, freeGB:15} : {cores:16, load:45, freeGB:64}", true, "cli-window", preload);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("waiting: position 1 of 4");
    const payload = JSON.parse(result.stderr.split("\n").find((line) => line.startsWith("PRIORITY:"))!.slice(9));
    expect(payload).toMatchObject({ mode: "priority", window: "cli-window", cwd: process.cwd(), host: hostname() });
    expect(heavyQueue(options).map((row) => row.name)).toEqual(older.map((row) => row.name));
    expect(events(options.home).map((entry) => entry.event)).toEqual(["requested", "acquired", "released"]);
    expect(events(options.home).every((entry) => entry.mode === "priority")).toBe(true);
    expect(existsSync(heavyLockPath(options.home))).toBe(false);
  });

  it("cannot raise the five minute cap through the environment", () => {
    for (const [value, minutes] of [[undefined, 5], ["999", 5], ["Infinity", 5], ["NaN", 5], ["-3", 1], ["0", 1], ["2", 2]] as const) {
      expect(deployCapMs({ MUSTER_DEPLOY_CAP_MIN: value })).toBe(minutes * 60000);
    }
  });

  it("shows priority tickets and holders with window, age and remaining cap", () => {
    const now = Date.now();
    const options = { ...setup(), now: () => now };
    const request = priorityRequest(options, "deploy");
    expect(request.attempt().ok).toBe(true);
    const own = enqueueHeavy(options, "waiting deploy", "priority");
    const status = heavyStatus(options, now + 2000);
    expect(status).toContain("⚡ window test-deploy");
    expect(status).toContain("left 298s");
    expect(status).toContain("wait 0m02s; ⚡ window test-deploy");
    request.release(); own.release();
  });

  it("reaps stale priority holds at cap plus two minutes, not before, and preserves other slots", () => {
    const now = Date.now();
    const options = { ...setup(), now: () => now };
    const gate = tryAcquireHeavy(options, "ordinary");
    const request = priorityRequest(options, "stale deploy");
    expect(request.attempt().ok).toBe(true);
    const path = `${heavyLockPath(options.home)}.deploy-0`;
    writeFileSync(join(path, "holder.json"), JSON.stringify({ ...readHolder(path), pid: 1234567 }));
    const signals: [number, NodeJS.Signals][] = [];
    const reaper = { ...options, health: () => "alive" as const, kill: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); } };
    reapExclusive({ ...reaper, now: () => now + 420000 });
    expect(existsSync(path)).toBe(true);
    expect(heavySnapshot(options, now + 420001).deploySlot.remainingSeconds).toBe(0);
    reapExclusive({ ...reaper, now: () => now + 420001 });
    expect(signals).toEqual([[1234567, "SIGTERM"], [1234567, "SIGKILL"]]);
    expect(existsSync(path)).toBe(false);
    expect(readHolder(heavyLockPath(options.home))?.command).toBe("ordinary");
    expect(events(options.home).at(-1)).toMatchObject({ event: "reaped", mode: "priority" });
    request.release(); if (gate.ok) gate.release();
  });

  it("caps the detached child group, frees its slot and exits 124", () => {
    const options = setup();
    const { result, pid } = cappedGroup(options, false);
    expect(result.status, result.stderr).toBe(124);
    expect(result.stderr).toContain("CAPPED priority window cap-test");
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* Our child has been reaped. */ }
    expect(alive).toBe(false);
    expect(events(options.home).map((entry) => entry.event)).toEqual(["requested", "acquired", "capped", "released"]);
    expect(events(options.home).every((entry) => entry.mode === "priority" && entry.ppid > 0)).toBe(true);
    expect(events(options.home).find((entry) => entry.event === "acquired")).toMatchObject({ slot: "deploy-0" });
    expect(existsSync(`${heavyLockPath(options.home)}.deploy-0`)).toBe(false);
    expect(existsSync(heavyLockPath(options.home))).toBe(false);
  });
});

describe("exclusive deploy policy", () => {
  const events = (home: string) => readFileSync(join(home, ".local/state/muster/heavy-exclusive.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

  it.each([null, "", "bad window", "x".repeat(65), "../window", "ok\n"])("CLI refuses window %j without a lock", (window) => {
    const options = setup();
    const result = cli(options, ["--exclusive", "--", "true"], undefined, false, window);
    expect(result.status).toBe(64);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/MUSTER_DEPLOY_WINDOW.*deploy-only/);
    expect(events(options.home)).toMatchObject([{ event: "refused", window: window ?? null }]);
    expect(existsSync(heavyLockPath(options.home))).toBe(false);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
  });

  it("library refuses an omitted window even with environment authorization", () => {
    const options = setup();
    expect(() => exclusiveRequest({ ...options, window: undefined }, "gate")).toThrow(/MUSTER_DEPLOY_WINDOW/);
    expect(events(options.home)).toMatchObject([{ event: "refused" }]);
    expect(existsSync(heavyLockPath(options.home))).toBe(false);
  });

  it("logs requested, acquired and released with bounded context", () => {
    const options = setup();
    expect(cli(options, ["--exclusive", "--", "true"]).status).toBe(0);
    const log = events(options.home);
    expect(log.map((entry) => entry.event)).toEqual(["requested", "acquired", "released"]);
    for (const entry of log) {
      expect(entry).toMatchObject({ window: "test-deploy", cwd: process.cwd(), command: "true" });
      expect(entry.pid).toBeGreaterThan(0);
      expect(entry.ppid).toBeGreaterThan(0);
      expect(entry.parentCommand.length).toBeLessThanOrEqual(200);
      expect(Number.isFinite(Date.parse(entry.ts))).toBe(true);
    }
  });

  it("clamps environmental cap to 1-20 minutes", () => {
    for (const [value, minutes] of [[undefined, 20], ["999", 20], ["Infinity", 20], ["NaN", 20], ["-3", 1], ["0", 1], ["5", 5]] as const) {
      expect(exclusiveCapMs({ MUSTER_EXCLUSIVE_CAP_MIN: value })).toBe(minutes * 60000);
    }
  });

  it.each(["legacy", "pending"])("slot admission reaps an overdue %s hold and signals only injected pids", (kind) => {
    const options = setup();
    const request = exclusiveRequest(options, "stale deploy");
    expect(request.attempt().ok).toBe(true);
    const paths = [exclusivePendingPath(options.home), ...[0, 1].map((n) => slotPath(heavyLockPath(options.home), n))];
    const now = Date.now();
    for (const path of paths) {
      const holder = readHolder(path)!;
      writeFileSync(join(path, "holder.json"), JSON.stringify({ ...holder, pid: 1234567, startedAt: new Date(now - 24 * 60000).toISOString(), exclusiveAcquiredAt: new Date(now - 23 * 60000).toISOString() }));
    }
    if (kind === "pending") rmSync(heavyLockPath(options.home), { recursive: true });
    const signals: [number, NodeJS.Signals][] = [];
    const reaperOptions: HeavyOptions = { ...options, now: () => now, health: () => "alive", kill: (pid, signal) => { signals.push([pid, signal]); } };
    // Both status variants leave even overdue locks untouched.
    expect(heavyStatus(reaperOptions)).toContain("test-deploy");
    expect(heavySnapshot(reaperOptions).exclusivePending.remainingSeconds).toBe(0);
    expect(signals).toEqual([]);
    const acquired = tryAcquireHeavy(reaperOptions, "next slot");
    expect(acquired.ok).toBe(true);
    expect(signals).toEqual([[1234567, "SIGTERM"], [1234567, "SIGKILL"]]);
    expect(events(options.home).filter((entry) => entry.event === "reaped")).toMatchObject([{ window: "test-deploy", pid: 1234567 }]);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
    expect(existsSync(slotPath(heavyLockPath(options.home), 1))).toBe(false);
    if (acquired.ok) acquired.release();
    request.release();
  });

  it("status --reap reclaims an old legacy hold, while plain status leaves it", () => {
    const options = setup();
    const lock = heavyLockPath(options.home);
    tryAcquire(lock, "legacy deploy", 99999999, "exclusive");
    writeFileSync(join(lock, "holder.json"), JSON.stringify({ ...readHolder(lock), startedAt: "2000-01-01T00:00:00.000Z" }));
    expect(cli(options, ["status", "--json"]).status).toBe(0);
    expect(existsSync(lock)).toBe(true);
    const result = cli(options, ["status", "--reap", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("REAPED exclusive window legacy");
    expect(JSON.parse(result.stdout).holders[0].held).toBe(false);
    expect(events(options.home).map((entry) => entry.event)).toEqual(["reaped"]);
  });

  it("does not reap a waiting request, a foreign holder or an in-cap hold", () => {
    const options = setup();
    const hold = tryAcquireHeavy(options, "busy");
    const request = exclusiveRequest(options, "waiting");
    request.attempt();
    const signals: number[] = [];
    reapExclusive({ ...options, now: () => Date.now() + 30 * 60000, kill: (pid) => { signals.push(pid); } });
    expect(existsSync(exclusivePendingPath(options.home))).toBe(true);
    if (hold.ok) hold.release();
    expect(request.attempt().ok).toBe(true);
    reapExclusive({ ...options, now: () => Date.now() + 21 * 60000, kill: (pid) => { signals.push(pid); } });
    expect(signals).toEqual([]);
    for (const path of [exclusivePendingPath(options.home), heavyLockPath(options.home), `${heavyLockPath(options.home)}.deploy-0`]) {
      writeFileSync(join(path, "holder.json"), JSON.stringify({ ...readHolder(path), host: "foreign.example" }));
    }
    reapExclusive({ ...options, now: () => Date.now() + 30 * 60000, health: () => "alive", kill: (pid) => { signals.push(pid); } });
    expect(signals).toEqual([]);
    expect(existsSync(heavyLockPath(options.home))).toBe(true);
    request.release();
  });

  it("CLI caps and kills the whole group even after its leader exits", () => {
    const options = setup();
    const { result, pid } = cappedGroup(options, true);
    // The child is ours. Probe only; no foreign processes are signalled.
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* Reaped by init. */ }
    expect(alive).toBe(false);
    expect(result.status, result.stderr).toBe(124);
    expect(result.stderr).toContain("CAPPED exclusive window cap-test");
    expect(events(options.home).map((entry) => entry.event)).toEqual(["requested", "acquired", "capped", "released"]);
    for (const path of [exclusivePendingPath(options.home), ...[0, 1].map((n) => slotPath(heavyLockPath(options.home), n))]) expect(existsSync(path)).toBe(false);
  });

  it("starts the hold clock only after drain and shows the window and remaining cap", () => {
    let now = Date.now();
    const options = { ...setup(), now: () => now };
    const slot = tryAcquireHeavy(options, "busy");
    const other = tryAcquireHeavy(options, "other busy");
    const request = exclusiveRequest(options, "deploy");
    expect(request.attempt().ok).toBe(false);
    if (slot.ok) slot.release();
    expect(request.attempt().ok).toBe(false);
    now += 30 * 60000;
    const signals: number[] = [];
    reapExclusive({ ...options, kill: (pid) => { signals.push(pid); } });
    expect(signals).toEqual([]);
    expect(heavySnapshot(options, now).exclusivePending).toMatchObject({ window: "test-deploy", remainingSeconds: 1200 });
    expect(heavySnapshot(options, now).holders[0]).toMatchObject({ window: "test-deploy", remainingSeconds: 1200, exclusiveAgeSeconds: null });
    expect(readHolder(exclusivePendingPath(options.home))?.exclusiveAcquiredAt).toBeUndefined();
    if (other.ok) other.release();
    expect(request.attempt().ok).toBe(true);
    const acquired = readHolder(exclusivePendingPath(options.home))!.exclusiveAcquiredAt!;
    expect(heavySnapshot(options, Date.parse(acquired) + 10000).exclusivePending).toMatchObject({ window: "test-deploy", remainingSeconds: 1190, exclusiveAgeSeconds: 10 });
    expect(heavyStatus(options, Date.parse(acquired) + 10000)).toContain("window test-deploy; hold age 10s; cap remaining 1190s");
    request.release();
  });
});

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

  it.each(["slot", "exclusive"].flatMap((mode) => ["dead", "reused", "variant"].map((kind) => ({ mode, kind }))))("reaps $kind pending holders for $mode admission", ({ mode, kind }) => {
    const options = setup();
    const pending = exclusivePendingPath(options.home);
    tryAcquire(pending, "orphan", kind === "reused" ? process.pid : 999_999_99);
    const holder = readHolder(pending)!;
    writeFileSync(join(pending, "holder.json"), JSON.stringify({
      ...holder,
      startedAt: kind === "reused" ? "2000-01-01T00:00:00.000Z" : holder.startedAt,
      host: kind === "variant" ? `${hostname().replace(/\.(local|localdomain)$/i, "")}.LOCAL` : holder.host,
    }));
    const request = mode === "exclusive" ? exclusiveRequest(options, "new gate") : undefined;
    const acquired = request ? request.attempt() : tryAcquireHeavy(options, "new gate");
    expect(acquired.ok, kind).toBe(true);
    if (mode === "slot") expect(existsSync(pending)).toBe(false);
    else expect(readHolder(pending)?.command).toBe("new gate");
    if (acquired.ok) acquired.release();
    request?.release();
  });

  it("preserves foreign and unreadable pending holders", () => {
    for (const foreign of [true, false]) {
      const options = setup();
      const pending = exclusivePendingPath(options.home);
      tryAcquire(pending, "orphan", 999_999_99);
      const original = readHolder(pending)!;
      const json = JSON.stringify(foreign ? { ...original, host: `${hostname()}.foreign.example` } : {});
      writeFileSync(join(pending, "holder.json"), json);
      expect(heavySnapshot(options).exclusivePending).toMatchObject({ health: "unknown", stale: false });
      expect(tryAcquireHeavy(options, "slot").ok).toBe(false);
      const request = exclusiveRequest(options, "deploy");
      expect(request.attempt().ok).toBe(false);
      request.release();
      expect(readFileSync(join(pending, "holder.json"), "utf8")).toBe(json);
    }
  });

  it("labels alive, dead and reused holders with age without reaping", () => {
    const options = setup();
    const pending = exclusivePendingPath(options.home);
    const now = Date.now();
    tryAcquire(pending, "waiting deploy");
    const original = readHolder(pending)!;
    writeFileSync(join(pending, "holder.json"), JSON.stringify({ ...original, startedAt: new Date(now).toISOString() }));
    expect(heavySnapshot(options, now + 3000).exclusivePending).toMatchObject({ health: "alive", ageSeconds: 3, stale: false });
    const blocked = tryAcquireHeavy(options, "new gate");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/alive; age \d+s/);
    writeFileSync(join(pending, "holder.json"), JSON.stringify({ ...original, startedAt: "2000-01-01T00:00:00.000Z" }));
    expect(heavySnapshot(options, now).exclusivePending).toMatchObject({ health: "reused", stale: true });
    expect(heavyStatus(options, now)).toContain("reused; age");
    expect(JSON.parse(cli(options, ["status", "--json"]).stdout).exclusivePending).toMatchObject({ health: "reused", stale: true });
    writeFileSync(join(pending, "holder.json"), JSON.stringify({ ...original, pid: 999_999_99 }));
    expect(heavySnapshot(options, now).exclusivePending).toMatchObject({ health: "dead", stale: true });
    expect(heavyStatus(options, now)).toContain("dead; age");
    expect(existsSync(pending)).toBe(true);
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
    expect(status).toContain("dead; age 2s; stale");
    expect(status).toContain("exclusive-pending: pid 99999999");
    expect(status).toContain("load: 20.0");
    expect(status).toContain("available memory: 64.0 GB");
    expect(readFileSync(join(slotPath(lock, 1), "holder.json"), "utf8")).toBe(before);
    expect(existsSync(exclusivePendingPath(options.home))).toBe(true);
    const empty = setup();
    expect(cli(empty, ["status"]).stdout).toContain("slot-1: free");
    expect(existsSync(join(empty.home, ".local"))).toBe(false);
    const snap = heavySnapshot(options, Date.now() + 2000);
    expect(snap).toMatchObject({ slots: 2, load: 20, availableGB: 64 });
    expect(snap.holders[0]).toMatchObject({ name: "slot-0", held: false, holder: null });
    expect(snap.holders[1]).toMatchObject({ name: "slot-1", held: true, stale: true, ageSeconds: 2, holder: { command: "dead gate", mode: "slot" } });
    expect(snap.exclusivePending).toMatchObject({ held: true, holder: { command: "dead hold" } });
    expect(JSON.parse(cli(empty, ["status", "--json"]).stdout)).toMatchObject({ holders: [{ held: false }, { held: false }], exclusivePending: { held: false } });
    expect(readFileSync(join(slotPath(lock, 1), "holder.json"), "utf8")).toBe(before);
  });
});

describe("machine pressure admission", () => {
  it("parses reclaimable macOS pages and Linux MemAvailable", () => {
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\nPages inactive: 65536.\nPages speculative: 65536.')).toBe(3);
    expect(parseMemInfo("MemFree: 1 kB\nMemAvailable: 16777216 kB\n")).toBe(16);
    expect(() => parseVmStat("bad")).toThrow();
    expect(() => parseMemInfo("MemFree: 20 kB")).toThrow();
  });

  it("admits high load and refuses low memory without creating slots", () => {
    const busy = tryAcquireHeavy({ ...setup(), adapter: { ...adapter, sample: () => ({ cores: 16, load: 99, freeGB: 64 }) } }, "gate");
    expect(busy.ok).toBe(true);
    if (busy.ok) busy.release();
    for (const sample of [{ cores: 16, load: 20, freeGB: 15 }]) {
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

  it("does not reserve an exclusive fence under pressure; slots can run when pressure clears", () => {
    for (const sample of [{ cores: 16, load: 20, freeGB: 15 }]) {
      const options = setup();
      let current = sample;
      const pressured = { ...options, adapter: { ...adapter, sample: () => current } };
      const request = exclusiveRequest(pressured, "deploy");
      // Reaping happens even when pressure prevents reservation.
      tryAcquire(exclusivePendingPath(options.home), "dead waiter", 999_999_99);
      expect(request.attempt().ok).toBe(false);
      expect(existsSync(exclusivePendingPath(options.home))).toBe(false);
      expect(existsSync(heavyLockPath(options.home))).toBe(false);
      current = { cores: 16, load: 20, freeGB: 64 };
      const slot = tryAcquireHeavy(pressured, "ordinary gate");
      expect(slot.ok).toBe(true);
      expect(request.attempt().ok).toBe(false);
      expect(readHolder(exclusivePendingPath(options.home))?.command).toBe("deploy");
      if (slot.ok) slot.release();
      expect(request.attempt().ok).toBe(true);
      request.release();
    }
  });

  it("CLI waits and prints why under fake low memory, then starts", () => {
    for (const pressure of ["{ cores: 16, load: 20, freeGB: 15 }"]) {
      for (const flags of [[], ["--exclusive"]]) {
        const options = setup();
        const result = cli(options, [...flags, "--wait", "0.05", "--", process.execPath, "-e", "console.log('started')"], `calls === 1 ? ${pressure} : { cores: 16, load: 20, freeGB: 64 }`, true);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toMatch(/waiting: position 1 of 1, .*; available memory/);
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
    const timeout = cli(options, ["--exclusive", "--wait", "0.05", "--", "true"], undefined, true);
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
