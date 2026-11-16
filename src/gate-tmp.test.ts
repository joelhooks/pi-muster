import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readJobs } from "./heavy-lock.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimGateTmp, gateEnv, opShim } from "../bin/muster-heavy.ts";

const homes: string[] = [];
const flagg = { platform: "darwin" as const, name: "Flagg" };
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(body?: string) {
  const root = mkdtempSync(join(tmpdir(), "gate-tmp-test-"));
  homes.push(root);
  const ensure = join(root, "ensure");
  const fake = `case "$1" in claim) mktemp -d '${root}'/run-"$2"-XXXXXX ;; release) rm -r "$2" ;; esac`;
  writeFileSync(ensure, `#!/bin/sh\n${body ?? fake}\n`, { mode: 0o755 });
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
    const result = spawnSync("sh", [script, "ensure"], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GATE_TMP_LOCK: join(root, "lock"), GATE_TMP_LOG: join(root, "log") } });
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

// Switchboard, 2026-10-18: the RAM disk held 16 GB for 3.7 days while using 158 MB; its pages are never freed until detach.
describe("gate-tmp claim and release", () => {
  function disk(options: { mounted?: boolean; busy?: boolean; holders?: string; runHolders?: string; fs?: string; volumeDev?: string } = {}) {
    const { root } = fixture();
    const volume = join(root, "volume");
    mkdirSync(volume);
    const state = join(root, "mounted");
    if (options.mounted !== false) writeFileSync(state, "");
    const fsFile = join(root, "fs");
    writeFileSync(fsFile, options.fs ?? "apfs");
    const volumeDev = options.volumeDev ?? "/dev/disk99";
    const calls = join(root, "calls");
    const bin = join(root, "bin");
    mkdirSync(bin);
    const tools: Record<string, string> = {
      // `-a -d cwd +D <run>` asks for processes left in a run; anything else is the detach's holder query.
      lsof: `case "$1" in -a) ${options.runHolders === undefined ? "exit 1" : `printf '${options.runHolders}'`} ;; *) ${options.holders === undefined ? "exit 1" : `printf '${options.holders}'`} ;; esac`,
      fakekill: `echo "kill $*" >> '${calls}'`,
      uname: "echo Darwin", hostname: "echo Flagg", mdutil: "echo 'Indexing disabled'", newfs_hfs: "exit 0",
      mount: `[ -e '${state}' ] && echo "${volumeDev} on ${volume} ($(cat '${fsFile}'), local)"; exit 0`,
      diskutil: `echo "diskutil $*" >> '${calls}'; case "$1" in
        mount) touch '${state}' ;; unmount) rm -f '${state}' ;;
        apfs) printf apfs > '${fsFile}'; touch '${state}' ;;
        info) [ "$2" = '${volumeDev}' ] && [ '${volumeDev}' != /dev/disk99 ] && echo '   APFS Physical Store:       disk99   ' ;;
      esac`,
      hdiutil: `echo "hdiutil $*" >> '${calls}'; case "$1" in
        info) printf 'image-path : ram://123\n/dev/disk99\n' ;;
        attach) echo /dev/disk99 ;;
        detach) ${options.busy ? "exit 16" : `rm -f '${state}'`} ;;
      esac`,
    };
    for (const [name, body] of Object.entries(tools)) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const script = join(root, "gate-tmp");
    writeFileSync(script, readFileSync("bin/gate-tmp", "utf8").replace('root=/Volumes/$volume_name', `root='${volume}'`));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GATE_TMP_LOCK: join(root, "lock"), GATE_TMP_LOG: join(root, "log"), GATE_TMP_KILL: join(bin, "fakekill") };
    const gate = (...args: string[]) => spawnSync("sh", [script, ...args], { encoding: "utf8", env });
    const called = () => existsSync(calls) ? readFileSync(calls, "utf8") : "";
    const logged = () => existsSync(join(root, "log")) ? readFileSync(join(root, "log"), "utf8") : "";
    const tool = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { root, volume, state, gate, called, logged, tool };
  }
  it("detaches the disk when the last run releases, and logs it with its timing", () => {
    const d = disk();
    const claimed = d.gate("claim", String(process.pid));
    expect(claimed.status, claimed.stderr).toBe(0);
    const dir = claimed.stdout.trim();
    expect(dir).toMatch(new RegExp(`/run-${process.pid}-`));
    expect(d.called()).not.toContain("detach");
    const released = d.gate("release", dir);
    expect(released.status, released.stderr).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(d.called()).toContain("hdiutil detach /dev/disk99");
    expect(d.called()).not.toMatch(/detach.*-force/);
    expect(d.logged()).toMatch(/detach dev=\/dev\/disk99 ms=\d+/);
  });
  it("keeps the disk while another live run holds it", () => {
    const d = disk();
    const first = d.gate("claim", String(process.pid)).stdout.trim();
    const second = d.gate("claim", String(process.pid)).stdout.trim();
    d.gate("release", first);
    expect(d.called()).not.toContain("detach");
    expect(existsSync(second)).toBe(true);
    d.gate("release", second);
    expect(d.called()).toContain("hdiutil detach /dev/disk99");
  });
  it("recreates a detached disk on the next claim and logs the recreate", () => {
    const d = disk({ mounted: false });
    const claimed = d.gate("claim", String(process.pid));
    expect(claimed.status, claimed.stderr).toBe(0);
    expect(d.called()).toContain("hdiutil attach -nobrowse -nomount ram://");
    expect(d.logged()).toMatch(/recreate dev=\/dev\/disk99 ms=\d+/);
  });
  it("leaves a busy disk attached and logs who holds it, never forcing", () => {
    const d = disk({ busy: true, holders: "p2350\\ncop\\nf0\\np6242\\ncop\\n" });
    const dir = d.gate("claim", String(process.pid)).stdout.trim();
    expect(d.gate("release", dir).status).toBe(0);
    expect(existsSync(d.state)).toBe(true);
    expect(d.logged()).toContain("detach busy dev=/dev/disk99 held by op:2350 op:6242");
    // The same still-attached busy disk, now with no holder reported by lsof: no second fixture to build.
    d.tool("lsof", "exit 1");
    d.gate("release", d.gate("claim", String(process.pid)).stdout.trim());
    expect(d.logged()).toContain("held by unknown");
  });
  it("builds a recreated disk as APFS, so file times keep nanoseconds like /tmp", () => {
    const d = disk({ mounted: false });
    expect(d.gate("claim", String(process.pid)).status).toBe(0);
    expect(d.called()).toContain("diskutil apfs create /dev/disk99 gate-tmp");
    expect(d.called()).not.toContain("newfs_hfs");
  });
  it("rebuilds an idle HFS+ disk as APFS and logs it", () => {
    const d = disk({ fs: "hfs" });
    const claimed = d.gate("claim", String(process.pid));
    expect(claimed.status, claimed.stderr).toBe(0);
    expect(d.called()).toMatch(/hdiutil detach \/dev\/disk99[\s\S]*diskutil apfs create \/dev\/disk99 gate-tmp/);
    expect(d.logged()).toMatch(/rebuilt as apfs \(was hfs\) dev=\/dev\/disk99 ms=\d+/);
    expect(readFileSync(join(d.root, "fs"), "utf8")).toBe("apfs");
  });
  it("keeps an HFS+ disk that a live run still uses, and rebuilds it once idle", () => {
    const d = disk({ fs: "hfs" });
    mkdirSync(join(d.volume, `run-${process.pid}-live`));
    const claimed = d.gate("claim", String(process.pid));
    expect(claimed.status, claimed.stderr).toBe(0);
    expect(d.called()).not.toContain("detach");
    expect(existsSync(join(d.volume, `run-${process.pid}-live`))).toBe(true);
  });
  it("defers the rebuild when the HFS+ disk is busy, keeping it usable", () => {
    const d = disk({ fs: "hfs", busy: true });
    const claimed = d.gate("claim", String(process.pid));
    expect(claimed.status, claimed.stderr).toBe(0);
    expect(d.logged()).toContain("apfs rebuild deferred: /dev/disk99 busy (was hfs)");
    expect(d.called()).not.toContain("apfs create");
  });
  it("never rebuilds when the mount type does not parse", () => {
    const d = disk({ fs: "" });
    const claimed = d.gate("claim", String(process.pid));
    expect(claimed.status, claimed.stderr).toBe(0);
    expect(d.called()).not.toContain("detach");
    expect(d.called()).not.toContain("apfs create");
    expect(d.logged()).toContain("fs unknown at");
  });
  it("follows an APFS volume to its RAM store for the RAM check and the detach", () => {
    const d = disk({ volumeDev: "/dev/disk100s1" });
    const claimed = d.gate("claim", String(process.pid));
    expect(claimed.status, claimed.stderr).toBe(0);
    expect(d.gate("release", claimed.stdout.trim()).status).toBe(0);
    expect(d.called()).toContain("hdiutil detach /dev/disk99");
    expect(d.called()).not.toContain("detach /dev/disk100s1");
  });
  it("stops processes left in the run being released, and logs each by pid and command", () => {
    const d = disk({ runHolders: "p4242\\ncop\\np4343\\ncnode\\n" });
    const dir = d.gate("claim", String(process.pid)).stdout.trim();
    expect(d.gate("release", dir).status).toBe(0);
    expect(d.called()).toContain("kill 4242");
    expect(d.called()).toContain("kill 4343");
    expect(d.logged()).toMatch(/stopped op:4242 left in run-\d+-/);
    expect(d.logged()).toMatch(/stopped node:4343 left in run-\d+-/);
  });
  it("stops nothing when no process is left in the run", () => {
    const d = disk({ holders: "p2350\\ncop\\n", busy: true });
    const dir = d.gate("claim", String(process.pid)).stdout.trim();
    expect(d.gate("release", dir).status).toBe(0);
    expect(d.called()).not.toContain("kill ");
  });
  it("takes over a lock whose holder died, and refuses a release outside the volume", () => {
    const d = disk();
    mkdirSync(join(d.root, "lock"));
    writeFileSync(join(d.root, "lock", "pid"), "99999999\n");
    const claimed = d.gate("claim", String(process.pid));
    expect(claimed.status, claimed.stderr).toBe(0);
    expect(existsSync(join(d.root, "lock"))).toBe(false);
    const outside = d.gate("release", d.root);
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain("refusing release outside");
    expect(existsSync(d.root)).toBe(true);
  });
});

