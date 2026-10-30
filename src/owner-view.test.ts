import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ownerReceipt, ownerToolResult, ownerLine } from "./owner-view.ts";

const theme = { fg: (_: string, s: string) => `\x1b[36m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };

describe("owner tool rows", () => {
  it("shows receipt paths, expands record ids, and keeps narrow tool rows plain", () => {
    for (const [path, woke, expected] of [["queue", false, "quiet"], ["queue", true, "woke owner"], ["intercom", true, "legacy fallback"]] as const) {
      expect(ownerReceipt({ kind: "progress", title: "title", path, woke })).toContain(expected);
    }
    const text = '🐦 posted reply "title" → @owner · woke owner\nuri: muster://writer/record';
    expect(ownerToolResult(text, false, theme).render(100).join("\n")).not.toContain("muster://");
    expect(ownerToolResult(text, true, theme).render(100).join("\n")).toContain("muster://writer/record");
    vi.stubEnv("NO_COLOR", "");
    try {
      for (const view of [ownerToolResult(text, true, theme), ownerLine(text, theme)]) {
        const lines = view.render(10);
        expect(lines.join("\n")).not.toContain("\x1b");
        expect(lines.every(line => visibleWidth(line) <= 10)).toBe(true);
      }
    } finally { vi.unstubAllEnvs(); }
  });
});
