import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emptyReceipt, exitCode, receiptLine, validateOriginalCommand, wakeDeadlineMs, WAKE_MODEL_ERROR, WAKE_READINESS_GRACE_MS, WAKE_WRAPPER_TERM_GRACE_MS } from "./muster-restore-args.mjs";

const command = validateOriginalCommand(process.env.SSH_ORIGINAL_COMMAND ?? "");

function runChild({ request, argv }) {
  const env = { ...process.env, MUSTER_WAKE_PROGRESS: "1" };
  delete env.SSH_ORIGINAL_COMMAND;
  const fallback = emptyReceipt("failed", "muster-restore exited without a valid receipt", request.name, request.messageId);
  const keys = Object.keys(fallback);
  const parse = output => {
    if (!output.endsWith("\n") || output.indexOf("\n") !== output.length - 1) return null;
    try {
      const got = JSON.parse(output);
      return ["restored", "alreadyLive", "refused", "failed"].includes(got.result) &&
        Object.keys(got).length === keys.length && keys.every(key => Object.hasOwn(got, key)) &&
        got.name === request.name && got.messageId === request.messageId &&
        ["project", "row", "machine", "session", "pane", "reason"].every(key => got[key] === null || typeof got[key] === "string") &&
        typeof got.ready === "boolean" && typeof got.receiptSaved === "boolean" &&
        (got.result === "refused" ? typeof got.permanent === "boolean" : got.permanent === null) ? got : null;
    } catch { return null; }
  };
  const bin = fileURLToPath(new URL("muster-restore-main.mjs", import.meta.url));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [bin, ...argv], {
      shell: false, detached: true, stdio: ["ignore", "pipe", "inherit", "pipe"], env,
    });
    const signalGroup = signal => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== "ESRCH") console.error("muster-restore-ssh: could not stop its launch process group");
      }
    };
    let output = "", progress = "", timedOut = false, overflow = false, escalate;
    const terminate = () => {
      if (escalate) return;
      signalGroup("SIGTERM");
      escalate = setTimeout(() => {
        signalGroup("SIGKILL");
        child.stdout.destroy();
        child.stdio[3].destroy();
      }, WAKE_WRAPPER_TERM_GRACE_MS);
    };
    const collect = (stream, append) => {
      stream.setEncoding("utf8");
      stream.on("error", () => {});
      stream.on("data", chunk => {
        if (!overflow && append(chunk) > 64 * 1024) { overflow = true; terminate(); }
      });
    };
    collect(child.stdout, chunk => (output += chunk).length);
    collect(child.stdio[3], chunk => (progress += chunk).length);
    const budget = wakeDeadlineMs(env) + (request.dryRun ? 0 : WAKE_READINESS_GRACE_MS) + WAKE_WRAPPER_TERM_GRACE_MS;
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, budget);
    child.once("error", () => {}); // Spawn errors are followed by close.
    child.once("close", code => {
      clearTimeout(timeout);
      // A parent can exit on TERM while a descendant ignores it. Let the group escalation finish.
      if (escalate) {
        try { process.kill(-child.pid, 0); } catch (error) { if (error.code === "ESRCH") clearTimeout(escalate); }
      }
      const got = !overflow && parse(output);
      const issued = parse(progress);
      resolve(got && exitCode(got) === code && !(issued && got.result === "failed" && got.reason !== WAKE_MODEL_ERROR) ? got :
        issued?.result === "restored" ? issued : timedOut ? { ...fallback, reason: "deadline" } : fallback);
    });
  });
}

let receipt;
try {
  receipt = command.ok ? await runChild(command) : command.receipt;
} catch {
  receipt = emptyReceipt("failed", "muster-restore exited without a valid receipt", command.request?.name, command.request?.messageId);
}
writeSync(1, receiptLine(receipt));
process.exitCode = exitCode(receipt);
