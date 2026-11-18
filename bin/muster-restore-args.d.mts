export interface RestoreReceipt {
  result: "restored" | "alreadyLive" | "refused" | "failed";
  name: string | null;
  project: string | null;
  row: string | null;
  machine: string | null;
  session: string | null;
  pane: string | null;
  reason: string | null;
  messageId: string | null;
  ready: boolean;
  receiptSaved: boolean;
  permanent: boolean | null;
}
export interface RestoreRequest {
  name: string;
  messageId: string | null;
  reason: string | null;
  minutes: number;
  dryRun: boolean;
}
type Refusal = { ok: false; receipt: RestoreReceipt };
type Parsed = { ok: true; request: RestoreRequest };
export function emptyReceipt(result: RestoreReceipt["result"], reason: string | null, name?: string | null, messageId?: string | null): RestoreReceipt;
export function exitCode(receipt: Pick<RestoreReceipt, "result">): 0 | 1 | 2;
export const WAKE_READINESS_GRACE_MS: number;
export const WAKE_WRAPPER_TERM_GRACE_MS: number;
export function wakeDeadlineMs(env?: NodeJS.ProcessEnv): number;
export function receiptLine(receipt: RestoreReceipt): string;
export function parseRestoreArgs(argv: readonly string[], forced?: boolean): Refusal | Parsed;
export function validateOriginalCommand(command: string): Refusal | (Parsed & { argv: string[] });
