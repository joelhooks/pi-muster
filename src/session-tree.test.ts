import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forkSessionAt, openSessionTree, resolveSessionTarget, rewindEvidence } from "./session-tree.ts";

// Small edge-case tree. The captured live Pi fixture below covers the real writer.
const fixture = `{"type":"session","version":3,"id":"fixture","timestamp":"2026-10-04T20:00:00.000Z","cwd":"/fixture"}
{"type":"message","id":"user1","parentId":null,"timestamp":"2026-10-04T20:00:00.001Z","message":{"role":"user","content":"Read the code.","timestamp":1791144000001}}
{"type":"message","id":"ready1","parentId":"user1","timestamp":"2026-10-04T20:00:00.002Z","message":{"role":"assistant","content":[{"type":"text","text":"Context ready."}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-6.1-sol","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1791144000002}}
{"type":"label","id":"label1","parentId":"ready1","timestamp":"2026-10-04T20:00:00.003Z","targetId":"ready1","label":"ctx:ready"}
{"type":"message","id":"later1","parentId":"label1","timestamp":"2026-10-04T20:00:00.004Z","message":{"role":"user","content":"Edit now.","timestamp":1791144000004}}
`;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "muster-tree-"));
  const file = join(dir, "fixture.jsonl");
  writeFileSync(file, fixture);
  return { dir, file, tree: openSessionTree(file) };
}

// Captured from a fresh print-mode Pi 0.79.10/Flowing session on 2026-10-04.
// System instructions omitted; root re-chained; cwd/call id redacted. No private prompt text.
const realFixture = `{"type":"session","version":3,"id":"01a108a7-1501-701c-b7da-ba84fdad144b","timestamp":"2026-10-04T20:42:10.050Z","cwd":"/fixture"}
{"type":"message","id":"0cd227df","parentId":null,"timestamp":"2026-10-04T20:42:11.105Z","message":{"role":"user","content":[{"type":"text","text":"Call context_mark with its default label, then respond exactly: context ready."}],"timestamp":1791146531104}}
{"type":"message","id":"ffbb8445","parentId":"0cd227df","timestamp":"2026-10-04T20:42:13.622Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_redacted","name":"context_mark","arguments":{}}],"api":"openai-codex-responses","provider":"openai-codex","model":"gpt-6.1-sol","usage":{"input":6098,"output":14,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":6112,"cost":{"input":0.012196,"output":0.00014,"cacheRead":0,"cacheWrite":0,"total":0.012336}},"stopReason":"toolUse","timestamp":1791146531110,"thinkingLevel":"low"}}
{"type":"label","id":"1373bcf2","parentId":"ffbb8445","timestamp":"2026-10-04T20:42:13.623Z","targetId":"ffbb8445","label":"ctx:ready"}
{"type":"message","id":"c004edb5","parentId":"1373bcf2","timestamp":"2026-10-04T20:42:13.624Z","message":{"role":"toolResult","toolCallId":"call_redacted","toolName":"context_mark","content":[{"type":"text","text":"Marked ffbb8445 as ctx:ready."}],"details":{"entryId":"ffbb8445","label":"ctx:ready"},"isError":false,"timestamp":1791146533624}}
`;

describe("Pi session tree", () => {
  it("extracts the exact path and labels from the captured real print-mode session", () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-real-tree-"));
    const file = join(dir, "real.jsonl");
    writeFileSync(file, realFixture);
    const tree = openSessionTree(file);
    expect(resolveSessionTarget(tree, "ctx:ready")).toBe("ffbb8445");
    const branch = openSessionTree(forkSessionAt(file, "ctx:ready", join(dir, "forks")));
    expect(branch.getEntries().filter(e => e.type !== "label").map(e => e.id)).toEqual(["0cd227df", "ffbb8445"]);
    expect(branch.getLabel("ffbb8445")).toBe("ctx:ready");
    expect(readFileSync(file, "utf8")).toBe(realFixture);
  });
  it("resolves labels and entry ids, and lists known labels for unknown targets", () => {
    const { tree } = setup();
    expect(resolveSessionTarget(tree, "ctx:ready")).toBe("ready1");
    expect(resolveSessionTarget(tree, "user1")).toBe("user1");
    expect(() => resolveSessionTarget(tree, "missing")).toThrow('Labels: ctx:ready');
  });
  it("writes exactly the root-to-target path plus resolved labels, leaving the parent unchanged", () => {
    const { dir, file } = setup();
    const before = readFileSync(file, "utf8");
    const fork = forkSessionAt(file, "ctx:ready", join(dir, "forks"));
    const branch = openSessionTree(fork);
    expect(branch.getEntries().filter(e => e.type !== "label").map(e => e.id)).toEqual(["user1", "ready1"]);
    expect(branch.getLabel("ready1")).toBe("ctx:ready");
    expect(branch.getSessionId()).not.toBe("fixture");
    expect(branch.getHeader()?.parentSession).toBe(file);
    expect(branch.getBranch().map(e => e.id)).toEqual(branch.getEntries().map(e => e.id));
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("rechaining across a label leaves no orphan when selecting a later entry", () => {
    const { dir, file } = setup();
    const fork = openSessionTree(forkSessionAt(file, "later1", join(dir, "forks")));
    expect(fork.getEntry("later1")?.parentId).toBe("ready1");
    expect(fork.getBranch().filter(e => e.type !== "label").map(e => e.id)).toEqual(["user1", "ready1", "later1"]);
  });
  it("honours label replacement/removal and refuses ambiguous labels", () => {
    const { file, tree } = setup();
    tree.appendLabelChange("ready1", "renamed");
    tree.appendLabelChange("user1", "renamed");
    expect(() => resolveSessionTarget(openSessionTree(file), "renamed")).toThrow("ambiguous");
    tree.appendLabelChange("user1", undefined);
    expect(resolveSessionTarget(openSessionTree(file), "renamed")).toBe("ready1");
    expect(() => resolveSessionTarget(openSessionTree(file), "ctx:ready")).toThrow("unknown");
  });
  it("refuses nonexistent files and assistant-less targets without mutating the parent", () => {
    const { dir, file } = setup();
    expect(() => openSessionTree(join(dir, "missing"))).toThrow("does not exist");
    expect(() => forkSessionAt(file, "user1", join(dir, "forks"))).toThrow("assistant entry");
  });
  it("accepts only fresh evidence attached to the requested navigation leaf", () => {
    const { file, tree } = setup();
    tree.branchWithSummary("ready1", "old summary");
    const before = tree.getEntries();
    expect(rewindEvidence(openSessionTree(file), before, "ready1")).toBeNull();
    tree.branchWithSummary("user1", "wrong branch");
    expect(rewindEvidence(openSessionTree(file), before, "ready1")).toBeNull();
    const summary = tree.branchWithSummary("ready1", "correct branch");
    expect(rewindEvidence(openSessionTree(file), before, "ready1")).toBe(summary);
  });
  it("handles user-message navigation at its parent and labelled no-summary navigation", () => {
    const { file, tree } = setup();
    const before = tree.getEntries();
    const summary = tree.branchWithSummary("label1", "user navigation");
    expect(rewindEvidence(openSessionTree(file), before, "later1")).toBe(summary);
    tree.branch("ready1");
    tree.appendLabelChange("ready1", "rewound");
    expect(rewindEvidence(openSessionTree(file), before, "ready1")).toBe(tree.getLeafId());
  });
});
