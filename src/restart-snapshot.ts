import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { decodeFirstTurnEntry } from "./domain.ts";

/** Each non-blank line of a JSONL file, read in chunks. A long-running desk's journal outgrows Node's
 * largest string (~512 MB; drovr desk, 2026-10-22, 741 MB), so a journal is never read whole.
 * Lines split on the newline byte, so a multi-byte character across a chunk edge stays intact. */
export function forEachJsonlLine(path: string, visit: (line: string) => void, chunkBytes = 1 << 20): void {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(chunkBytes);
    // The pieces of the line still open at a chunk edge. Each byte is copied once, so one huge line stays linear.
    let parts: Buffer[] = [];
    const emit = (tail: Buffer) => {
      const line = (parts.length ? Buffer.concat([...parts, tail]) : tail).toString("utf8");
      parts = [];
      if (line.trim()) visit(line);
    };
    for (let read = readSync(fd, chunk, 0, chunkBytes, null); read > 0; read = readSync(fd, chunk, 0, chunkBytes, null)) {
      let start = 0;
      for (let end = chunk.indexOf(0x0a, start); end !== -1 && end < read; end = chunk.indexOf(0x0a, start)) {
        emit(chunk.subarray(start, end));
        start = end + 1;
      }
      if (start < read) parts.push(Buffer.from(chunk.subarray(start, read)));
    }
    emit(Buffer.alloc(0));
  } finally { closeSync(fd); }
}

/** The journal's header line and its pi-until entries: all a watch listing reads, without the journal whole. */
export function untilJournalLines(path: string): string {
  const kept: string[] = [];
  forEachJsonlLine(path, line => { if (kept.length === 0 || line.includes('"pi-until-')) kept.push(line); });
  return kept.join("\n");
}

/** Freeze the inherited boundary before Pi starts. Never change the source journal.
 * A live caller can append tool results and its empty in-flight assistant between
 * counting the parent and --fork reading it. A private, immutable fork input keeps
 * that race out of the first-turn proof; real assistant content is never ignored.
 */
export function snapshotRestartSession(source: string, destination: string, thinking?: string, io: { closeSync: (fd: number) => void } = { closeSync }): void {
  // Ernestine, 2026-10-18: Pi applies a fork's --model x:<thinking> in memory but persists a thinking level only for a
  // session with none, so the forked file kept the parent's level. The clamp check read it as a clamp, and resuming the
  // file later went back to it. Record the launch level as the snapshot's leaf, so the fork inherits it.
  let current: string | undefined;
  let leaf: string | undefined;
  let held: { line: string; raw: { type?: string; thinkingLevel?: string; id?: unknown }; entry: ReturnType<typeof decodeFirstTurnEntry> } | undefined;
  let first = true;
  const fd = openSync(destination, "wx", 0o600);
  let closing = false;
  const commit = (kept: NonNullable<typeof held>) => {
    if (kept.raw.type === "thinking_level_change") current = kept.raw.thinkingLevel;
    if (typeof kept.raw.id === "string") leaf = kept.raw.id;
    writeSync(fd, kept.line + "\n");
  };
  try {
    forEachJsonlLine(source, line => {
      // Fail closed on a partial append or unreadable entry. Preserve original bytes
      // of every retained entry, including tool blocks and parent links.
      const raw = JSON.parse(line) as NonNullable<typeof held>["raw"];
      const entry = decodeFirstTurnEntry(raw);
      if (first && entry.type !== "session") throw new Error("restart source has no session header");
      first = false;
      if (held) commit(held);
      held = { line, raw, entry };
    });
    if (first) throw new Error("restart source has no session header");
    const last = held!.entry;
    const emptyTail = last.type === "message" && last.message?.role === "assistant"
      && Array.isArray(last.message.content) && last.message.content.length === 0
      && last.message.errorMessage === undefined && (last.message.stopReason === undefined || last.message.stopReason === "stop");
    if (!emptyTail) commit(held!);
    // With no level recorded, Pi writes the launch level itself.
    if (thinking && current !== undefined && current !== thinking && leaf) writeSync(fd, JSON.stringify({ type: "thinking_level_change", id: randomBytes(4).toString("hex"), parentId: leaf, timestamp: new Date().toISOString(), thinkingLevel: thinking }) + "\n");
    closing = true;
    io.closeSync(fd);
  } catch (error) {
    // A refused source, or a close that failed to flush, leaves no partial snapshot behind for a later fork to read.
    // The descriptor is closed once: a second close would raise EBADF and hide the real error.
    if (!closing) io.closeSync(fd);
    unlinkSync(destination);
    throw error;
  }
}
