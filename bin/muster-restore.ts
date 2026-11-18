import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyReceipt, exitCode, parseRestoreArgs, receiptLine, type RestoreReceipt } from "./muster-restore-args.mjs";

// This is a dedicated process. Reserve fd 1 for the receipt, including when a dependency logs.
process.stdout.write = process.stderr.write.bind(process.stderr);
const parsed = parseRestoreArgs(process.argv.slice(2));
let receipt: RestoreReceipt;
if (!parsed.ok) {
  receipt = parsed.receipt;
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  let issued: RestoreReceipt | undefined;
  try {
    const [{ createHerdrClient }, { Effect, Layer }, { RatkingMissing }, { Comms, Herdr, MusterEnv, Proc, makeLiveProc, noEmitPaneClose }, { wakeRestore }] = await Promise.all([
      import("@joelhooks/pi-bellwether/herdr-client"), import("effect"), import("../src/comms-ratking.ts"), import("../src/runtime.ts"), import("../src/wake-restore.ts"),
    ]);
    // Bellwether destroys each request socket before returning. The wake effect releases
    // its own SSH forward before returning, and Proc waits for each child to exit.
    const layer = Layer.mergeAll(
      Layer.succeed(Herdr)(createHerdrClient()), Layer.succeed(Proc)(makeLiveProc()), Layer.succeed(Comms)(RatkingMissing),
      Layer.succeed(MusterEnv)({ home: homedir(), sessionId: "headless-restore", paneId: undefined,
        musterRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        workerWorktree: process.env.MUSTER_WORKER_WORKTREE ?? "worker-worktree",
        now: () => new Date(), createId: randomUUID, sleep: ms => Effect.sleep(ms), emitPaneClose: noEmitPaneClose }),
    );
    const beforeInput = (pending: RestoreReceipt) => {
      if (process.env.MUSTER_WAKE_PROGRESS === "1") writeSync(3, receiptLine(pending));
      issued = pending;
    };
    receipt = await Effect.runPromise(wakeRestore(parsed.request, undefined, beforeInput).pipe(Effect.provide(layer)), { signal: controller.signal });
  } catch {
    receipt = issued ?? emptyReceipt("failed", controller.signal.aborted ? "deadline" : "headless restore failed", parsed.request.name, parsed.request.messageId);
  } finally { process.removeListener("SIGTERM", stop); }
}
writeSync(1, receiptLine(receipt));
process.exit(exitCode(receipt));
