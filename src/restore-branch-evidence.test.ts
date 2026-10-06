import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseSessionModel, SESSION_MODEL_READ_SCRIPT } from "./session-model.ts";

const model = (id: string, parentId: string | null, provider = "openai-codex", modelId = "gpt-6.1-sol") => ({ type: "model_change", id, parentId, provider, modelId });
const thinking = (id: string, parentId: string, thinkingLevel: string) => ({ type: "thinking_level_change", id, parentId, thinkingLevel });
const response = (id: string, parentId: string | null, extra = {}) => ({ type: "message", id, parentId, message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", api: "openai-responses", content: [{ type: "text", text: "private transcript" }], stopReason: "stop", usage: { totalTokens: 434000 }, ...extra } });
function readers(entries: unknown[], trailing = "", lookup?: Parameters<typeof parseSessionModel>[1]) {
  const text = entries.map(entry => JSON.stringify(entry)).join("\n") + trailing;
  const dir = mkdtempSync(join(tmpdir(), "restore-branch-"));
  const file = join(dir, "session.jsonl");
  try {
    writeFileSync(file, text);
    const projected = execFileSync(process.execPath, ["--input-type=module", "-e", SESSION_MODEL_READ_SCRIPT, file], { encoding: "utf8", maxBuffer: 4096 });
    expect(projected).not.toContain("private transcript");
    const local = parseSessionModel(text, lookup);
    expect(parseSessionModel(projected, lookup)).toEqual(local);
    const envelope = JSON.parse(projected);
    expect(envelope.entries.length).toBeLessThanOrEqual(5);
    for (const entry of envelope.entries) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("parentId");
    }
    return local;
  } finally { unlinkSync(file); rmdirSync(dir); }
}
it("restores only the selected branch, even when another branch changed settings later", () => {
  expect(readers([
    model("root", null), thinking("high", "root", "high"), response("active", "high"),
    model("discarded", "root", "claude-bridge", "claude-opus-5-5"), thinking("medium", "discarded", "medium"),
    { type: "label", id: "leaf", parentId: "active", targetId: "active", label: "selected" },
  ])).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "high", contextTokens: 434000 });
});
it("uses a model-bearing assistant without a model change", () => {
  expect(readers([response("a", null)])).toMatchObject({ model: "openai-codex/gpt-6.1-sol", contextTokens: 434000 });
});
it("uses the physical response over an earlier ordinary model change", () => {
  expect(readers([model("root", null, "claude-bridge", "claude-opus-5-5"), response("a", "root")]).model).toBe("openai-codex/gpt-6.1-sol");
});
it("does not borrow usage from a discarded branch when the active branch has only zero usage", () => {
  expect(readers([response("discarded", null), response("active", null, { usage: { totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })]).contextTokens).toBeNull();
});
it.each(["stop", "error", "aborted"])("skips invalid %s usage without erasing previous evidence", stopReason => {
  expect(readers([response("a", null), response("b", "a", { stopReason, usage: { totalTokens: stopReason === "stop" ? 0 : 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })]).contextTokens).toBe(434000);
});
it("retains a registered virtual selection, but an absent virtual falls back to the response", () => {
  const branch = [model("v", null, "router", "auto"), response("a", "v")];
  expect(readers(branch).model).toBe("openai-codex/gpt-6.1-sol");
  expect(readers(branch, "", (provider, id) => provider === "router" && id === "auto" ? { virtual: true } : undefined).model).toBe("router/auto");
});
it("a newer physical change ends a virtual selection and failed virtual responses do not replace physical evidence", () => {
  expect(readers([model("v", null, "router", "auto"), response("a", "v"), model("p", "a"), response("b", "p"), response("failed", "b", { provider: "router", model: "auto", api: "pi-virtual", stopReason: "error" })], "", provider => provider === "router" ? { virtual: true } : undefined).model).toBe("openai-codex/gpt-6.1-sol");
});
it("ignores a partial trailing line", () => {
  expect(readers([response("a", null)], '\n{"id":"partial"')).toMatchObject({ model: "openai-codex/gpt-6.1-sol", contextTokens: 434000 });
});
it("bounds remote evidence for large journals and retains branch links", () => {
  expect(readers([model("root", null), response("a", "root"), ...Array.from({ length: 20000 }, (_, i) => ({ type: "message", id: `u${i}`, parentId: i ? `u${i - 1}` : "a", message: { role: "user", content: "private transcript".repeat(60) } }))])).toMatchObject({ model: "openai-codex/gpt-6.1-sol", contextTokens: 434000 });
});
