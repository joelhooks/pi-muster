import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { appendOwnerItem } from "./owner-queue.ts";
import { ownerTimelineData, OwnerTimelineView, ownerDisplayName, ownerReceipt, ownerToolResult, ownerLine } from "./owner-view.ts";

const theme = { fg: (_: string, s: string) => `\x1b[36m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m` };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "owner-view-"));
  const quiet = Array.from({ length: 5 }, (_, n) => appendOwnerItem("reader", { author: "writer-long-session", kind: "fyi", title: `quiet ${n} 猫` }, home));
  const mention = appendOwnerItem("reader", { author: "sender", kind: "question", title: "Need a decision", body: "line two\nline three\nline four", refs: ["muster://private/ref"] }, home);
  const reply = appendOwnerItem("reader", { author: "reader", kind: "blocked", title: "Reply title", replyTo: mention.uri }, home);
  const data = ownerTimelineData({ items: [...quiet, mention, reply], reader: "reader", home });
  return { data, mention };
}
describe("owner timeline", () => {
  it.each([100, 40, 10, 1, 0])("keeps mention cards first and every line within %i columns", width => {
    const { data } = fixture();
    const lines = new OwnerTimelineView(data, { expanded: false, now: Date.now() }, theme).render(width);
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    if (width >= 40) {
      const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain.indexOf("@you")).toBeLessThan(plain.indexOf("quiet 2"));
      expect(plain).toContain("+2 more");
      expect(plain).toContain("↳ reply to sender: Need a decision");
      expect(plain).not.toContain("muster://");
      expect(plain).not.toContain("line four");
      expect(plain).not.toContain("quiet 0");
    }
  });
  it("expands text, refs and all quiet posts, with the full footer", () => {
    const { data } = fixture();
    const render = (expanded: boolean) => new OwnerTimelineView(data, { expanded }, theme).render(100).join("\n");
    expect(render(true)).toContain("line four");
    expect(render(true)).toContain("muster://private/ref");
    expect(render(true)).toContain("quiet 0");
    expect(render(false)).toContain("2 mentions · 5 quiet · owner_inbox for full records");
  });
  it("NO_COLOR strips even incoming escapes and falls back to plain framing", () => {
    vi.stubEnv("NO_COLOR", "1");
    try {
      const { data } = fixture();
      const withEscapes = { ...data, items: data.items.map(item => ({ ...item, text: `\x1b[31m${item.text}\x1b[0m`, refs: ["\x1b[32mref\x1b[0m"] })) };
      const lines = new OwnerTimelineView(withEscapes, { expanded: true }, theme).render(40);
      expect(lines.join("\n")).not.toContain("\x1b");
      expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
  it("snapshots catalog display names and profile label emojis, with safe fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "owner-catalog-"));
    const dir = join(home, "repo");
    mkdirSync(join(dir, ".brain/data/muster"), { recursive: true });
    const project = {
      version: 1, slug: "probe", label: "Probe", dir, outcome: "o", reviewTrigger: "r", criticalPath: [], nextAction: "n", mode: "rift-merge", spaceId: null, sidebar: "off", ephemeral: true, musterExtension: null, deskExtension: null, cadenceMinutes: null, state: "active", packets: [], reviews: [], createdAt: "t", updatedAt: "t",
      lanes: [{ slug: "lane", kind: "work", label: "🐦 Lane", goal: "g", writeScope: [], repo: null, generated: [], tabId: null, root: null, state: "open", archived: false, createdAt: "t", updatedAt: "t" }],
      agents: [{ name: "writer", role: "worker", lane: "lane", cwd: dir, clone: null, profile: { label: "🔨 Writer", model: "m", thinking: null, appendSystemPrompt: [], noSkills: true, skills: [], extensions: [], env: {}, compactAt: 1 }, sessionId: "writer-session", sessionFile: null, parentSessionFile: null, pane: null, owner: "reader", brief: null, state: "running", delivery: "proven", restarts: 0, restore: null, createdAt: "t", updatedAt: "t" }],
    };
    writeFileSync(join(dir, ".brain/data/muster/project.json"), JSON.stringify(project));
    const item = appendOwnerItem("reader", { author: "writer-session", kind: "fyi", title: "catalog post" }, home);
    const data = ownerTimelineData({ home, project: dir, reader: "reader", items: [item] });
    expect(data.authors["writer-session"]).toBe("🔨 writer · lane");
    writeFileSync(join(dir, ".brain/data/muster/project.json"), "{}");
    expect(ownerTimelineData({ home, project: dir, reader: "reader", items: [item] }).authors).toEqual({});
  });
  it("shows receipt paths, expands record ids, and keeps narrow tool rows plain", () => {
    for (const [path, woke, expected] of [["queue", false, "quiet"], ["queue", true, "woke owner"], ["intercom", true, "intercom fallback"]] as const) {
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
  it("uses catalog names and lane labels, or a shortened session id", () => {
    expect(ownerDisplayName("long-session-identifier", {})).toBe("long-sessi…");
    expect(ownerDisplayName("writer", { writer: "🐦 writer · owner-tui" })).toBe("🐦 writer · owner-tui");
  });
});
