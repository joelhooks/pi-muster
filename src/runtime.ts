import { execFile } from "node:child_process";

import { Context, Effect } from "effect";
import type { HerdrClient } from "@joelhooks/pi-bellwether/herdr-client";

import { ProcError } from "./errors.ts";
import type { InputValue as AckInput, OutputValue as AckOutput } from "./vendor/rat-king-lexicon/mailbox.ack.ts";
import type { InputValue as SendInput, OutputValue as SendOutput } from "./vendor/rat-king-lexicon/mailbox.send.ts";
import type { ParamsValue as ListInput, OutputValue as ListOutput } from "./vendor/rat-king-lexicon/mailbox.list.ts";
import type { DeliveryStateKnown as KnownDeliveryState } from "./vendor/rat-king-lexicon/defs.ts";
import type { MainValue as Lease } from "./vendor/rat-king-lexicon/runtime.lease.ts";
type LeaseFence = Pick<Lease, "did" | "leaseId" | "generation">;

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

export interface PaneCloseNotice {
  readonly paneId: string;
  readonly terminalId?: string;
  readonly reason: string;
}

/** Undefined means no synchronous acknowledgement; [] means supported, with no matches. */
export type EmitPaneClose = (notice: PaneCloseNotice) => readonly string[] | undefined;
export const noEmitPaneClose: EmitPaneClose = () => undefined;

/** Bellwether owns retirement; Muster only emits the supported bus contract. */
export function createEmitPaneClose(events: { emit(event: string, payload: unknown): void }): EmitPaneClose {
  return (notice) => {
    let retired: readonly string[] | undefined;
    events.emit("bellwether/pane-close/v1", {
      ...notice,
      reply: (value: unknown) => {
        if (typeof value === "object" && value !== null && "retired" in value &&
          Array.isArray(value.retired) && value.retired.every((id: unknown) => typeof id === "string")) {
          retired = [...value.retired];
        }
      },
    });
    return retired;
  };
}

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
  /** Optional test seam; absent uses the live OS sample at wait time. */
  readonly startupLoad?: () => { readonly load: number; readonly cpus: number };
  readonly emitPaneClose: EmitPaneClose;
  /** Injection seams; live config and forwards are resolved only by tools. */
  readonly machines?: unknown;
  readonly remoteHerdr?: (name: string, machine: import("./domain.ts").MachineConfig) => Effect.Effect<HerdrClient, ProcError>;
}

export class MusterEnv extends Context.Service<MusterEnv, EnvShape>()("muster/Env") {}

export type OutboxStatus = "sent" | "queued" | "rejected" | "blocked" | "failed" | "unavailable";

export interface IntercomTransport {
  readonly send: (to: string, message: string) => Effect.Effect<{ readonly status: OutboxStatus; readonly detail?: string; readonly id?: string }>;
  /** Live intercom session ids, or undefined when pi-intercom is absent or disconnected. */
  readonly sessions: () => Effect.Effect<readonly string[] | undefined>;
}

export type CommsAddress =
  | { readonly kind: "alias"; readonly project: string; readonly row: string }
  | { readonly kind: "did"; readonly did: `did:${string}` }
  | { readonly kind: "session"; readonly id: string };
export type CommsTarget = CommsAddress | string;
export interface CommsLease {
  readonly address: CommsAddress;
  readonly session: string;
  readonly expiresAt?: string;
}
export type DeliveryStatus = KnownDeliveryState;
/** Private authority, not a public record or mailbox endpoint. */
export interface LeaseAuthorityShape {
  readonly acquire: (request: Pick<Lease, "did" | "harness" | "expiresAt">) => Effect.Effect<Lease, CommsError>;
  readonly resolve: (did: Lease["did"]) => Effect.Effect<Lease, CommsError>;
  readonly release: (fence: LeaseFence) => Effect.Effect<void, CommsError>;
}
/** Typed XRPC seam only; no transport, auth or crypto implementation yet. */
export interface NetworkMailboxShape {
  readonly send: (input: SendInput) => Effect.Effect<SendOutput, CommsError>;
  readonly ack: (input: AckInput) => Effect.Effect<AckOutput, CommsError>;
  readonly list: (input: ListInput) => Effect.Effect<ListOutput, CommsError>;
}
export interface CommsDelivery {
  readonly status: DeliveryStatus; readonly detail?: string;
  readonly id?: string; readonly senderDid?: string; readonly recipientDid?: string; readonly seq?: number;
}
export class CommsError extends Error {
  readonly _tag: string = "CommsError";
}
export class Unsupported extends CommsError {
  override readonly _tag = "Unsupported";
  override readonly name = "Unsupported";
}
export interface CommsShape {
  readonly mode?: () => Effect.Effect<"intercom" | "network", CommsError>;
  /** Explicit intercom path, including reported network-failure fallback. */
  readonly relay?: CommsShape["send"];
  readonly postOwner?: (to: string, item: import("./domain.ts").OwnerItem) => Effect.Effect<CommsDelivery>;
  readonly consume?: (receive: (message: import("./domain.ts").NetworkPayload) => Effect.Effect<void, CommsError>) => Effect.Effect<void, CommsError>;
  readonly send: (to: CommsTarget, message: string) => Effect.Effect<CommsDelivery>;
  readonly ask: (to: CommsTarget, message: string, options: { readonly timeoutMs: number }) => Effect.Effect<CommsDelivery, CommsError>;
  readonly reply: (id: string, message: string) => Effect.Effect<CommsDelivery, CommsError>;
  readonly wake: (to: CommsTarget) => Effect.Effect<{ readonly woke: boolean; readonly reason?: string }, CommsError>;
  readonly resolve: (identity: CommsTarget) => Effect.Effect<CommsLease, CommsError>;
  readonly sessions: () => Effect.Effect<readonly string[] | undefined, CommsError>;
}
export class Comms extends Context.Service<Comms, CommsShape>()("muster/Comms") {}

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
