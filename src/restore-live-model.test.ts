import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseSessionModel, restoreProfile, SESSION_MODEL_READ_SCRIPT } from "./session-model.ts";
import { parseModelWindows, restoreContextNote } from "./models.ts";
import { profileFor } from "./argv.ts";
const profile = profileFor("worker", { label: "worker", model: "openai-codex/gpt-6.1-sol", thinking: "high" });
const lines = (...entries: object[]) => entries.map((entry, i) => JSON.stringify({ id: `e${i}`, parentId: i ? `e${i - 1}` : null, ...entry })).join("\n");
const session = lines(
  { type: "model_change", provider: "openai-codex", modelId: "gpt-6.1-sol" },
  { type: "thinking_level_change", thinkingLevel: "medium" },
  { type: "model_change", provider: "claude-bridge", modelId: "claude-opus-5-5", timestamp: "2026-10-05T17:40:09.345Z" },
  { type: "message", message: { role: "assistant", usage: { input: 1000, output: 3000, cacheRead: 400000, cacheWrite: 30000 } } },
);
it("takes model and thinking changes on the selected branch with Pi context accounting", () => {
  const live = parseSessionModel(session);
  expect(live).toMatchObject({ model: "claude-bridge/claude-opus-5-5", thinking: "medium", contextTokens: 434000 });
  expect(restoreProfile({ profile, live }).profile).toMatchObject({ model: live.model, thinking: "medium" });
  expect(restoreProfile({ profile, live }).note).toContain("from session, switched 17:40Z");
});
it("falls back to launch profile without changes and ignores malformed trailing lines", () => {
  expect(restoreProfile({ profile, live: parseSessionModel("{}\n{broken") }).profile).toEqual(profile);
  expect(restoreProfile({ profile, live: parseSessionModel("") }).note).toContain("from launch profile");
});
it("explicit model and thinking win, including a model thinking suffix", () => {
  const live = parseSessionModel(session);
  expect(restoreProfile({ profile, live, model: "sol:low" }).profile).toMatchObject({ model: profile.model, thinking: "low" });
  expect(restoreProfile({ profile, live, model: "sol:low", thinking: "xhigh" }).profile.thinking).toBe("xhigh");
});
it("applies model refusal to a session route", () => {
  expect(() => restoreProfile({ profile, live: parseSessionModel(lines({ type: "model_change", provider: "claude-bridge", modelId: "claude-fable-5-1" })) })).toThrow("Fable is off fleet-wide");
});
it("ignores error usage and uses native totalTokens when available", () => {
  expect(parseSessionModel(session + "\n" + lines({ type: "message", id: "error", parentId: "e3", message: { role: "assistant", stopReason: "error", usage: { totalTokens: 0 } } })).contextTokens).toBe(434000);
  expect(parseSessionModel(lines({ type: "message", message: { role: "assistant", usage: { totalTokens: 230000 } } })).contextTokens).toBe(230000);
});
it("remote projection stays bounded for a session above Proc's 16 MiB limit and preserves only restore evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-model-"));
  const file = join(dir, "session.jsonl");
  const text = session + "\n" + lines({ type: "message", id: "user", parentId: "e3", message: { role: "user", content: "private text ".repeat(1500000) } }) + "\n{partial";
  try {
    writeFileSync(file, text);
    const projected = execFileSync(process.execPath, ["--input-type=module", "-e", SESSION_MODEL_READ_SCRIPT, file], { encoding: "utf8", maxBuffer: 1024 });
    expect(projected.length).toBeLessThan(1024);
    expect(projected).not.toContain("private text");
    expect(parseSessionModel(projected)).toEqual(parseSessionModel(text));
  } finally { unlinkSync(file); rmdirSync(dir); }
});
const listing = `provider model context max-out thinking images
openai-codex gpt-6.1-sol 272K 128K yes yes
claude-bridge claude-opus-5-5 1M 128K yes yes
`;
it("parses model windows, refuses overflow with a fitting route, and warns above 80%", () => {
  const windows = parseModelWindows(listing);
  expect(windows.get(profile.model)).toBe(272000);
  expect(windows.get("claude-bridge/claude-opus-5-5")).toBe(1000000);
  expect(() => restoreContextNote(profile.model, 434000, windows)).toThrow(/434000.*272000.*claude-bridge\/claude-opus-5-5/);
  expect(restoreContextNote(profile.model, 230000, windows)).toMatch(/230000.*272000.*warning/);
  expect(restoreContextNote(profile.model, 217600, windows)).toBeNull();
  expect(restoreContextNote(profile.model, 434000, new Map())).toMatch(/unknown.*warning/);
});
