import { writeSync } from "node:fs";
import { emptyReceipt, parseRestoreArgs, receiptLine } from "./muster-restore-args.mjs";

process.stdout.write = process.stderr.write.bind(process.stderr);
try {
  const { register } = await import("tsx/esm/api");
  register();
  await import("./muster-restore.ts");
} catch {
  const parsed = parseRestoreArgs(process.argv.slice(2));
  const request = parsed.ok ? parsed.request : parsed.receipt;
  writeSync(1, receiptLine(emptyReceipt("failed", "muster-restore loader unavailable", request.name, request.messageId)));
  process.exit(1);
}
