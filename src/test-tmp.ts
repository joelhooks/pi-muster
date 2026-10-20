import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One temp root per test run. Fixtures call mkdtempSync(tmpdir()) and never clean up; ~19,000 leaked
 * `muster-*` dirs filled remote1's /tmp inodes (2026-10-10). Workers inherit TMPDIR from this process,
 * so every fixture lands under the run's root, and teardown removes the root once.
 */
export default function setup() {
  // Fixture repos never need background gc/maintenance or fsync; each commit or fetch otherwise spawns a detached `git maintenance`.
  const git = { GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "gc.auto", GIT_CONFIG_VALUE_0: "0", GIT_CONFIG_KEY_1: "maintenance.auto", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_KEY_2: "core.fsync", GIT_CONFIG_VALUE_2: "none" };
  const saved = Object.fromEntries(Object.keys(git).map(key => [key, process.env[key]]));
  Object.assign(process.env, git);
  const previous = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), "muster-run-"));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  };
}
