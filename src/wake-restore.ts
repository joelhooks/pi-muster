import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber, Option } from "effect";
import { emptyReceipt, wakeDeadlineMs, WAKE_MODEL_ERROR, WAKE_READINESS_GRACE_MS, type RestoreReceipt, type RestoreRequest } from "../bin/muster-restore-args.mjs";
import { decodeWakeReceipt, type AgentRow, type Project } from "./domain.ts";
import { InputError } from "./errors.ts";
import { inspectWakeRestore, noticeWakeRestore, restoreWakeRow, WakeRestoreStop } from "./ops.ts";
import { readRegistry } from "./registry.ts";
import { withMachineLaunchLock } from "./remote.ts";
import { MusterEnv } from "./runtime.ts";
import { load } from "./store.ts";

export const wakeReceiptDir = (home: string) => join(home, ".local/state/muster/wake-receipts");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export const wakeRestore = (request: RestoreRequest, deadlineMs = wakeDeadlineMs(), onInput: (receipt: RestoreReceipt) => void = () => {}, graceMs = WAKE_READINESS_GRACE_MS) => Effect.gen(function* () {
  const startedAt = performance.now();
  const remaining = () => Math.max(0, deadlineMs - (performance.now() - startedAt));
  const env = yield* MusterEnv;
  const { name, messageId, dryRun, minutes, reason: requestedReason } = request;
  const slash = name.indexOf("/");
  const slug = name.slice(0, slash), rowName = name.slice(slash + 1);
  const refused = emptyReceipt("refused", "unknown name", name, messageId);
  const failed = (why: string) => emptyReceipt("failed", why, name, messageId);
  const answer = (receipt: RestoreReceipt, persist = false) => ({ receipt, persist });
  const lookup = Effect.gen(function* () {
    const entry = readRegistry(env.home).get(slug);
    if (!entry) return null;
    const project = yield* load(entry.dir).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)));
    if (project?.slug !== slug || project.agents.filter(row => row.name === rowName).length !== 1) return null;
    return { project, row: project.agents.find(row => row.name === rowName)! };
  });
  const notice: { target?: { project: Project; row: AgentRow } } = {};
  let issued: RestoreReceipt | undefined;
  const stopped = (reason: string) => issued ? answer(issued, true) : answer(failed(reason));
  const attempt = Effect.gen(function* () {
    const found = yield* lookup;
    if (!found) return answer(refused);
    notice.target = found;
    const { project, row } = found;
    const base = { ...failed(""), project: slug, row: rowName, machine: row.machine, session: row.sessionId };
    // Bastion, 2026-11-19: the waker's reason is untrusted caller text; label it wherever it lands.
    const reason = `wake${messageId ? ` ${messageId}` : ""}${requestedReason ? ` (waker-supplied reason: ${requestedReason})` : ""}`;
    return yield* Effect.gen(function* () {
      yield* inspectWakeRestore(project, row);
      if (dryRun) return answer({ ...base, result: "restored", reason });
      const restored = yield* restoreWakeRow(project, row, reason, minutes, launching => {
        const pending: RestoreReceipt = { ...base, result: "restored", reason, session: launching.sessionId, pane: launching.pane?.paneId ?? null };
        onInput(pending);
        issued = pending;
        notice.target = { project, row: launching };
      }).pipe(Effect.provideService(MusterEnv, {
        ...env, sessionId: row.owner, paneId: undefined,
      }));
      notice.target = { project, row: restored.row };
      return answer({ ...base, result: "restored", session: restored.row.sessionId, pane: restored.row.pane?.paneId ?? null, reason, ready: restored.readiness === "proven" }, true);
    }).pipe(
      // Remote commands and diagnostic tails can contain private values.
      Effect.catch(error => Effect.succeed(error instanceof WakeRestoreStop && error.message === WAKE_MODEL_ERROR
        ? answer({ ...base, result: "failed", reason: WAKE_MODEL_ERROR, pane: error.pane ?? null })
        : issued ? answer(issued, true) : error instanceof WakeRestoreStop
        ? answer({ ...base, result: error.result, reason: error.message, pane: error.pane ?? null, permanent: error.result === "refused" ? error.permanent === true : null }, error.result === "refused" && error.permanent === true)
        : answer({ ...base, result: "failed", reason: "remote restore did not finish; check the row in project_status" }))),
    );
  }).pipe(Effect.catchCause(() => Effect.succeed(stopped("could not read the wake registry or catalog"))));
  const boundedAttempt = Effect.gen(function* () {
    const budget = remaining();
    if (budget <= 0) return stopped("deadline");
    const job = yield* Effect.forkChild(attempt);
    const result = yield* Fiber.join(job).pipe(Effect.timeoutOption(budget));
    if (Option.isSome(result)) return result.value;
    if (issued) {
      const late = yield* Fiber.join(job).pipe(Effect.timeoutOption(graceMs));
      if (Option.isSome(late)) return late.value;
    }
    yield* Fiber.interrupt(job);
    return stopped("deadline");
  });
  const run = Effect.gen(function* () {
  if (dryRun) return (yield* boundedAttempt).receipt;
  if (!messageId) return emptyReceipt("refused", "missing --message-id", name);

  const root = wakeReceiptDir(env.home);
  const hash = createHash("sha256").update(messageId).digest("hex");
  const path = join(root, `${hash}.json`);
  const uid = process.getuid?.();
  const usable = yield* Effect.try({ try: () => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const info = lstatSync(root);
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) return false;
    if ((info.mode & 0o777) !== 0o700) chmodSync(root, 0o700);
    return true;
  }, catch: () => null }).pipe(Effect.orElseSucceed(() => false));
  if (!usable) return failed("wake receipt directory is not a usable private directory owned by this user");

  const readReceipt = () => {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== 0o600) return failed("wake receipt is not a private regular file owned by this user");
      const stored = decodeWakeReceipt(JSON.parse(readFileSync(path, "utf8")));
      if (stored.messageId !== messageId) return failed("wake receipt has the wrong message ID");
      // Ignore pre-release receipts for transient results.
      return stored.result === "restored" || (stored.result === "refused" && stored.permanent === true) ? stored : undefined;
    } catch (error) { return missing(error) ? undefined : failed("wake receipt is unreadable or corrupt"); }
  };
  const stored = readReceipt();
  if (stored) return stored;
  const busy = new InputError({ message: "wake in progress" });
  // Same-message callers share a lock keyed by the full digest. Other IDs still use the row's launch reservation.
  return yield* withMachineLaunchLock("wake", Effect.gen(function* () {
    const committed = readReceipt();
    if (committed) return committed;
    const { receipt, persist } = yield* boundedAttempt;
    if (persist) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      const saved = { ...receipt, receiptSaved: true };
      let created = false;
      try {
        writeFileSync(temporary, `${JSON.stringify(saved)}\n`, { mode: 0o600, flag: "wx" });
        created = true;
        renameSync(temporary, path);
        return saved;
      } catch {
        if (created) try { unlinkSync(temporary); } catch { /* Preserve the launch result. */ }
        console.error("muster-restore: could not save wake receipt");
      }
    }
    return receipt;
  }), undefined, Math.min(10_000, remaining()), join(root, ".locks", hash), () => busy).pipe(
    Effect.catch(error => Effect.succeed(error === busy
      ? readReceipt() ?? failed(remaining() <= 0 ? "deadline" : "wake in progress")
      : failed("could not lock wake receipt"))),
    Effect.catchCause(() => Effect.succeed(stopped("could not save wake receipt").receipt)),
  );
  });
  const receipt = yield* run;
  if (!dryRun && (receipt.result === "failed" || (receipt.result === "restored" && notice.target))) {
    const current = yield* lookup.pipe(Effect.catchCause(() => Effect.succeed(null)));
    const target = !issued || current?.row.pane?.paneId === issued.pane ? current ?? notice.target : notice.target;
    if (target) yield* noticeWakeRestore(target.project, target.row, receipt.reason ?? "wake", receipt.result === "restored", receipt.ready);
  }
  return receipt;
});
