import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { NAME_SHIM } from "./argv.ts";

import type { AgentRow, CheckOutcome, Lane, Packet, Project } from "./domain.ts";
import { Proc, git, type ProcShape } from "./runtime.ts";

/** Harness prefixes, not permission to discard transcripts or other differing work. */
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

/** Shared by the owner and the filesystem scan executed on the clone's machine. */
export function isTranscriptPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return /(?:^|\/)\.pi-subagents(?:\/|$)/.test(normalized) ||
    /(?:^|\/)(?:\.pi\/agent\/sessions|\.claude\/projects|\.codex\/sessions)(?:\/|$)/.test(normalized) ||
    /[^/]*transcript[^/]*\.jsonl$/i.test(normalized) ||
    /(?:^|\/)sessions\/.*\.jsonl$/i.test(normalized);
}

/** No transport assumptions: Proc runs this unchanged locally or through SSH.
 * Walk ignored and tracked files too. Never follow transcript symlinks or
 * overwrite a rescue. Verify the complete manifest again just before retirement. */
export const transcriptRescueScript = () => `
${NAME_SHIM}
try {
const fs=require('node:fs'), p=require('node:path'), crypto=require('node:crypto');
const isTranscriptPath=${isTranscriptPath.toString()};
const [mode,root,home,slug,row,stamp,previous]=process.argv.slice(1);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files=[];
function walk(dir,relative='') {
  for(const name of fs.readdirSync(dir).sort()) {
    const path=relative?relative+'/'+name:name, full=p.join(root,path), stat=fs.lstatSync(full);
    if(stat.isSymbolicLink()) {
      if(isTranscriptPath(path))throw new Error('transcript symlink refuses retirement: '+path);
      // A symlink is not part of the clone's owned directory tree.
      continue;
    }
    if(stat.isDirectory())walk(full,path);
    else if(isTranscriptPath(path)) {
      if(!stat.isFile())throw new Error('non-regular transcript: '+path);
      files.push({path,bytes:stat.size,sha256:hash(full)});
    }
  }
}
walk(root);
let receipt;
if(mode==='rescue') {
  let dir=null;
  if(files.length) {
    const parent=p.join(home||require('node:os').homedir(),'.local/state/transcript-rescue');
    fs.mkdirSync(parent,{recursive:true,mode:0o700});
    const safe=s=>s.replace(/[^a-zA-Z0-9_-]/g,'_');
    dir=fs.mkdtempSync(p.join(parent,safe(slug)+'-'+safe(row)+'-'+stamp+'-'));
    fs.chmodSync(dir,0o700);
    if(fs.realpathSync(dir).startsWith(fs.realpathSync(root)+p.sep))throw new Error('transcript rescue is inside clone');
    for(const file of files) {
      const dest=p.join(dir,file.path);
      fs.mkdirSync(p.dirname(dest),{recursive:true,mode:0o700});
      fs.copyFileSync(p.join(root,file.path),dest,fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest,0o600);
      if(fs.statSync(dest).size!==file.bytes||hash(dest)!==file.sha256)throw new Error('transcript rescue mismatch: '+file.path);
    }
  }
  receipt={dir,files,bytes:files.reduce((sum,file)=>sum+file.bytes,0)};
} else {
  receipt=JSON.parse(previous);
  if(JSON.stringify(files)!==JSON.stringify(receipt.files))throw new Error('transcripts changed during preservation');
  for(const file of files) {
    const dest=p.join(receipt.dir,file.path);
    if(!fs.lstatSync(dest).isFile()||fs.statSync(dest).size!==file.bytes||hash(dest)!==file.sha256)throw new Error('transcript rescue mismatch: '+file.path);
  }
}
process.stdout.write(JSON.stringify(receipt));
} catch(error) { console.error('transcript preservation failed: '+error.message); process.exitCode=1; }
`;

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

/** Prefer local branches, then HEAD, then remote-tracking refs in either checkout. */
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
    const remoteContaining = yield* run("for-each-ref", "--format=%(refname:short)", "--contains", commit, "refs/remotes");
    const remoteBranch = remoteContaining.code === 0 ? remoteContaining.stdout.trim().split("\n").filter(Boolean)[0] : undefined;
    if (remoteBranch) return { check: pass("on lane branch", `on remote-tracking branch ${remoteBranch} (row branch ${rowBranch})`), branch: remoteBranch };
    const all = yield* run("for-each-ref", "--format=%(refname:short)", "refs/heads");
    const checked = all.code === 0 ? all.stdout.trim().split("\n").filter(Boolean) : [rowBranch];
    const allRemote = yield* run("for-each-ref", "--format=%(refname:short)", "refs/remotes");
    const checkedRemote = allRemote.code === 0 ? allRemote.stdout.trim().split("\n").filter(Boolean) : [];
    return { check: fail("on lane branch", `${commit} is not an ancestor of ${rowBranch}; checked branches: ${[...new Set([...checked, rowBranch, "HEAD"])].join(", ")}; checked remote-tracking refs: ${checkedRemote.join(", ") || "(none)"}`), branch: null };
  });

