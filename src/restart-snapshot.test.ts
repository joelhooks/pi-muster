import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forEachJsonlLine, snapshotRestartSession, untilJournalLines } from "./restart-snapshot.ts";

// drovr desk, 2026-10-22: restart read a 741 MB journal into one string and Node refused it. Journals are read in chunks.
describe("streamed journal reads", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "muster-stream-"));

  it("keeps every line byte for byte across chunk edges, multi-byte characters included, and skips blank lines", () => {
    const file = join(dir(), "j.jsonl");
    const lines = [JSON.stringify({ type: "session", id: "s" }), JSON.stringify({ text: "🐀 rat · 𝔐uster ✓" }), JSON.stringify({ text: "x".repeat(37) })];
    writeFileSync(file, `${lines[0]}\n\n${lines[1]}\n${lines[2]}`); // no trailing newline
    for (const size of [1, 2, 3, 5, 7, 64, 1 << 20]) {
      const seen: string[] = [];
      forEachJsonlLine(file, line => seen.push(line), size);
      expect(seen).toEqual(lines);
    }
  });

  it("lists only the header and pi-until entries for a watch check", () => {
    const file = join(dir(), "j.jsonl");
    const header = JSON.stringify({ type: "session", id: "s" });
    const watch = JSON.stringify({ type: "custom", customType: "pi-until-watch", id: "w" });
    writeFileSync(file, [header, JSON.stringify({ type: "message", id: "m" }), watch].join("\n") + "\n");
    expect(untilJournalLines(file)).toBe(`${header}\n${watch}`);
  });

  it("a refused source leaves no partial snapshot behind", () => {
    const base = dir();
    const source = join(base, "s.jsonl"), destination = join(base, "snap.jsonl");
    writeFileSync(source, [JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-10-22T00:00:00Z", cwd: base }), "{partial"].join("\n") + "\n");
    expect(() => snapshotRestartSession(source, destination)).toThrow();
    expect(existsSync(destination)).toBe(false);
    writeFileSync(source, JSON.stringify({ type: "message", id: "m" }) + "\n");
    expect(() => snapshotRestartSession(source, destination)).toThrow("no session header");
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(source, "utf8")).toContain('"m"');
  });
});
