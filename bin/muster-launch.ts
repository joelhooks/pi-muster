#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrClient } from "@joelhooks/pi-bellwether/herdr-client";
import { Effect, Layer } from "effect";
import { createComms, catalogCommsSender, catalogNetworkPeers } from "../src/comms.ts";
import { runLaunchJob } from "../src/ops.ts";
import { Comms, Herdr, MusterEnv, Proc, liveProc, noEmitPaneClose } from "../src/runtime.ts";

const [dir, id] = process.argv.slice(2);
if (!dir || !id || !process.env.MUSTER_OWNER) {
  console.error("usage: MUSTER_OWNER=<caller session> muster-launch <projectDir> <jobId>");
  process.exitCode = 2;
} else {
  const home = homedir();
  // The durable queue's mention facets wake its owner's existing reader. This process
  // owns no intercom extension bus and must not open a second outward transport.
  const comms = createComms({ events: { emit() {}, on() {} }, createId: randomUUID, home, projectDir: resolve(dir),
    adapterEnv: () => process.env.MUSTER_COMMS, networkConfig: () => process.env.MUSTER_NETWORK_CONFIG,
    followProjectPolicy: true, networkSender: () => catalogCommsSender(resolve(dir), process.env.MUSTER_OWNER!),
    networkPeers: () => catalogNetworkPeers(resolve(dir)) });
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
