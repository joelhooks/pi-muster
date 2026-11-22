import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeBundleHeads, decodePeonLockPid, type CheckOutcome, type Lane, type PeonExportReceipt, type PeonPacketSource, type Project } from "./domain.ts";
import { GuardFailed, PacketCheckFailed } from "./errors.ts";
import { Proc, type ProcShape } from "./runtime.ts";

export const peonKey = (box: string, head: string) => createHash("sha256").update(JSON.stringify([box, head])).digest("hex");
export const peonCurrentReceipt = (source: PeonPacketSource) => source.exportReceipts.at(-1);
export const peonCustodyAlarm = (source: PeonPacketSource) => peonCurrentReceipt(source) ? null
  : "destroy blocked: missing permanent raw-session export receipt; have peons/desk archive and verify custody before destroying the box";
export const samePeonReceipt = (a: PeonExportReceipt, b: PeonExportReceipt) =>
  a.id === b.id && a.sha256 === b.sha256 && a.location === b.location && a.mirror === b.mirror;

const isCode = (error: unknown, code: string) => error instanceof Error && "code" in error && error.code === code;
const deadProcess = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return isCode(error, "ESRCH"); }
};

const activePeonLandClaims = new Set<string>();

/** Publish a unique claim before checking for any other live claim. Two calls can both back off, but neither can
 * pass a claim that was published first and is still held. Stale claims never share a path with their replacement. */
export const withPeonLandLock = <A, E, R>(gitDir: string, operation: Effect.Effect<A, E, R>) => {
  const root = join(gitDir, "muster-peon-land.lock");
  const lockError = (detail: string) => new GuardFailed({ guard: "peon-land-lock", message: `${detail} (${root}); retry after the other landing exits, or inspect the lock if it persists` });
  return Effect.acquireUseRelease(Effect.try({
    try: () => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const name = `${process.pid}-${randomUUID()}`;
      mkdirSync(join(root, name), { mode: 0o700 });
      activePeonLandClaims.add(name);
      return name;
    },
    catch: error => lockError(`cannot publish the peon landing claim: ${String(error)}`),
  }), name => Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        for (const other of readdirSync(root, { withFileTypes: true })) {
          if (other.name === name) continue;
          const match = /^(\d+)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(other.name);
          if (!match || !other.isDirectory()) throw new Error(`unexpected peon landing lock entry ${JSON.stringify(other.name)}; inspect it before retrying`);
          const pid = decodePeonLockPid(Number(match[1]));
          const live = pid === process.pid ? activePeonLandClaims.has(other.name) : !deadProcess(pid);
          if (live) throw new Error("another peon landing claim exists");
          const stale = join(root, other.name);
          try { rmdirSync(stale); }
          catch (error) {
            if (isCode(error, "ENOENT")) continue;
            if (!isCode(error, "ENOTEMPTY") && !isCode(error, "EEXIST")) throw error;
            // Keep unexpected contents, but move the stale claim out of the lock scan.
            try { renameSync(stale, join(gitDir, `muster-peon-land.abandoned-${other.name}-${randomUUID()}`)); }
            catch (moveError) { if (!isCode(moveError, "ENOENT")) throw moveError; }
          }
        }
      },
      catch: error => lockError(String(error)),
    });
    return yield* operation;
  }), name => Effect.try({
    try: () => {
      try { rmdirSync(join(root, name)); }
      finally { activePeonLandClaims.delete(name); }
    },
    catch: error => error,
  }).pipe(Effect.catch(error => isCode(error, "ENOENT") ? Effect.void : Effect.logWarning(`could not release peon landing claim ${join(root, name)}: ${String(error)}`))));
};

export const peonSourceRepo = (project: Project, lane: Lane, repo: string) => Effect.try({
  try: () => {
    const source = realpathSync(lane.repo ?? project.dir);
    if (realpathSync(repo) !== source) throw new Error("repo does not match lane");
    return source;
  },
  catch: () => new GuardFailed({ guard: "peon-repo", message: "result.repo must name the lane's existing local source checkout; correct the checkout path or use the matching lane" }),
});

