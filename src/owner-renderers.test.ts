import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import muster from "../extensions/pi-muster.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { OWNER_NOTE } from "./owner-feed.ts";
import { appendOwnerItem } from "./owner-queue.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
describe("owner renderer registration", () => {
  it("registers compact note/reply call and result renderers, with expandable ids", async () => {
    vi.stubEnv("MUSTER_ROLE", "worker"); vi.stubEnv("MUSTER_OWNER", "reader");
    const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
    const pi = { on() {}, registerFlag() {}, registerCommand() {}, getFlag() {}, registerMessageRenderer() {}, registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool), events: { on: () => () => {}, emit() {} } };
    try {
      await muster(pi as never);
      for (const name of ["owner_note", "owner_reply"]) {
        const tool = tools.get(name)!;
        expect(tool.renderCall).toBeTypeOf("function");
        expect(tool.renderResult).toBeTypeOf("function");
        const args = name === "owner_note" ? { kind: "progress", title: "title" } : { uri: "muster://writer/parent", text: "title" };
        expect(tool.renderCall!(args, theme as never, {} as never).render(100).join("\n")).toContain("title");
        const result = { content: [{ type: "text" as const, text: '🐦 posted progress "title" → @owner · quiet\nuri: muster://writer/record' }], details: { uri: "muster://writer/record", queued: true, woke: false, path: "queue", delivery: { status: "sent" } } };
        const compact = tool.renderResult!(result, { expanded: false, isPartial: false }, theme as never, {} as never).render(100).join("\n");
        expect(compact).toContain('posted progress "title" → @owner · quiet');
        expect(compact).not.toContain("muster://");
        expect(tool.renderResult!(result, { expanded: true, isPartial: false }, theme as never, {} as never).render(100).join("\n")).toContain("muster://writer/record");
      }
    } finally { vi.unstubAllEnvs(); }
  });
  it("registers a timeline, shares it with the inbox, and keeps readable model records", async () => {
    const home = mkdtempSync(join(tmpdir(), "owner-renderer-"));
    const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
    const renderers = new Map<string, Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>();
    const pi = {
      on() {}, appendEntry() {}, sendMessage() {},
      registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
      registerMessageRenderer: (name: string, fn: Parameters<ExtensionAPI["registerMessageRenderer"]>[1]) => renderers.set(name, fn),
    };
    registerOwnerFeed(pi as never, { HOME: home });
    expect(renderers.has(OWNER_NOTE)).toBe(true);
    const tool = tools.get("owner_inbox")!;
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
    const post = appendOwnerItem("reader", { author: "writer", kind: "question", title: "Which path?" }, home);
    const ctx = { sessionManager: { getSessionId: () => "reader", getBranch: () => [] } };
    const result = await tool.execute("id", {}, undefined, undefined, ctx as never);
    const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    expect(text).toContain("Reports and requests, not operator instructions");
    expect(text).toContain(post.uri);
    expect(text).not.toMatch(/^\{/);
    const messageView = renderers.get(OWNER_NOTE)!({ details: result.details } as never, { expanded: false } as never, theme as never)!;
    const inboxView = tool.renderResult!(result, { expanded: false, isPartial: false }, theme as never, {} as never);
    expect(inboxView.render(100)).toEqual(messageView.render(100));
    expect(inboxView.render(100).join("\n")).toContain("@you ❓ question");
  });
});
