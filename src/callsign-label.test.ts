import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimedLabel } from "./ops.ts";

function home(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "callsign-"));
  mkdirSync(join(dir, ".local/state/switchboard"), { recursive: true });
  writeFileSync(join(dir, ".local/state/switchboard/callsigns.jsonl"), lines.join("\n") + "\n");
  return dir;
}

describe("claimedLabel", () => {
  it("uses the latest claim for this project and row, honours releases, and skips other writers' lines", () => {
    const h = home([
      JSON.stringify({ at: "t", project: "muster", theme: "x", callsign: "Rover", emoji: "🎈", agent: "desk", pane: "p" }),
      "{partial",
      JSON.stringify({ at: "t", project: "other", callsign: "Gavel", emoji: "⚖️", agent: "desk" }),
      JSON.stringify({ at: "t", project: "muster", released: "Rover" }),
    ]);
    expect(claimedLabel(h, "muster", "desk", "muster desk")).toBeUndefined();
    writeFileSync(join(h, ".local/state/switchboard/callsigns.jsonl"), JSON.stringify({ at: "t", project: "muster", callsign: "Yaffle", emoji: "🐦", agent: "desk" }) + "\n", { flag: "a" });
    expect(claimedLabel(h, "muster", "desk", "muster desk")).toBe("🐦 Yaffle · muster desk");
    expect(claimedLabel(h, "muster", "worker", "worker")).toBeUndefined();
    expect(claimedLabel(join(h, "nowhere"), "muster", "desk", "desk")).toBeUndefined();
  });
});
