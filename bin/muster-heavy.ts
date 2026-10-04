#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { enqueueHeavy, ExclusiveRefused, exclusiveRequest, heavyQueueState, heavySnapshot, heavyStatus, reapExclusive, tryAcquireHeavy, waitAge } from "../src/heavy-lock.ts";
import type { HeavyOptions } from "../src/heavy-lock.ts";

const usage = "usage: muster-heavy status [--json] [--reap] | muster-heavy [--exclusive] [--wait <seconds>] -- <command> [args...]";

/** Explicit timer and cap options let tests exercise deadlines without long sleeps. */
export async function runHeavy(args: string[], options: HeavyOptions, timers = { setTimeout, clearTimeout }) {
  if (args[0] === "status" && args.slice(1).every((arg) => arg === "--json" || arg === "--reap")) {
    try {
      if (args.includes("--reap")) reapExclusive(options);
      console.log(args.includes("--json") ? JSON.stringify(heavySnapshot(options)) : heavyStatus(options));
      process.exit(0);
    } catch (error) {
      console.error(`muster-heavy: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  }
  const split = args.indexOf("--");
  let waitSeconds = 0;
  let exclusive = false;
  let valid = split >= 0 && split < args.length - 1;
  for (let i = 0; i < split; i++) {
    if (args[i] === "--exclusive" && !exclusive) exclusive = true;
    else if (args[i] === "--wait" && i + 1 < split) {
      waitSeconds = Number(args[++i]);
      valid &&= Number.isFinite(waitSeconds) && waitSeconds >= 0;
    } else valid = false;
  }
  if (!valid) {
    console.error(usage);
    process.exit(2);
  }
  const command = args.slice(split + 1);
  const now = options.now ?? Date.now;
  const deadline = now() + waitSeconds * 1000;
  let ticket: ReturnType<typeof enqueueHeavy> | undefined;
  let release = () => {};
  const cleanup = () => { ticket?.release(); release(); };
  let child: ReturnType<typeof spawn> | undefined;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let capped = false;
  const signalChild = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    try { if (exclusive) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  const finish = (code: number): never => {
    if (capTimer) timers.clearTimeout(capTimer);
    if (killTimer) timers.clearTimeout(killTimer);
    cleanup();
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (child) signalChild(signal);
      else finish(128);
    });
  }
  process.on("exit", () => cleanup());
  try {
    const request = exclusive ? exclusiveRequest(options, command.join(" "), () => ticket?.name) : undefined;
    release = request?.release ?? release;
    const attempt = () => request ? request.attempt() : tryAcquireHeavy(options, command.join(" "), ticket?.name);
    let acquired = attempt();
    if (!acquired.ok && waitSeconds > 0) ticket = enqueueHeavy(options, command.join(" "), exclusive ? "exclusive" : "slot");
    while (!acquired.ok && now() < deadline) {
      const queue = heavyQueueState(options, ticket?.name);
      console.error(`muster-heavy: waiting: position ${queue.own?.position ?? queue.rows.length + 1} of ${queue.rows.length}, ${waitAge(queue.own?.ageSeconds ?? null)}; ${acquired.reason}`);
      const pollMs = queue.older < Math.max(1, queue.freeSlots) ? 1000 : 5000;
      await new Promise((resolve) => timers.setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - now()))));
      acquired = attempt();
    }
    if (!acquired.ok) {
      console.error(`muster-heavy: busy, ${acquired.reason}`);
      return finish(75);
    }
    ticket?.release();
    release = acquired.release;
    child = spawn(command[0] as string, command.slice(1), { stdio: "inherit", detached: exclusive });
    if (request) capTimer = timers.setTimeout(() => {
      capped = true;
      request.capped();
      signalChild("SIGTERM");
      // Leader exit does not prove descendants exited. Keep the fence through
      // escalation so a SIGTERM-resistant descendant cannot outlive the cap.
      killTimer = timers.setTimeout(() => {
        signalChild("SIGKILL");
        finish(124);
      }, 15_000);
    }, Math.max(0, request.capMs - (Date.now() - (request.acquiredAtMs ?? Date.now()))));
    child.on("exit", (code, signal) => {
      if (!capped) finish(code ?? (signal ? 128 : 1));
    });
    child.on("error", (error) => {
      console.error(`muster-heavy: ${error.message}`);
      finish(capped ? 124 : 127);
    });
  } catch (error) {
    cleanup();
    console.error(`muster-heavy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof ExclusiveRefused ? 64 : 2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runHeavy(process.argv.slice(2), { home: homedir(), window: process.env.MUSTER_DEPLOY_WINDOW });
}
