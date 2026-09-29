#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { describeHolder, heavyLockPath, tryAcquire } from "../src/heavy-lock.ts";

const usage = "usage: muster-heavy [--wait <seconds>] -- <command> [args...]";
const args = process.argv.slice(2);
const split = args.indexOf("--");
if (split < 0 || split === args.length - 1) {
  console.error(usage);
  process.exit(2);
}
const waitIndex = args.indexOf("--wait");
const waitSeconds = waitIndex >= 0 && waitIndex < split ? Number(args[waitIndex + 1]) : 0;
const command = args.slice(split + 1);
const lock = heavyLockPath(homedir());
const deadline = Date.now() + (Number.isFinite(waitSeconds) ? waitSeconds : 0) * 1000;

let acquired = tryAcquire(lock, command.join(" "));
while (!acquired.ok && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  acquired = tryAcquire(lock, command.join(" "));
}
if (!acquired.ok) {
  console.error(`muster-heavy: busy, ${describeHolder(acquired.holder)}`);
  process.exit(75);
}
const { release } = acquired;
const child = spawn(command[0] as string, command.slice(1), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  release();
  process.exit(code ?? (signal ? 128 : 1));
});
child.on("error", (error) => {
  release();
  console.error(`muster-heavy: ${error.message}`);
  process.exit(127);
});