export const peonLocalProc = (proc: ProcShape): ProcShape => ({
  run: (command, args, options) => proc.run(command, args, command === "git"
    ? { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } }
    : options),
});

const localGit = (proc: ProcShape, cwd: string, env?: Record<string, string>) => (...args: string[]) =>
  peonLocalProc(proc).run("git", args, { cwd, ...(env ? { env } : {}) });

/** Check against refs already held by the source, never against refs or objects imported from the box. */
const resolveBase = (run: ReturnType<typeof localGit>, lane: Lane, base: string) => Effect.gen(function* () {
  const symbolic = yield* run("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  const hasMain = symbolic.code === 0 || (yield* run("show-ref", "--verify", "--quiet", "refs/heads/main")).code === 0
    || (yield* run("show-ref", "--verify", "--quiet", "refs/remotes/origin/main")).code === 0;
  const defaultRemote = symbolic.code === 0 ? symbolic.stdout.trim() : `refs/remotes/origin/${hasMain ? "main" : "master"}`;
  const defaultLocal = defaultRemote.replace(/^refs\/remotes\/origin\//, "refs/heads/");
  const requested = lane.base;
  const candidates = requested && !requested.startsWith("refs/") && !/^[0-9a-f]{7,40}$/.test(requested)
    ? [`refs/heads/${requested}`, `refs/remotes/${requested}`, `refs/remotes/origin/${requested}`, `refs/tags/${requested}`]
    : requested ? [requested] : [];
  candidates.push(defaultRemote, defaultLocal);
  for (const ref of new Set(candidates)) {
    const tip = yield* run("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
    if (tip.code !== 0) continue;
    const sha = tip.stdout.trim();
    if ((yield* run("merge-base", "--is-ancestor", base, sha)).code === 0) return { ref, sha };
  }
  return null;
});

export interface PeonBundleProof {
  readonly checks: readonly CheckOutcome[];
  readonly baseRef: string;
  readonly baseSha: string;
  readonly compare: (format: "paths" | "diff") => Effect.Effect<string, PacketCheckFailed>;
  readonly importHead: Effect.Effect<void, PacketCheckFailed>;
}

/** Hash and read the same private snapshot. Verification uses a temporary object store with a read-only
 * alternate for thin bundles. Landing imports only after the exact same checks succeed again. */
export const withPeonBundle = <A, E, R>(packet: { id: string; peon: PeonPacketSource }, source: string, lane: Lane,
  use: (proof: PeonBundleProof) => Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const { id, peon: { base, head, bundle } } = packet;
  const failure = (name: string, fix: string) => new PacketCheckFailed({ packet: id, failures: [`${name}: ${fix}`], message: fix });
  const io = <B>(name: string, fix: string, task: () => Promise<B>) => Effect.tryPromise({ try: task, catch: () => failure(name, fix) });
  const proc = yield* Proc;
  const run = localGit(proc, source);
  const root = yield* run("rev-parse", "--show-toplevel");
  if (root.code !== 0 || root.stdout.replace(/\r?\n$/, "") !== source) return yield* failure("source checkout", "point the lane and result.repo at the root of the local Git checkout and retry");
  const gitDir = yield* run("rev-parse", "--absolute-git-dir");
  if (gitDir.code !== 0) return yield* failure("source checkout", "cannot resolve the source's Git directory; fix the checkout and retry");
  return yield* Effect.acquireUseRelease(
    io("bundle snapshot", "cannot create private verification scratch under the source Git directory; check write access and free disk space", () => mkdtemp(join(gitDir.stdout.replace(/\r?\n$/, ""), "muster-peon-bundle-"))),
    scratch => Effect.gen(function* () {
      const snapshot = join(scratch, "packet.bundle");
      const digest = yield* io("bundle sha256", "cannot read the bundle; restore the exported bundle at result.bundle.path and retry", async () => {
        if (!(await lstat(bundle.path)).isFile()) throw new Error("expected regular file");
        await copyFile(bundle.path, snapshot);
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(snapshot)) hash.update(chunk);
        return hash.digest("hex");
      });
      if (digest !== bundle.sha256) return yield* failure("bundle sha256", "bundle sha256 mismatch; restore the exact bundle matching result.bundle.sha256 and retry, or rerun the work in a new box if the recorded hash was wrong");
      const advertised = yield* run("bundle", "list-heads", snapshot);
      if (advertised.code !== 0) return yield* failure("bundle head", "cannot read bundle refs; export a valid Git bundle and report it again");
      const refs = yield* Effect.try({
        try: () => decodeBundleHeads(advertised.stdout.trim().split("\n").filter(Boolean).map(line => line.split(" ")[0])),
        catch: () => failure("bundle head", "invalid bundle refs; export a bundle with a ref advertising the exact 40-hex head"),
      });
      if (!refs.includes(head)) return yield* failure("bundle head", "head is not advertised by the bundle; rerun in a new box and export a bundle with a ref at result.head");
      const reachable = yield* resolveBase(run, lane, base);
      if (!reachable) return yield* failure("base reachability", "base is unknown or not reachable from the lane base or default branch; sync the local source refs or rerun the box from the correct base");
      const objects = join(scratch, "objects");
      yield* io("bundle snapshot", "cannot prepare a temporary Git object store; check free space and retry", () => mkdir(objects));
      const alternate = yield* run("rev-parse", "--path-format=absolute", "--git-path", "objects");
      if (alternate.code !== 0) return yield* failure("source checkout", "cannot resolve the source object store; point the lane at a Git checkout and retry");
      const isolatedEnv = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(alternate.stdout.replace(/\r?\n$/, "")) };
      const isolated = localGit(proc, source, isolatedEnv);
      const unpack = (git: typeof isolated) => git("bundle", "unbundle", snapshot).pipe(Effect.flatMap(result => result.code === 0
        ? Effect.void : Effect.fail(failure("bundle import", "cannot import the bundle; restore its prerequisites locally or re-export the bundle from the recorded base"))));
      yield* unpack(isolated);
      const onlyBundle = localGit(proc, source, { ...isolatedEnv, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" });
      const type = yield* onlyBundle("cat-file", "-t", head);
      if (type.code !== 0 || type.stdout.trim() !== "commit") return yield* failure("bundle head", "bundle does not contain the advertised head commit; re-export with that commit in the pack");
      if ((yield* isolated("merge-base", "--is-ancestor", base, head)).code !== 0) return yield* failure("head ancestry", "head does not descend from base; rerun the box from result.base and export the new head");
      const compare = (format: "paths" | "diff") => isolated("diff", "--no-ext-diff", "--no-textconv", ...(format === "paths" ? ["--no-renames", "--name-only", "-z"] : []), base, head, "--").pipe(
        Effect.mapError(() => failure("bundle diff", "cannot inspect the packet diff; retry with a readable bundle and source checkout")),
        Effect.flatMap(result => result.code === 0 ? Effect.succeed(result.stdout) : Effect.fail(failure("bundle diff", "cannot inspect the packet diff; restore the source objects or export a complete bundle"))),
      );
      return yield* use({
        checks: [
          { name: "bundle sha256", outcome: "pass", detail: digest },
          { name: "bundle head", outcome: "pass", detail: head },
          { name: "head ancestry", outcome: "pass", detail: `descends from ${base}` },
          { name: "base reachability", outcome: "pass", detail: `${base} is reachable from ${reachable.ref} (${reachable.sha})` },
        ],
        baseRef: reachable.ref, baseSha: reachable.sha, compare,
        importHead: unpack(run).pipe(Effect.mapError(error => error._tag === "PacketCheckFailed" ? error : failure("bundle import", "Git could not import the verified bundle; check source checkout permissions and retry"))),
      });
    }),
    scratch => Effect.tryPromise({ try: () => rm(scratch, { recursive: true, force: true }), catch: error => error }).pipe(
      Effect.catch(error => Effect.logWarning(`could not remove peon bundle scratch ${scratch}: ${String(error)}`)),
    ),
  );
});
