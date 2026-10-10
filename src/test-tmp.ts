import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One temp root per test run. Fixtures call mkdtempSync(tmpdir()) and never clean up; ~19,000 leaked
 * `muster-*` dirs filled pennywise's /tmp inodes (2026-10-10). Workers inherit TMPDIR from this process,
 * so every fixture lands under the run's root, and teardown removes the root once.
 */
export default function setup() {
  const previous = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), "muster-run-"));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  };
}
