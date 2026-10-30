import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { Project } from "./domain.ts";
import { LAUNCHER_NAME, SEND_RETRY_DELAYS_MS, rowRatkingName } from "./comms-ratking.ts";
import { sessionChain } from "./ops.ts";
import { Proc } from "./runtime.ts";

const SEND_TIMEOUT_MS = 30_000;

export const ratkingCliPath = (env: Readonly<Record<string, string | undefined>>, home = homedir()) =>
  env.MUSTER_RATKING_CLI || join(home, "Code/joelhooks/rat-king/apps/ratking-cli/bin/ratking.ts");

/** The owner's Rat King name: the open row whose session chain includes the owner session. An owner that restarted
 * while the launch ran still gets the receipt: the name follows the row to its new session. */
export function launchOwnerRatkingName(owner: string, catalogs: readonly Project[]): string | undefined {
  for (const project of catalogs) {
    const row = project.agents.find(row => row.state !== "closed" && sessionChain(row).includes(owner));
    if (row) return rowRatkingName(project, row);
  }
  return undefined;
}

export type LaunchMailResult = { readonly sent: true } | { readonly sent: false; readonly reason?: string };
type Attempt = LaunchMailResult & { readonly retry?: boolean };

/**
 * One plain mail from muster/launcher. CLI exit 0 with ok:true is sent; anything else is a reason the caller
 * appends to the JSONL fallback. A generic CLI failure is tried again (Switchboard, 3mz4dicaynv6b); a refusal (exit 2),
 * an uncertain send (exit 3), a timeout or unreadable output is never resent.
 */
export const sendLaunchMail = (options: { readonly cli: string; readonly cwd: string; readonly to: string; readonly kind: "action" | "blocked"; readonly title: string; readonly body: string; readonly lane: string; readonly log: string; readonly retryDelaysMs?: readonly number[] }) =>
  Effect.gen(function* () {
    const delays = options.retryDelaysMs ?? SEND_RETRY_DELAYS_MS;
    let result = yield* launchMailAttempt(options);
    for (const delay of delays) {
      if (!result.retry) break;
      yield* Effect.sleep(delay);
      result = yield* launchMailAttempt(options);
    }
    if (result.sent) return { sent: true } as LaunchMailResult;
    return { sent: false, reason: result.retry ? `${result.reason}; tried ${delays.length + 1} times` : result.reason } as LaunchMailResult;
  });

const launchMailAttempt = (options: { readonly cli: string; readonly cwd: string; readonly to: string; readonly kind: "action" | "blocked"; readonly title: string; readonly body: string; readonly lane: string; readonly log: string }) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const summary = `${options.kind} ${LAUNCHER_NAME} · ${options.title}`.replace(/\s+/g, " ").slice(0, 280);
    const body = `${options.body}\n\nlane ${options.lane || "-"} · refs ${options.log}`;
    const args = ["-u", "RATKING_NAME", "node", options.cli, "send", "--as", LAUNCHER_NAME, "--to", options.to, "--summary", summary, "--body", body, "--json"];
    const result = yield* proc.run("env", args, { cwd: options.cwd, timeoutMs: SEND_TIMEOUT_MS }).pipe(Effect.result);
    // A timed-out CLI may have sent; only a failure to start it is safe to repeat.
    if (result._tag === "Failure") return { sent: false, reason: `send failed: ${result.failure.message}`, retry: !/timed out/.test(result.failure.message) } as Attempt;
    const { code, stdout, stderr } = result.success;
    if (code !== 0) return { sent: false, reason: `ratking send exited ${code}${code === 3 ? " (uncertain, not retried)" : ""}: ${(stderr || stdout).trim().slice(-200)}`, retry: code !== 2 && code !== 3 } as Attempt;
    try {
      if ((JSON.parse(stdout) as { ok?: unknown }).ok === true) return { sent: true } as Attempt;
    } catch { /* fall through */ }
    return { sent: false, reason: "ratking send output was not ok:true" } as Attempt;
  });