export const sourceOf = (project: Project, lane: Lane | undefined, row: AgentRow) => row.clone?.source ?? lane?.repo ?? project.dir;

/** The same cumulative patch comparison used to prove an explicit squash landing. */
export const squashPatchMatches = (proc: ProcShape, source: string, packetBase: string, commit: string, parent: string, landing: string) =>
  Effect.gen(function* () {
    const patchId = (from: string, to: string) => proc.run("bash", ["-c", 'set -o pipefail; git diff --no-ext-diff --no-textconv --binary "$1" "$2" -- | git patch-id --stable', "muster-squash", from, to], { cwd: source, timeoutMs: 30_000 });
    const packetPatch = yield* patchId(packetBase, commit);
    const landingPatch = yield* patchId(parent, landing);
    const id = packetPatch.stdout.trim().split(/\s+/)[0];
    return packetPatch.code === 0 && landingPatch.code === 0 && !!id && id === landingPatch.stdout.trim().split(/\s+/)[0];
  });

/** Shared by local and SSH verification. Callers prove the source directory exists first. */
export const verifyGoneClone = (proc: ProcShape, source: string, lane: Lane | undefined, row: AgentRow, commit: string, sourceExists: boolean) =>
  Effect.gen(function* () {
    const missing = `clone ${row.cwd} is gone and ${commit} is not in ${source}; land with outcome rejected or no_changes and evidence`;
    const checks: CheckOutcome[] = [pass("dirty paths", "clone gone; nothing to compare")];
    const run = (...args: string[]) => proc.run("git", args, { cwd: source, timeoutMs: 30_000 });
    if (!sourceExists || (yield* run("cat-file", "-e", `${commit}^{commit}`)).code !== 0) {
      checks.push(fail("commit exists", missing));
      return { checks, branch: null };
    }
    checks.push(pass("commit exists", `clone gone; found ${commit} in source`));
    if (row.clone?.base) {
      const base = row.clone.base;
      checks.push((yield* run("merge-base", "--is-ancestor", base.sha, commit)).code === 0
        ? pass("clone base", `clone gone; ${base.ref} ${base.sha} in source`)
        : fail("clone base", `clone gone; ${commit} does not descend from ${base.ref} ${base.sha}`));
    }
    const symbolic = yield* run("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
    const base = lane?.base?.replace(/^(?:(?:refs\/remotes\/)?origin\/|refs\/heads\/)/, "") ??
      (symbolic.code === 0 ? symbolic.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : "main");
    const refs = yield* run("for-each-ref", "--format=%(refname:short)", "--contains", commit, "refs/heads", "refs/remotes");
    const containing = refs.code === 0 ? refs.stdout.trim().split("\n").filter(Boolean) : [];
    const onBase = (yield* run("merge-base", "--is-ancestor", commit, base)).code === 0;
    if (onBase || containing.length) {
      checks.push(pass("on lane branch", `clone gone; found on ${onBase ? base : containing[0]} in source`));
      return { checks, branch: null };
    }
    // A squash has the packet's cumulative patch, not necessarily its final commit's patch.
    for (const baseRef of [base, `refs/remotes/origin/${base}`]) {
      const fork = yield* run("merge-base", commit, baseRef);
      if (fork.code !== 0) continue;
      const history = yield* run("rev-list", "--first-parent", `${fork.stdout.trim()}..${baseRef}`);
      for (const sha of history.code === 0 ? history.stdout.trim().split("\n").filter(Boolean) : []) {
        const parent = yield* run("rev-parse", "--verify", `${sha}^`);
        if (parent.code !== 0) continue;
        const mergeBase = yield* run("merge-base", commit, parent.stdout.trim());
        if (mergeBase.code !== 0) continue;
        if (yield* squashPatchMatches(proc, source, mergeBase.stdout.trim(), commit, parent.stdout.trim(), sha)) {
          checks.push(pass("on lane branch", `clone gone; landed by squash as ${sha}`));
          return { checks, branch: null };
        }
      }
    }
    checks.push(fail("on lane branch", missing));
    return { checks, branch: null };
  });

/**
 * Evidence for one packet. The intercom report is a claim; these checks are
 * what the owner records. A hash identifies bytes; it does not prove quality.
 */
export const verifyPacket = (project: Project, lane: Lane | undefined, row: AgentRow, packet: Packet) =>
  Effect.gen(function* () {
    const checks: CheckOutcome[] = [];
    const reportOk = existsSync(packet.report) && statSync(packet.report).size > 0;
    checks.push(reportOk ? pass("report exists", packet.report) : fail("report exists", `missing or empty: ${packet.report}`));

    const cloneExists = existsSync(row.cwd) && statSync(row.cwd).isDirectory();
    if (!cloneExists && packet.kind === "commit") {
      const source = sourceOf(project, lane, row);
      const fallback = yield* verifyGoneClone(yield* Proc, source, lane, row, packet.id, existsSync(source) && statSync(source).isDirectory());
      return { checks: [...checks, ...fallback.checks], branch: null };
    }
    if (row.clone && cloneExists) {
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
