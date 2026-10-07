import { readFileSync, writeFileSync } from "node:fs";
import { decodeFirstTurnEntry } from "./domain.ts";

/** Freeze the inherited boundary before Pi starts. Never change the source journal.
 * A live caller can append tool results and its empty in-flight assistant between
 * counting the parent and --fork reading it. A private, immutable fork input keeps
 * that race out of the first-turn proof; real assistant content is never ignored.
 */
export function snapshotRestartSession(source: string, destination: string): void {
  const lines = readFileSync(source, "utf8").split("\n").filter(line => line.trim());
  // Fail closed on a partial append or unreadable entry. Preserve original bytes
  // of every retained entry, including tool blocks and parent links.
  const entries = lines.map(line => decodeFirstTurnEntry(JSON.parse(line)));
  if (entries[0]?.type !== "session") throw new Error("restart source has no session header");
  const last = entries.at(-1);
  if (last?.type === "message" && last.message?.role === "assistant"
    && Array.isArray(last.message.content) && last.message.content.length === 0
    && last.message.errorMessage === undefined && (last.message.stopReason === undefined || last.message.stopReason === "stop")) lines.pop();
  writeFileSync(destination, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
}
