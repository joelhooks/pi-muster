#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrClient } from "@joelhooks/pi-bellwether/herdr-client";
import { Effect, Layer } from "effect";
import { RatkingMissing } from "../src/comms-ratking.ts";
import { runLaunchJob } from "../src/ops.ts";
import { Comms, Herdr, MusterEnv, Proc, liveProc, noEmitPaneClose } from "../src/runtime.ts";

const [dir, id] = process.argv.slice(2);
if (!dir || !id || !process.env.MUSTER_OWNER) {
  console.error("usage: MUSTER_OWNER=<caller session> muster-launch <projectDir> <jobId>");
  process.exitCode = 2;
} else {
  const home = homedir();
  // The helper has no Pi bus and sends nothing. Briefs travel by argv; runLaunchJob
  // appends results to the owner's local queue, watched by its existing feed.
  const comms = RatkingMissing;
  const layer = Layer.mergeAll(
    Layer.succeed(Herdr)(createHerdrClient()), Layer.succeed(Proc)(liveProc), Layer.succeed(Comms)(comms),
    Layer.succeed(MusterEnv)({ home, sessionId: process.env.MUSTER_OWNER, paneId: process.env.MUSTER_LAUNCH_PANE || undefined,
      musterRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      workerWorktree: process.env.MUSTER_WORKER_WORKTREE ?? join(home, "Code/joelhooks/dark-wizard/scripts/worker-worktree.sh"),
      now: () => new Date(), createId: randomUUID, sleep: ms => Effect.sleep(ms), emitPaneClose: noEmitPaneClose }),
  );
  try { const result = await Effect.runPromise(runLaunchJob(resolve(dir), id).pipe(Effect.provide(layer))); console.log(result.body); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
