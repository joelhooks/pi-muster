import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVersionSkew, withVersionSkew } from "./version-skew.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function repo() {
  const root = mkdtempSync(join(tmpdir(), "muster-skew-"));
  git(root, "init", "-q");
  git(root, "config", "user.name", "test");
  git(root, "config", "user.email", "test@example.com");
  commit(root);
  return root;
}
function commit(root: string) {
  git(root, "commit", "-q", "--allow-empty", "-m", "next");
  return git(root, "rev-parse", "HEAD");
}
function clock(root: string) {
  let time = 0;
  return { skew: createVersionSkew({ root, now: () => time }), tick: () => { time += 60_000; } };
}
afterEach(() => vi.restoreAllMocks());

describe("version skew", () => {
  it("adds nothing at the loaded commit, then names both shas and the distance", async () => {
    const root = repo();
    const loaded = git(root, "rev-parse", "HEAD");
    const { skew, tick } = clock(root);
    expect(await skew.check()).toBeUndefined();
    commit(root);
    const disk = commit(root);
    tick();
    expect(await skew.check()).toBe(`⚠ Muster tools are stale: loaded ${loaded.slice(0, 7)}, on disk ${disk.slice(0, 7)} (2 commits). Restart this session (or /reload) to load them.`);
    git(root, "checkout", "--detach", loaded);
    tick();
    expect(await skew.check()).toBeUndefined();
  });

  it("resolves a packed ref at load and on a later check", async () => {
    const root = repo();
    git(root, "pack-refs", "--all", "--prune");
    const loaded = git(root, "rev-parse", "HEAD");
    const { skew } = clock(root);
    const disk = commit(root);
    git(root, "pack-refs", "--all", "--prune");
    expect(await skew.check()).toContain(`loaded ${loaded.slice(0, 7)}, on disk ${disk.slice(0, 7)} (1 commits)`);
  });

  it("a non-git root without a useful package quietly skips checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "muster-no-git-"));
    expect(await createVersionSkew({ root }).check()).toBeUndefined();
  });

  it("falls back to package version and newest loaded-file mtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "muster-package-"));
    mkdirSync(join(root, "extensions"));
    mkdirSync(join(root, "src"));
    const extension = join(root, "extensions", "pi-muster.ts");
    const source = join(root, "src", "loaded.ts");
    writeFileSync(extension, 'export default async () => import("../src/loaded.ts");');
    writeFileSync(source, "export const value = 1;");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    utimesSync(extension, 1, 1);
    utimesSync(source, 2, 2);
    const { skew, tick } = clock(root);
    expect(await skew.check()).toBeUndefined();
    utimesSync(source, 3, 3);
    tick();
    expect(await skew.check()).toContain("loaded 1.0.0@2000, on disk 1.0.0@3000.");
  });

  it("two calls within a minute take one disk snapshot, also when concurrent", async () => {
    const root = repo();
    const { skew, tick } = clock(root);
    const reads = vi.mocked(fs.readFileSync);
    reads.mockClear();
    await Promise.all([skew.check(), skew.check()]);
    expect(reads.mock.calls.filter(([path]) => path === join(root, ".git", "HEAD"))).toHaveLength(1);
    await skew.check();
    expect(reads.mock.calls.filter(([path]) => path === join(root, ".git", "HEAD"))).toHaveLength(1);
    tick();
    await skew.check();
    expect(reads.mock.calls.filter(([path]) => path === join(root, ".git", "HEAD"))).toHaveLength(2);
  });

  it("caches count once per disk commit and omits it when git fails", async () => {
    const root = repo();
    const { skew, tick } = clock(root);
    const disk = commit(root);
    expect(await skew.check()).toContain("(1 commits)");
    writeFileSync(join(root, ".git", "config"), "invalid config\n");
    tick();
    expect(await skew.check()).toContain("(1 commits)");
    // A new detached HEAD is readable, but the count command cannot run.
    writeFileSync(join(root, ".git", "HEAD"), `${"a".repeat(40)}\n`);
    tick();
    const warning = await skew.check();
    expect(warning).toContain("on disk aaaaaaa.");
    expect(warning).not.toContain("commits)");
    expect(disk).not.toBe(readFileSync(join(root, ".git", "HEAD"), "utf8").trim());
  });

  it("marks the project_status board header without changing details or non-text content", async () => {
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    const pi = withVersionSkew({ registerTool: (tool: typeof registered[number]) => registered.push(tool) } as never, { check: async () => "warning" });
    pi.registerTool({ name: "project_status", parameters: {} as never, label: "test", description: "test", execute: async () => ({ content: [{ type: "text", text: "Board header\nrow" }], details: { board: "original" } }) });
    expect(await registered[0]?.execute()).toEqual({ content: [{ type: "text", text: "Board header · ⚠ Muster tools stale\nrow\nwarning" }], details: { board: "original" } });
  });

  it("a failed check never fails the registered tool", async () => {
    const registered: Array<{ execute: (...args: unknown[]) => Promise<unknown> }> = [];
    const pi = withVersionSkew({ registerTool: (tool: typeof registered[number]) => registered.push(tool) } as never, { check: async () => { throw new Error("unreadable"); } });
    pi.registerTool({ name: "probe", parameters: {} as never, label: "test", description: "test", execute: async () => ({ content: [{ type: "text", text: "success" }], details: null }) });
    expect(await registered[0]?.execute()).toEqual({ content: [{ type: "text", text: "success" }], details: null });
  });
});
