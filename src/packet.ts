import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";

import type { AgentRow, CheckOutcome, Lane, Packet, Project } from "./domain.ts";
import { Proc, git, type ProcShape } from "./runtime.ts";

/** Paths a clone may leave dirty without matching the source (worker-worktree.sh's allowlist). */
export const DEFAULT_GENERATED = [".brain/", ".pi/", ".pi-subagents/", ".claude/", ".agents/", ".codex/", "BRAIN.md", "AGENTS.md", "CLAUDE.md", ".rift"];

/** Paths from `git status --porcelain=v1 -z`. A rename entry carries its source path as an extra field. */
export function parsePorcelainZ(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    paths.push(field.slice(3));
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return paths;
}

export const isGenerated = (path: string, generated: readonly string[]) =>
  generated.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`)));

function bytesEqual(a: string, b: string): boolean {
  const aExists = existsSync(a);
  const bExists = existsSync(b);
  if (!aExists || !bExists) return aExists === bExists;
  if (statSync(a).isDirectory() || statSync(b).isDirectory()) return false;
  return readFileSync(a).equals(readFileSync(b));
}

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const pass = (name: string, detail?: string): CheckOutcome => (detail ? { name, outcome: "pass", detail } : { name, outcome: "pass" });
const fail = (name: string, detail: string): CheckOutcome => ({ name, outcome: "fail", detail });
const skip = (name: string, detail: string): CheckOutcome => ({ name, outcome: "skip", detail });

const exitOf = (cwd: string, args: string[]) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    return (yield* proc.run("git", args, { cwd })).code;
  });

/** Shared local/remote branch evidence; HEAD also covers detached worker checkouts. */
export const verifyCommitBranch = (proc: ProcShape, cwd: string, commit: string, rowBranch: string) =>
  Effect.gen(function* () {
    const run = (...args: string[]) => proc.run("git", args, { cwd, timeoutMs: 30_000 });
    const ancestor = yield* run("merge-base", "--is-ancestor", commit, rowBranch);
    if (ancestor.code === 0) return { check: pass("on lane branch", rowBranch), branch: null };
    const containing = yield* run("for-each-ref", "--format=%(refname:short)", "--contains", commit, "refs/heads");
    const head = yield* run("merge-base", "--is-ancestor", commit, "HEAD");
    const branches = containing.code === 0 ? containing.stdout.trim().split("\n").filter(Boolean) : [];
    const current = yield* run("symbolic-ref", "--quiet", "--short", "HEAD");
    const headBranch = current.code === 0 ? current.stdout.trim() : "HEAD";
    const branch = head.code === 0 && headBranch !== "HEAD" ? headBranch : branches[0] ?? (head.code === 0 ? "HEAD" : undefined);
    if (branch) return { check: pass("on lane branch", `on sibling branch ${branch} (row branch ${rowBranch})`), branch };
    const all = yield* run("for-each-ref", "--format=%(refname:short)", "refs/heads");
    const checked = all.code === 0 ? all.stdout.trim().split("\n").filter(Boolean) : [rowBranch];
    return { check: fail("on lane branch", `${commit} is not an ancestor of ${rowBranch}; checked branches: ${[...new Set([...checked, rowBranch, "HEAD"])].join(", ")}`), branch: null };
  });

export const sourceOf = (project: Project, lane: Lane | undefined, row: AgentRow) => row.clone?.source ?? lane?.repo ?? project.dir;

/**
 * Evidence for one packet. The intercom report is a claim; these checks are
 * what the owner records. A hash identifies bytes; it does not prove quality.
 */
export const verifyPacket = (project: Project, lane: Lane | undefined, row: AgentRow, packet: Packet) =>
  Effect.gen(function* () {
    const checks: CheckOutcome[] = [];
    const reportOk = existsSync(packet.report) && statSync(packet.report).size > 0;
    checks.push(reportOk ? pass("report exists", packet.report) : fail("report exists", `missing or empty: ${packet.report}`));

    if (row.clone) {
      const base = row.clone.base;
      if (!base) {
        checks.push(skip("clone base", `lane ${row.lane} has no recorded clone base (launched before bases were recorded)`));
      } else {
        // Work advances HEAD; the starting commit must remain in the packet's history.
        const ref = packet.kind === "commit" ? packet.id : "HEAD";
        const contains = (yield* exitOf(row.cwd, ["merge-base", "--is-ancestor", base.sha, ref])) === 0;
        checks.push(contains
          ? pass("clone base", `${base.ref} ${base.sha}`)
          : fail("clone base", `lane ${row.lane}: ${ref} does not descend from ${base.ref} ${base.sha}`));
      }
    }

    if (packet.kind === "artifact") {
      if (!packet.artifact || !existsSync(packet.artifact)) {
        checks.push(fail("artifact hash", `missing artifact ${packet.artifact ?? "(none)"}`));
      } else {
        const actual = sha256File(packet.artifact);
        checks.push(actual === packet.id ? pass("artifact hash", actual) : fail("artifact hash", `sha256 is ${actual}, packet names ${packet.id}`));
      }
      return { checks, branch: null };
    }

    const clone = row.cwd;
    const source = sourceOf(project, lane, row);
    const exists = (yield* exitOf(clone, ["cat-file", "-e", `${packet.id}^{commit}`])) === 0;
    checks.push(exists ? pass("commit exists", packet.id) : fail("commit exists", `${packet.id} is not a commit in ${clone}`));
    if (!exists) return { checks, branch: null };

    const branch = row.clone?.branch ?? (yield* git(clone, "rev-parse", "--abbrev-ref", "HEAD")).trim();
    const branchEvidence = yield* verifyCommitBranch(yield* Proc, clone, packet.id, branch);
    checks.push(branchEvidence.check);

    if (clone === source) {
      checks.push(skip("expected repo", "packet built in the source checkout"));
      checks.push(skip("dirty paths", "packet built in the source checkout"));
      return { checks, branch: branchEvidence.branch };
    }
    const roots = (ref: string, cwd: string) =>
      git(cwd, "rev-list", "--max-parents=0", ref).pipe(Effect.map((out) => new Set(out.split("\n").filter(Boolean))));
    const packetRoots = yield* roots(packet.id, clone);
    const sourceRoots = yield* roots("HEAD", source);
    const shared = [...packetRoots].some((root) => sourceRoots.has(root));
    checks.push(shared ? pass("expected repo", source) : fail("expected repo", `${packet.id} shares no root commit with ${source}`));

    const dirty = parsePorcelainZ(yield* git(clone, "status", "--porcelain=v1", "-z", "--untracked-files=all"));
    const generated = [...DEFAULT_GENERATED, ...(lane?.generated ?? [])];
    const differing = dirty.filter((path) => !isGenerated(path, generated) && !bytesEqual(join(clone, path), join(source, path)));
    checks.push(
      differing.length === 0
        ? pass("dirty paths", `${dirty.length} dirty, all generated or identical to source`)
        : fail("dirty paths", `differ from source and are not named generated: ${differing.slice(0, 20).join(", ")}`),
    );
    return { checks, branch: branchEvidence.branch };
  });

export const failures = (checks: readonly CheckOutcome[]) => checks.filter((check) => check.outcome === "fail");
