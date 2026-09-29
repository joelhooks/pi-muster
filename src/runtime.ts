import { execFile } from "node:child_process";

import { Context, Effect } from "effect";
import type { HerdrClient } from "@joelhooks/pi-bellwether/herdr-client";

import { ProcError } from "./errors.ts";

/** Bellwether's Herdr socket client. Tests provide a stub with the same shape. */
export class Herdr extends Context.Service<Herdr, HerdrClient>()("muster/Herdr") {}

export interface ProcResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ProcShape {
  /** Runs one process to completion. A nonzero exit is a result; only a spawn failure or timeout fails. */
  readonly run: (command: string, args: readonly string[], options: ProcOptions) => Effect.Effect<ProcResult, ProcError>;
}

export class Proc extends Context.Service<Proc, ProcShape>()("muster/Proc") {}

export interface EnvShape {
  readonly home: string;
  readonly now: () => Date;
  /** The calling Pi session: owner of what it launches. */
  readonly sessionId: string;
  readonly paneId: string | undefined;
  /** Package root, loaded into agents with `-e` when Muster is not installed in settings. */
  readonly musterRoot: string;
  readonly workerWorktree: string;
  readonly createId: () => string;
  readonly sleep: (ms: number) => Effect.Effect<void>;
}

export class MusterEnv extends Context.Service<MusterEnv, EnvShape>()("muster/Env") {}

export type OutboxStatus = "sent" | "rejected" | "blocked" | "failed" | "unavailable";

export interface IntercomShape {
  readonly send: (to: string, message: string) => Effect.Effect<{ readonly status: OutboxStatus; readonly detail?: string }>;
  /** Live intercom session ids, or undefined when pi-intercom is absent or disconnected. */
  readonly sessions: () => Effect.Effect<readonly string[] | undefined>;
}

export class Intercom extends Context.Service<Intercom, IntercomShape>()("muster/Intercom") {}

const MAX_BUFFER = 16 * 1024 * 1024;

export const liveProc: ProcShape = {
  run: (command, args, options) =>
    Effect.callback<ProcResult, ProcError>((resume) => {
      const child = execFile(
        command,
        [...args],
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 120_000,
          maxBuffer: MAX_BUFFER,
          env: { ...process.env, ...options.env },
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          if (err && (typeof err.code === "string" || err.killed)) {
            resume(
              Effect.fail(
                new ProcError({
                  command: [command, ...args].join(" "),
                  code: null,
                  stderr: String(stderr ?? ""),
                  message: err.killed ? `timed out after ${options.timeoutMs ?? 120_000}ms` : err.message,
                }),
              ),
            );
            return;
          }
          resume(Effect.succeed({ code: err ? Number(err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
        },
      );
      return Effect.sync(() => {
        child.kill("SIGTERM");
      });
    }),
};

/** Runs a command and fails on a nonzero exit. */
export const must = (command: string, args: readonly string[], options: ProcOptions) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const result = yield* proc.run(command, args, options);
    if (result.code !== 0) {
      return yield* new ProcError({
        command: [command, ...args].join(" "),
        code: result.code,
        stderr: result.stderr.slice(-2000),
        message: `${command} ${args[0] ?? ""} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-500)}`,
      });
    }
    return result.stdout;
  });

export const git = (cwd: string, ...args: string[]) => must("git", args, { cwd });

export const BOT_NAME = "shitratgit[bot]";
export const BOT_EMAIL = "286405550+shitratgit[bot]@users.noreply.github.com";
/** Every commit Muster makes is the bot's. Muster never pushes. */
export const botGit = (cwd: string, ...args: string[]) =>
  must("git", ["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, ...args], {
    cwd,
    env: { GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL, GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL },
  });
