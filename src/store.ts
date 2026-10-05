import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Effect, Schema } from "effect";

import { Project } from "./domain.ts";
import { NotFound, StoreError } from "./errors.ts";
import { registerProject } from "./registry.ts";
import { MusterEnv } from "./runtime.ts";

/**
 * One file per project: `<project>/.brain/data/muster/project.json`. Owners
 * and workers are separate processes, so every write is a short locked
 * read-modify-write with an atomic rename. Long operations (launches, gates)
 * never hold the lock; they read, act, then patch.
 */
export const dataDir = (dir: string) => join(dir, ".brain", "data", "muster");
export const projectPath = (dir: string) => join(dataDir(dir), "project.json");
export const reportsDir = (dir: string) => join(dataDir(dir), "reports");
export const closedDir = (dir: string) => join(dataDir(dir), "closed");

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;

/** Bump whenever persisted fields are added, including nested structs. Never a git SHA. */
export const CATALOG_WRITER_SCHEMA_VERSION = 2; // 2: Lane.discarded

const decode = Schema.decodeUnknownEffect(Project);
const encode = Schema.encodeSync(Project);

export const exists = (dir: string) => existsSync(projectPath(dir));

const readProject = (path: string, dir: string): Effect.Effect<Project, StoreError | NotFound> =>
  Effect.gen(function* () {
    if (!existsSync(path)) {
      return yield* new NotFound({ kind: "project", id: dir, message: `no Muster project at ${path}; run project_open first` });
    }
    const raw = yield* Effect.try({
      try: () => JSON.parse(readFileSync(path, "utf8")) as unknown,
      catch: (error) => new StoreError({ path, message: `unreadable project file: ${String(error)}` }),
    });
    return yield* decode(raw).pipe(Effect.mapError((error) => new StoreError({ path, message: `invalid project file: ${String(error)}` })));
  });

export const load = (dir: string): Effect.Effect<Project, StoreError | NotFound> => readProject(projectPath(dir), dir);

const writeAtomic = (path: string, project: Project) =>
  Effect.gen(function* () {
    // Inspect the disk under mutate's lock: a patch cannot remove/downgrade the fence.
    const disk = existsSync(path) ? yield* readProject(path, project.dir) : undefined;
    const version = Math.max(disk?.writerSchemaVersion ?? 0, project.writerSchemaVersion ?? 0);
    if (version > CATALOG_WRITER_SCHEMA_VERSION) {
      return yield* new StoreError({ path, message: `catalog written by a newer Muster (schema ${version} > ${CATALOG_WRITER_SCHEMA_VERSION}); restart this session on current code` });
    }
    yield* Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(encode({ ...project, writerSchemaVersion: CATALOG_WRITER_SCHEMA_VERSION }), null, 2)}\n`);
        renameSync(tmp, path);
      },
      catch: (error) => new StoreError({ path, message: `write failed: ${String(error)}` }),
    });
  });

const acquire = (path: string) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const lock = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return yield* new StoreError({ path, message: `lock failed: ${String(error)}` });
        }
      }
      const age = (() => {
        try {
          return Date.now() - statSync(lock).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (age > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) return yield* new StoreError({ path, message: "project file is locked by another process" });
      yield* env.sleep(50);
    }
  });

/** Create the project file. Fails if one exists. */
export const create = (project: Project) =>
  Effect.gen(function* () {
    const path = projectPath(project.dir);
    if (existsSync(path)) return yield* new StoreError({ path, message: "project already exists" });
    yield* writeAtomic(path, project);
    return project;
  });

/**
 * Locked read-modify-write. `patch` gets the current file and returns the new
 * project plus a result. It must be quick and must not touch Herdr or git.
 */
export const mutate = <A, E, R>(dir: string, patch: (project: Project) => Effect.Effect<readonly [Project, A], E, R>) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const path = projectPath(dir);
    return yield* Effect.acquireUseRelease(
      acquire(path),
      () =>
        Effect.gen(function* () {
          const current = yield* load(dir);
          const [next, result] = yield* patch(current);
          if (next !== current) {
            yield* writeAtomic(path, { ...next, updatedAt: env.now().toISOString() });
            // Any write registers the project, so the Switchboard finds projects opened before the registry existed.
            yield* registerProject(next);
          }
          return result;
        }),
      (lock) => Effect.sync(() => rmSync(lock, { recursive: true, force: true })),
    );
  });
