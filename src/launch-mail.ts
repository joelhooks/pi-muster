import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { Project } from "./domain.ts";
import { LAUNCHER_NAME, rowRatkingName } from "./comms-ratking.ts";
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

/**
 * One plain mail from muster/launcher. CLI exit 0 with ok:true is sent; anything else is a reason the caller
 * appends to the JSONL fallback. Exit 3 is "uncertain": never resend, and this function sends exactly once.
 */
export const sendLaunchMail = (options: { readonly cli: string; readonly cwd: string; readonly to: string; readonly kind: "action" | "blocked"; readonly title: string; readonly body: string; readonly lane: string; readonly log: string }) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const summary = `${options.kind} ${LAUNCHER_NAME} · ${options.title}`.replace(/\s+/g, " ").slice(0, 280);
    const body = `${options.body}\n\nlane ${options.lane || "-"} · refs ${options.log}`;
    const args = ["-u", "RATKING_NAME", "node", options.cli, "send", "--as", LAUNCHER_NAME, "--to", options.to, "--summary", summary, "--body", body, "--json"];
    const result = yield* proc.run("env", args, { cwd: options.cwd, timeoutMs: SEND_TIMEOUT_MS }).pipe(Effect.result);
    if (result._tag === "Failure") return { sent: false, reason: `send failed: ${result.failure.message}` } as LaunchMailResult;
    const { code, stdout, stderr } = result.success;
    if (code !== 0) return { sent: false, reason: `ratking send exited ${code}${code === 3 ? " (uncertain, not retried)" : ""}: ${(stderr || stdout).trim().slice(-200)}` } as LaunchMailResult;
    try {
      if ((JSON.parse(stdout) as { ok?: unknown }).ok === true) return { sent: true } as LaunchMailResult;
    } catch { /* fall through */ }
    return { sent: false, reason: "ratking send output was not ok:true" } as LaunchMailResult;
  });
