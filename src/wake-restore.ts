import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber, Option } from "effect";
import { emptyReceipt, wakeDeadlineMs, WAKE_MODEL_ERROR, WAKE_READINESS_GRACE_MS, type RestoreReceipt, type RestoreRequest } from "../bin/muster-restore-args.mjs";
import { decodeWakeAttempts, decodeWakeReceipt, type AgentRow, type Project } from "./domain.ts";
import { InputError } from "./errors.ts";
import { inspectWakeRestore, noticeWakeRestore, restoreWakeRow, WakeRestoreStop } from "./ops.ts";
import { readRegistry } from "./registry.ts";
import { localWakeEnabled, withMachineLaunchLock } from "./remote.ts";
import { MusterEnv, Proc } from "./runtime.ts";
import { LAUNCHER_NAME, ownerName, registeredCatalogs, rowRatkingName, subscribedSwitchboards } from "./comms-ratking.ts";
import { launchOwnerRatkingName, ratkingCliPath } from "./launch-mail.ts";
import { load } from "./store.ts";

export const wakeReceiptDir = (home: string) => join(home, ".local/state/muster/wake-receipts");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const privateFile = (path: string, uid: number | undefined) => {
  const info = lstatSync(path);
  return info.isFile() && (uid === undefined || info.uid === uid) && (info.mode & 0o777) === 0o600;
};
const atomicWrite = (path: string, value: unknown) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, path); } catch (error) {
    try { unlinkSync(temporary); } catch { /* original error stands */ }
    throw error;
  }
};

const recentAttempts = (path: string, now: number) => {
  try {
    if (!privateFile(path, process.getuid?.())) throw new Error("wake rate file is not private");
    return decodeWakeAttempts(JSON.parse(readFileSync(path, "utf8"))).filter(at => now - at < 60 * 60_000);
  } catch (error) { if (missing(error)) return []; throw error; }
};

const quietWakeCopy = (project: Project, row: AgentRow, result: RestoreReceipt, label: string) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const catalogs = [project, ...registeredCatalogs(env.home)];
  const resolved = ownerName(row.owner, { catalogs, recorded: row.ownerName, switchboards: subscribedSwitchboards(env.home) }) ?? launchOwnerRatkingName(row.owner, catalogs);
  const owner = row.owner === row.sessionId || resolved === rowRatkingName(project, row) ? "switchboard" : resolved;
  if (!owner) return yield* new InputError({ message: "wake owner has no recorded Rat King name" });
  const proc = yield* Proc;
  const sent = yield* proc.run("env", ["-u", "RATKING_NAME", process.execPath, ratkingCliPath(process.env, env.home), "send", "--as", LAUNCHER_NAME, "--to", owner,
    "--quiet", "--summary", `Desk wake ${result.result}: ${project.slug}/${row.name}`, "--body", `Caller: desk-host wake key. ${label}. Result: ${result.result}.`, "--json"], { cwd: project.dir, timeoutMs: 5_000 });
  if (sent.code !== 0) return yield* new InputError({ message: "quiet wake owner copy was not sent" });
}).pipe(Effect.catchCause(() => Effect.sync(() => console.error("muster-restore: could not send quiet wake owner copy"))));

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
  const root = wakeReceiptDir(env.home);
  const reason = `wake${messageId ? ` ${messageId}` : ""}${requestedReason ? ` (waker-supplied reason: ${requestedReason})` : ""}`;
  const attemptRow = (found: { project: Project; row: AgentRow }, ratePath?: string) => Effect.gen(function* () {
    const { project, row: original } = found;
    // A local refusal or live probe must not leave an owner notice behind.
    if (original.machine !== "local") notice.target = found;
    const base = { ...failed(""), project: slug, row: rowName, machine: original.machine, session: original.sessionId };
    return yield* Effect.gen(function* () {
      const inspected = yield* inspectWakeRestore(project, original, { act: !dryRun });
      if (dryRun) return answer({ ...base, result: "restored", reason });
      const row = original.machine === "local" ? inspected.row : original;
      // Even if the flag changes between lookup and inspection, never launch a local wake without its rate lock.
      if (row.machine === "local" && !ratePath) return answer({ ...base, reason: "local wake admission changed; probe again" });
      notice.target = { project, row };
      const now = env.now().getTime();
      const history = ratePath ? yield* Effect.try({ try: () => recentAttempts(ratePath, now), catch: () => new WakeRestoreStop({ result: "failed", message: "could not read wake rate history" }) }) : [];
      if (history.length >= 4 || history.some(at => now - at < 10 * 60_000)) return answer({ ...base, reason: "rate" });
      const charge = ratePath ? Effect.try({ try: () => atomicWrite(ratePath, [...history, env.now().getTime()]), catch: () => new WakeRestoreStop({ result: "failed", message: "could not save wake rate history" }) }) : undefined;
      const restored = yield* restoreWakeRow(project, row, reason, minutes, launching => {
        const pending: RestoreReceipt = { ...base, result: "restored", reason, session: launching.sessionId, pane: launching.pane?.paneId ?? null };
        onInput(pending);
        issued = pending;
        notice.target = { project, row: launching };
      }, charge).pipe(Effect.provideService(MusterEnv, {
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
        : answer({ ...base, result: "failed", reason: `${original.machine === "local" ? "local" : "remote"} restore did not finish; check the row in project_status` }))),
    );
  });
  const attempt = Effect.gen(function* () {
    const found = yield* lookup;
    if (!found) return answer(refused);
    if (dryRun || found.row.machine !== "local" || !localWakeEnabled(env.home, env.wakeConfigHome)) return yield* attemptRow(found);
    const digest = createHash("sha256").update(name).digest("hex");
    return yield* withMachineLaunchLock("wake-row", Effect.gen(function* () {
      const current = yield* lookup;
      if (!current || current.row.machine !== "local") return answer(failed("row changed during wake; probe again"));
      return yield* attemptRow(current, join(root, `rate-${digest}.json`));
    }), undefined, Math.min(10_000, remaining()), join(root, ".locks", `row-${digest}`));
  }).pipe(Effect.catchCause(() => Effect.succeed(stopped("could not read or lock the wake registry or row"))));
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
      if (!privateFile(path, uid)) return failed("wake receipt is not a private regular file owned by this user");
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
      const saved = { ...receipt, receiptSaved: true };
      try {
        atomicWrite(path, saved);
        return saved;
      } catch {
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
  if (!dryRun && notice.target && (receipt.result === "failed" || receipt.result === "restored")) {
    const current = issued ? yield* lookup.pipe(Effect.catchCause(() => Effect.succeed(null))) : null;
    const target = current && current.row.pane?.paneId === issued?.pane ? current : notice.target;
    const audit = target.row.machine === "local" && receipt.reason !== reason ? `${reason}: ${receipt.reason ?? receipt.result}` : receipt.reason ?? reason;
    yield* noticeWakeRestore(target.project, target.row, audit, receipt.result === "restored", receipt.ready);
    if (notice.target.row.machine === "local") yield* quietWakeCopy(notice.target.project, notice.target.row, receipt, reason);
  }
  return receipt;
});
