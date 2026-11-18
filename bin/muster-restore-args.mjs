export const emptyReceipt = (result, reason, name = null, messageId = null) => ({
  result, name, project: null, row: null, machine: null, session: null, pane: null, reason, messageId,
  ready: false, receiptSaved: false, permanent: result === "refused" ? false : null,
});

export const exitCode = ({ result }) => result === "refused" ? 2 : result === "failed" ? 1 : 0;
export const receiptLine = receipt => `${JSON.stringify(receipt)}\n`;

export const WAKE_MODEL_ERROR = "Pi reported a model error";
export const WAKE_READINESS_GRACE_MS = 30_000;
export const WAKE_WRAPPER_TERM_GRACE_MS = 5_000;

export function wakeDeadlineMs(env = process.env) {
  const ms = Number(env.MUSTER_WAKE_DEADLINE_MS);
  return Number.isInteger(ms) && ms >= 1 && ms <= 120_000 ? ms : 120_000;
}

const validName = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9_-]{0,31}$/;
const validId = /^[A-Za-z0-9_-]{1,64}$/;
const safeToken = /^[A-Za-z0-9_./:@=-]{1,120}$/;
// Use a negative character class, not `$`, which can match before a final newline.
const unsafeCommand = /[^A-Za-z0-9_./:@= -]/;

export function parseRestoreArgs(argv, forced = false) {
  const flags = new Set();
  let name = null, messageId = null, reason = null, minutes = 15, dryRun = false;
  const refuse = why => ({ ok: false, receipt: emptyReceipt("refused", why, name, messageId) });
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--name", "--message-id", "--reason", "--exit-when-drained", "--dry-run"].includes(flag)) return refuse("unknown flag");
    if (flags.has(flag)) return refuse(`repeated ${flag}`);
    flags.add(flag);
    if (flag === "--dry-run") { dryRun = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith("--")) return refuse(`missing value for ${flag}`);
    switch (flag) {
      case "--name":
        if (!validName.test(value) || value.trim() !== value) return refuse("invalid --name (expected project/row)");
        name = value;
        break;
      case "--message-id":
        if (!validId.test(value) || value.trim() !== value) return refuse("invalid --message-id");
        messageId = value;
        break;
      case "--reason":
        if (value.length > 120 || (forced ? !safeToken.test(value) : !/^[\x20-\x7e]+$/.test(value) || value.trim() !== value)) return refuse("invalid --reason (at most 120 printable characters; SSH requires one safe token)");
        reason = value;
        break;
      case "--exit-when-drained":
        minutes = Number(value);
        if (!/^\d+$/.test(value) || value.trim() !== value || minutes < 1 || minutes > 1440) return refuse("--exit-when-drained must be an integer from 1 to 1440");
        break;
    }
  }
  if (!name) return refuse("missing --name");
  if (!messageId && !dryRun) return refuse("missing --message-id");
  return { ok: true, request: { name, messageId, reason, minutes, dryRun } };
}

export function validateOriginalCommand(command) {
  const refuse = reason => ({ ok: false, receipt: emptyReceipt("refused", reason) });
  if (unsafeCommand.test(command)) return refuse("SSH command contains a forbidden character");
  const [program, ...argv] = command.trim().split(/ +/);
  if (program !== "muster-restore") return refuse("SSH command must be muster-restore");
  const parsed = parseRestoreArgs(argv, true);
  return parsed.ok ? { ...parsed, argv } : parsed;
}
