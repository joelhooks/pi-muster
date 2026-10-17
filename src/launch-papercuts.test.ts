import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { isScratchNote, readableBrief, scratchCleanupNote } from "./ops.ts";

describe("launch papercuts (drovr, 2026-10-11)", () => {
  it("recognises only Muster's own per-attempt scratch note, so a retry replaces it instead of stacking", () => {
    const dir = "/clone/.git/muster-launch";
    expect(isScratchNote(`${dir}/m-0b5c7a62-9f1e-4c1a-8d2e-3f4a5b6c7d8e.prompt.txt`, dir)).toBe(true);
    expect(isScratchNote(`/elsewhere/m-0b5c7a62-9f1e-4c1a-8d2e-3f4a5b6c7d8e.prompt.txt`, dir)).toBe(false);
    expect(isScratchNote(`${dir}/ea.md`, dir)).toBe(false);
  });
  it("waits for a brief written in the same tool batch, and still refuses one that never appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-brief-"));
    const brief = join(dir, "brief.md");
    setTimeout(() => writeFileSync(brief, "# brief\n"), 400);
    await Effect.runPromise(readableBrief(brief));
    await expect(Effect.runPromise(readableBrief(join(dir, "never.md")))).rejects.toThrow("brief is not readable");
  }, 10_000);
  // Ernestine for Joel, 2026-10-15: workers reached for a recursive force delete, dcg denied it, and scratch piled up on remote1.
  it("names a cleanup dcg allows in the remote scratch note, and forbids the denied deletes", () => {
    const note = scratchCleanupNote("/home/alice/.cache/drovr/merge-train");
    expect(note).toContain("Your scratch path is /home/alice/.cache/drovr/merge-train.");
    expect(note).toContain("`gio trash <path>` on Linux");
    expect(note).toContain("`trash <path>` on macOS");
    expect(note).toMatch(/Never use `rm -r[f]` or `find -delete`/);
  });
});
