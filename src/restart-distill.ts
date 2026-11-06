import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { decodeRestartDistillReceipt, decodeRestartToolEntry, type RestartDistillPolicy, type Role } from "./domain.ts";
import { InputError } from "./errors.ts";
import { agentGet } from "./herdr.ts";
import { forEachJsonlLine } from "./restart-snapshot.ts";
import { MusterEnv, must, Proc } from "./runtime.ts";

export const RESTART_DISTILL_TIMEOUT_MS = 600_000;
const SETTLE_MS = 2_000;
type DistillResult = { parentSessionFile: string; note?: string; detail?: string };

/** Herdr idle alone cannot prove that a persisted tool call has its result. Unknown/broken journals skip safely.
 * Conservative across branches: an unresolved historical call also keeps the full snapshot. */
export function restartToolsSettled(file: string): boolean {
  const pending = new Set<string>();
  let unidentified = false;
  forEachJsonlLine(file, line => {
    const { message } = decodeRestartToolEntry(JSON.parse(line));
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "toolCall") {
        if (block.id) pending.add(block.id);
        else unidentified = true;
      }
    }
    if (message?.role === "toolResult" && message.toolCallId) pending.delete(message.toolCallId);
  });
  return !unidentified && pending.size === 0;
}

const inspect = <A>(read: () => A) => Effect.try({ try: read, catch: error => new InputError({ message: String(error) }) });
const sha256 = (file: string) => Effect.tryPromise({
  try: async () => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  },
  catch: error => new InputError({ message: String(error) }),
});

/** A one-shot selection, not a lifecycle: off -> snapshot; eligible -> command -> validated child, else snapshot.
 * The command is a trusted, explicitly configured local CLI. It must treat both source journals as read-only.
 * No cadence, restart decision, or catalog mutation belongs here. */
export const restartDistill = (input: {
  policy: RestartDistillPolicy | null | undefined;
  role: Role;
  remote: boolean;
  self: boolean;
  paneId: string;
  sessionFile: string;
  snapshot: string;
  childOut: string;
  cwd: string;
}) => {
  const fallback = (reason: string): DistillResult => ({ parentSessionFile: input.snapshot, note: `distill skipped: ${reason}` });
  if (!input.policy) return Effect.succeed<DistillResult>({ parentSessionFile: input.snapshot });
  const policy = input.policy;
  return Effect.gen(function* () {
    if (!["desk", "hawk", "boss"].includes(input.role)) return fallback(`role ${input.role} is not standing`);
    if (input.remote) return fallback("distill: local rows only");
    const parent = yield* inspect(() => lstatSync(input.snapshot));
    const minMb = policy.minMb ?? 64;
    if (parent.size < minMb * 1024 * 1024) return fallback(`snapshot ${Math.round(parent.size / 1024 / 1024)} MiB < ${minMb} MiB`);
    // Self-restart quits at agent_end; its own in-flight restart tool is explicitly exempt.
    if (!input.self) {
      const env = yield* MusterEnv;
      const first = yield* agentGet(input.paneId);
      if (first.agent_status !== "idle" || first.launch_pending || !(yield* inspect(() => restartToolsSettled(input.sessionFile)))) return fallback("not settled idle (first read or tool call in flight)");
      yield* env.sleep(SETTLE_MS);
      const second = yield* agentGet(input.paneId);
      if (second.agent_status !== "idle" || second.launch_pending || second.state_change_seq !== first.state_change_seq || !(yield* inspect(() => restartToolsSettled(input.sessionFile)))) return fallback("not settled idle (second read or tool call in flight)");
    }
    const parentSha256 = yield* sha256(input.snapshot);
    const proc = yield* Proc;
    const found = yield* proc.run("sh", ["-c", "command -v muster-heavy"], { cwd: input.cwd, timeoutMs: 5_000 }).pipe(Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })));
    const heavy = found.code === 0 ? found.stdout.trim() : "";
    const [command, ...args] = policy.command;
    if (!command) return fallback("empty command");
    const argv = [...args, input.snapshot, input.childOut];
    const stdout = yield* must(heavy || command, heavy ? ["--wait", "600", "--", command, ...argv] : argv, { cwd: input.cwd, timeoutMs: RESTART_DISTILL_TIMEOUT_MS });
    const receipt = yield* inspect(() => decodeRestartDistillReceipt(JSON.parse(stdout)));
    if (!receipt.pivotAllowed) return fallback("pivotAllowed false");
    const minCut = policy.minCut ?? 0.5;
    const cut = 1 - receipt.childBytes / receipt.parentBytes;
    if (cut < minCut) return fallback(`cut ${cut} < ${minCut}`);
    if (receipt.parentBytes !== parent.size || receipt.parentSha256.toLowerCase() !== parentSha256) return fallback("receipt parent identity mismatch");
    if (resolve(receipt.child) !== resolve(input.childOut) || resolve(receipt.child) === resolve(input.snapshot) || resolve(receipt.child) === resolve(input.sessionFile)) return fallback("receipt child is not the requested output");
    const child = yield* inspect(() => lstatSync(receipt.child));
    if (!child.isFile() || child.size === 0 || child.nlink !== 1 || (child.dev === parent.dev && child.ino === parent.ino)) return fallback("child is not a non-empty independent regular file");
    if (child.size !== receipt.childBytes) return fallback("receipt child size mismatch");
    return { parentSessionFile: resolve(receipt.child), detail: `distilled ${receipt.parentBytes} -> ${receipt.childBytes}` } satisfies DistillResult;
  }).pipe(Effect.catch(error => Effect.succeed(fallback(error.message))));
};