describe("op shim", () => {
  it("runs the real op with the inherited PATH and TMPDIR, quoting both", () => {
    const shim = opShim("/opt/homebrew/bin:/it's here", "/var/folders/x/T/");
    expect(shim).toContain("PATH='/opt/homebrew/bin:/it'\\''s here'; export PATH");
    expect(shim).toContain("TMPDIR='/var/folders/x/T/'; export TMPDIR");
    expect(shim).toContain('exec op "$@"');
    expect(opShim("/usr/bin", undefined)).toContain("unset TMPDIR");
  });
  it("puts the shim first on the gate PATH and keeps TMPDIR on the run", () => {
    const { root } = fixture();
    const dir = join(root, "run-1-x");
    mkdirSync(dir);
    const env = gateEnv(dir, { PATH: "/usr/bin:/bin", TMPDIR: "/inherited/" });
    expect(env.TMPDIR).toBe(`${dir}/`);
    expect(env.PATH).toBe(`${dir}/.muster-bin:/usr/bin:/bin`);
    expect(readFileSync(join(dir, ".muster-bin", "op"), "utf8")).toContain("TMPDIR='/inherited/'");
  });
  it("hands a real child the inherited TMPDIR when it calls op", () => {
    const { root } = fixture();
    const dir = join(root, "run-2-x");
    const fakeBin = join(root, "real");
    mkdirSync(dir); mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "op"), '#!/bin/sh\necho "op TMPDIR=$TMPDIR args=$*"\n', { mode: 0o755 });
    const env = gateEnv(dir, { PATH: `${fakeBin}:/usr/bin:/bin`, TMPDIR: "/inherited/" });
    const out = spawnSync("sh", ["-c", 'echo "child TMPDIR=$TMPDIR"; op read x'], { encoding: "utf8", env });
    expect(out.stdout).toBe(`child TMPDIR=${dir}/\nop TMPDIR=/inherited/ args=read x\n`);
  });
});

describe("claimGateTmp", () => {
  it("does nothing when off, non-darwin, or on another host, even with an explicit executable", () => {
    const warn = vi.spyOn(console, "error");
    expect(claimGateTmp("off", flagg)).toBeUndefined();
    expect(claimGateTmp("/missing", { platform: "linux", name: "remote1" })).toBeUndefined();
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
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("one absolute run directory"));
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
