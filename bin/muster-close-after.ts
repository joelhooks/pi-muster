#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrClient } from "@joelhooks/pi-bellwether/herdr-client";
import { Effect, Layer, Schema } from "effect";
import { PaneBinding } from "../src/domain.ts";
import { closeOwnedPane } from "../src/ops.ts";
import { Herdr, MusterEnv, noEmitPaneClose } from "../src/runtime.ts";

/** EPERM is not proof of death. Fail closed on any probe error other than ESRCH. */
export function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

export async function closeAfterExit(pid: number, binding: PaneBinding, deps: {
  alive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  close: () => Promise<unknown>;
  log: (message: string) => void;
}) {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("expected a positive Pi pid");
    if (!binding.openedByMuster) { deps.log("left adopted pane open"); return; }
    const deadline = deps.now() + 30_000;
    while (deps.alive(pid)) {
      if (deps.now() >= deadline) { deps.log(`Pi ${pid} still alive after 30s; left pane open`); return; }
      await deps.sleep(100);
    }
    deps.log(String(await deps.close()));
  } catch (error) { deps.log(`restart closer failed: ${String(error)}`); }
}

async function main() {
  const home = homedir();
  const state = join(home, ".local/state/muster");
  const log = (message: string) => {
    try { mkdirSync(state, { recursive: true }); appendFileSync(join(state, "close-after.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }); }
    catch { /* Logging cannot turn a safe refusal into a pane close. */ }
  };
  try {
    const [pidText, dir, rawBinding, reason] = process.argv.slice(2);
    if (!pidText || !dir || !rawBinding || !reason) throw new Error("usage: muster-close-after <pid> <projectDir> <bindingJson> <reason>");
    const binding = Schema.decodeUnknownSync(PaneBinding)(JSON.parse(rawBinding));
    const layer = Layer.mergeAll(
      Layer.succeed(Herdr)(createHerdrClient()),
      Layer.succeed(MusterEnv)({ home, sessionId: `closer-${process.pid}`, paneId: undefined, musterRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        workerWorktree: "", now: () => new Date(), createId: randomUUID, sleep: ms => Effect.sleep(ms), emitPaneClose: noEmitPaneClose }),
    );
    await closeAfterExit(Number(pidText), binding, { alive: pidAlive, now: Date.now,
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), log,
      close: () => Effect.runPromise(closeOwnedPane(binding, resolve(dir), reason).pipe(Effect.provide(layer))) });
  } catch (error) { log(`restart closer failed: ${String(error)}`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
