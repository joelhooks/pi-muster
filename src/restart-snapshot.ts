import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeFirstTurnEntry } from "./domain.ts";

/** Freeze the inherited boundary before Pi starts. Never change the source journal.
 * A live caller can append tool results and its empty in-flight assistant between
 * counting the parent and --fork reading it. A private, immutable fork input keeps
 * that race out of the first-turn proof; real assistant content is never ignored.
 */
export function snapshotRestartSession(source: string, destination: string, thinking?: string): void {
  const lines = readFileSync(source, "utf8").split("\n").filter(line => line.trim());
  // Fail closed on a partial append or unreadable entry. Preserve original bytes
  // of every retained entry, including tool blocks and parent links.
  const entries = lines.map(line => decodeFirstTurnEntry(JSON.parse(line)));
  if (entries[0]?.type !== "session") throw new Error("restart source has no session header");
  const last = entries.at(-1);
  if (last?.type === "message" && last.message?.role === "assistant"
    && Array.isArray(last.message.content) && last.message.content.length === 0
    && last.message.errorMessage === undefined && (last.message.stopReason === undefined || last.message.stopReason === "stop")) lines.pop();
  // Ernestine, 2026-10-18: Pi applies a fork's --model x:<thinking> in memory but persists a thinking level only for a
  // session with none, so the forked file kept the parent's level. The clamp check read it as a clamp, and resuming the
  // file later went back to it. Record the launch level as the snapshot's leaf, so the fork inherits it.
  if (thinking) {
    const parsed = lines.map(line => JSON.parse(line) as { type?: string; thinkingLevel?: string; id?: string });
    const newestFirst = [...parsed].reverse();
    const current = newestFirst.find(entry => entry.type === "thinking_level_change")?.thinkingLevel;
    const leaf = newestFirst.find(entry => typeof entry.id === "string")?.id;
    // With no level recorded, Pi writes the launch level itself.
    if (current !== undefined && current !== thinking && leaf) lines.push(JSON.stringify({ type: "thinking_level_change", id: randomBytes(4).toString("hex"), parentId: leaf, timestamp: new Date().toISOString(), thinkingLevel: thinking }));
  }
  writeFileSync(destination, lines.join("\n") + "\n", { flag: "wx", mode: 0o600 });
}
