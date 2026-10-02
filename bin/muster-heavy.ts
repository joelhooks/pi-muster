#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { exclusiveRequest, heavyStatus, tryAcquireHeavy } from "../src/heavy-lock.ts";

const usage = "usage: muster-heavy status | muster-heavy [--exclusive] [--wait <seconds>] -- <command> [args...]";
const args = process.argv.slice(2);
const options = { home: homedir() };
if (args.length === 1 && args[0] === "status") {
  try {
    console.log(heavyStatus(options));
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
const deadline = Date.now() + waitSeconds * 1000;
let cleanup = () => {};
let child: ReturnType<typeof spawn> | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (child) child.kill(signal);
    else {
      cleanup();
      process.exit(128);
    }
  });
}
process.on("exit", () => cleanup());
try {
  const request = exclusive ? exclusiveRequest(options, command.join(" ")) : undefined;
  cleanup = request?.release ?? cleanup;
  const attempt = () => request ? request.attempt() : tryAcquireHeavy(options, command.join(" "));
  let acquired = attempt();
  while (!acquired.ok && Date.now() < deadline) {
    console.error(`muster-heavy: waiting, ${acquired.reason}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, deadline - Date.now()))));
    acquired = attempt();
  }
  if (!acquired.ok) {
    console.error(`muster-heavy: busy, ${acquired.reason}`);
    cleanup();
    process.exit(75);
  }
  cleanup = acquired.release;
  child = spawn(command[0] as string, command.slice(1), { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    cleanup();
    process.exit(code ?? (signal ? 128 : 1));
  });
  child.on("error", (error) => {
    cleanup();
    console.error(`muster-heavy: ${error.message}`);
    process.exit(127);
  });
} catch (error) {
  cleanup();
  console.error(`muster-heavy: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
