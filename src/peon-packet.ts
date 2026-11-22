import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeBundleHeads, type CheckOutcome, type Lane, type PeonPacketSource, type Project } from "./domain.ts";
import { GuardFailed, PacketCheckFailed } from "./errors.ts";
import { Proc, type ProcShape } from "./runtime.ts";

export const peonKey = (box: string, head: string) => createHash("sha256").update(JSON.stringify([box, head])).digest("hex");
export const peonCustodyAlarm = (source: PeonPacketSource) => source.exportReceipt === null
  ? "destroy blocked: missing permanent raw-session export receipt; have peons/desk archive and verify custody before destroying the box"
  : null;

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
  use: (proof: PeonBundleProof) => Effect.Effect<A, E, R>) => {
  const { id, peon: { base, head, bundle } } = packet;
  const failure = (name: string, fix: string) => new PacketCheckFailed({ packet: id, failures: [`${name}: ${fix}`], message: fix });
  const io = <B>(name: string, fix: string, task: () => Promise<B>) => Effect.tryPromise({ try: task, catch: () => failure(name, fix) });
  return Effect.acquireUseRelease(
    io("bundle snapshot", "cannot create private verification scratch; make temporary storage writable and retry", () => mkdtemp(join(tmpdir(), "muster-peon-"))),
    scratch => Effect.gen(function* () {
      const proc = yield* Proc;
      const run = localGit(proc, source);
      const root = yield* run("rev-parse", "--show-toplevel");
      if (root.code !== 0 || root.stdout.replace(/\r?\n$/, "") !== source) return yield* failure("source checkout", "point the lane and result.repo at the root of the local Git checkout and retry");
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
    scratch => Effect.promise(() => rm(scratch, { recursive: true, force: true })),
  );
};
