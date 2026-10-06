import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readJobs } from "./heavy-lock.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimGateTmp } from "../bin/muster-heavy.ts";

const homes: string[] = [];
const flagg = { platform: "darwin" as const, name: "Flagg" };
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(body?: string) {
  const root = mkdtempSync(join(tmpdir(), "gate-tmp-test-"));
  homes.push(root);
  const ensure = join(root, "ensure");
  writeFileSync(ensure, `#!/bin/sh\n${body ?? `echo '${root}'`}\n`, { mode: 0o755 });
  return { root, ensure };
}

describe("gate-tmp sweep", () => {
  function sweep(ram: boolean) {
    const { root } = fixture();
    const volume = join(root, "volume");
    mkdirSync(volume);
    const dead = "run-99999999-dead";
    for (const name of [dead, "run-99999999", "run-not-a-pid-other", `run-${process.pid}-live`]) mkdirSync(join(volume, name));
    symlinkSync(root, join(volume, "run-99999999-link"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const [name, body] of Object.entries({ uname: "echo Darwin", hostname: "echo Flagg", mount: `echo '/dev/disk99 on ${volume} (hfs)'`, hdiutil: `printf 'image-path : ${ram ? "ram://123" : "/data/disk.dmg"}\\n/dev/disk99\\n'`, mdutil: "echo 'Indexing disabled'" })) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const script = join(root, "gate-tmp");
    writeFileSync(script, readFileSync("bin/gate-tmp", "utf8").replace('root=/Volumes/$volume_name', `root='${volume}'`));
    const result = spawnSync("sh", [script, "ensure"], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return { result, volume, dead };
  }
  it("sweeps only dead, matching, non-symlink direct children of a RAM mount", () => {
    const { result, volume, dead } = sweep(true);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(volume, dead))).toBe(false);
    expect(readdirSync(volume)).toEqual([`run-${process.pid}-live`, "run-99999999", "run-99999999-link", "run-not-a-pid-other"].sort());
  });
  it("refuses a data-backed root without deleting anything", () => {
    const { result, volume, dead } = sweep(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a RAM disk");
    expect(existsSync(join(volume, dead))).toBe(true);
  });
});

describe("claimGateTmp", () => {
  it("does nothing when off, non-darwin, or on another host, even with an explicit executable", () => {
    const warn = vi.spyOn(console, "error");
    expect(claimGateTmp("off", flagg)).toBeUndefined();
    expect(claimGateTmp("/missing", { platform: "linux", name: "pennywise" })).toBeUndefined();
    expect(claimGateTmp("/missing", { platform: "darwin", name: "blaine" })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
  it("warns once and falls back when ensure fails", () => {
    const { ensure } = fixture("echo unavailable >&2; exit 1");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(claimGateTmp(ensure, flagg)).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("unavailable"));
  });
  it("rejects malformed ensure output and preserves the inherited TMPDIR", () => {
    const { ensure } = fixture("printf '/one\\n/two\\n'");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(claimGateTmp(ensure, flagg)).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("one absolute root"));
  });
  it("releases only its own directory, idempotently", () => {
    const { root, ensure } = fixture();
    const sibling = join(root, "run-123-other");
    mkdirSync(sibling);
    const claim = claimGateTmp(ensure, { ...flagg, name: "Flagg.localdomain" });
    expect(claim).toBeDefined();
    expect(existsSync(claim!.dir)).toBe(true);
    claim!.release();
    claim!.release();
    expect(readdirSync(root)).toEqual(["ensure", "run-123-other"]);
  });
});

// These exercise the real register-and-run integration, not an invented host override.
// Other hosts still exercise claimGateTmp's no-op and sweep contract above.
describe.skipIf(platform() !== "darwin" || hostname().split(".")[0]?.toLowerCase() !== "flagg")("Flagg RAM job integration", () => {
  it.each([
    { command: "echo $TMPDIR; exit 0", exit: 0 },
    { command: "echo $TMPDIR; exit 7", exit: 7 },
    { command: "echo $TMPDIR; exec /missing/muster-command", exit: platform() === "darwin" ? 126 : 127 },
  ])("records and releases TMPDIR on exit $exit", ({ command, exit }) => {
    const { root, ensure } = fixture();
    const result = spawnSync(process.execPath, [resolve("bin/muster-heavy.ts"), "--wait", "0", "--", "sh", "-c", command], {
      encoding: "utf8", timeout: 20000, env: { ...process.env, HOME: root, MUSTER_HEAVY_GATE_TMP: ensure },
    });
    expect(result.status, result.stderr).toBe(exit);
    const job = readJobs(root)[0]!;
    expect(job).toMatchObject({ state: "finished", exit, tmpdir: result.stdout.trim().replace(/\/$/, "") });
    expect(job.tmpdir).toMatch(new RegExp(`/run-\\d+-`));
    expect(existsSync(job.tmpdir!)).toBe(false);
    expect(result.stderr).not.toContain("MUSTER_HEAVY_GATE_TMP");
  }, 25000);
  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)("releases TMPDIR after %s", async signal => {
    const { root, ensure } = fixture();
    const child = spawn(process.execPath, [resolve("bin/muster-heavy.ts"), "--", "sh", "-c", "echo $TMPDIR; sleep 20"], {
      env: { ...process.env, HOME: root, MUSTER_HEAVY_GATE_TMP: ensure }, stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    try {
      await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
    } finally { child.kill(signal); }
    expect(await closed).toBe(128);
    const job = readJobs(root)[0]!;
    expect(job).toMatchObject({ state: "finished", exit: 128 });
    expect(job.tmpdir).toBeDefined();
    expect(existsSync(job.tmpdir!)).toBe(false);
  }, 25000);
});
