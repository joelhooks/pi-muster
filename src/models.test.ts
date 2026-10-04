import { expect, it } from "vitest";
import { decodeRoster, roleDefaults } from "./domain.ts";
import { modelOutputIssue, parseRunnableModels, resolveModel, workingRoutes } from "./models.ts";

it("parses the real pi --list-models header and provider/model columns", () => {
  expect(parseRunnableModels(`provider       model                     context  max-out  thinking  images
claude-bridge  claude-fable-5-1          1M       128K     yes       yes
openai-codex   gpt-6.1-sol               400K     128K     yes       yes
`)).toEqual(["claude-bridge/claude-fable-5-1", "openai-codex/gpt-6.1-sol"]);
});
it("resolves roster aliases before selecting alternate settings and thinking suffixes", () => {
  const roster = decodeRoster({ version: 1, aliases: { audit: "openai-codex/gpt-6.1-sol" }, roles: { boss: {
    model: "opus", alternates: [{ model: "audit", thinking: "low", compactAt: 9000, useFor: [] }],
  } } });
  expect(roleDefaults(roster, { roles: { boss: { model: "sol" } } }, "boss")).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "low", compactAt: 9000 });
  expect(roleDefaults(roster, undefined, "boss", "audit:high")).toMatchObject({ model: "openai-codex/gpt-6.1-sol", thinking: "high", compactAt: 9000 });
  expect(resolveModel("opus:max")).toEqual({ model: "claude-bridge/claude-opus-5-5", thinking: "max" });
});
it("refuses a roster alias targeting sonnet", () => {
  const roster = decodeRoster({ version: 1, aliases: { sneaky: "claude-bridge/claude-sonnet-5" }, roles: {} });
  expect(() => resolveModel("sneaky", roster)).toThrow("Sonnet is not used");
});
it("suggests exact and prefix routes, preferring the Claude bridge and limiting to three", () => {
  expect(workingRoutes("anthropic/claude-opus-5", ["other/claude-opus-5", "claude-bridge/claude-opus-5", "claude-bridge/claude-opus-5-5", "another/claude-opus-5", "other/unrelated"])).toEqual([
    "claude-bridge/claude-opus-5", "claude-bridge/claude-opus-5-5", "another/claude-opus-5",
  ]);
});
it.each(["No API key found for anthropic.", "HTTP 401", "Unauthorized", "invalid api key", "authentication failed", "Model xyz not found", "Unknown model", "No models available"])("classifies Pi's Error: %s as a model error", (message) => {
  const line = `Error: ${message}`;
  expect(modelOutputIssue(`header\n${line}\n`)).toEqual({ severity: "error", line });
});
it("treats Pi-rendered rate limit exceeded as a warning, not a model failure", () => {
  expect(modelOutputIssue("Error: Rate limit exceeded")).toEqual({ severity: "warning", line: "Error: Rate limit exceeded" });
});
it.each(["authentication middleware returns 401", "Unauthorized requests are rejected", "invalid api key fixture", "authentication failed test passes", "Model xyz not found in test", "Unknown model fixture", "No models available example", "Rate limit exceeded fixture", "Error: authentication middleware returns success"])("ignores prose or test output: %s", (line) => {
  expect(modelOutputIssue(line)).toBeNull();
});
it("ignores an old Pi error followed by newer normal output above the editor", () => {
  expect(modelOutputIssue("Error: No API key found for anthropic.\n\nTests passed\n───────────────\n\n───────────────\n~/repo\n↑0 ↓0 claude-opus-5-5 • high")).toBeNull();
});
it("ignores an old auth error when the newest Pi output is a rate-limit warning", () => {
  expect(modelOutputIssue("Error: No API key found for anthropic.\nError: rate limit exceeded")).toEqual({ severity: "warning", line: "Error: rate limit exceeded" });
});
it("ignores model error text typed into the editor and printed in the footer", () => {
  expect(modelOutputIssue("Healthy assistant output\n───────────────\nError: No API key found for anthropic.\n───────────────\nauthentication project\nError: Unknown model")).toBeNull();
});
it.each(["───────────────", "─── ↑ 2 more ───"])("retains the current Pi error above editor border %s", (top) => {
  expect(modelOutputIssue(`Older output\n\u001b[31m Error: No API key found for anthropic.\u001b[0m\n\n${top}\n\n───────────────\n~/repo\n↑0 ↓0 claude-opus-5-5 • high`)).toEqual({ severity: "error", line: "Error: No API key found for anthropic." });
});
it("ignores clipped editor output when only its bottom border is visible", () => {
  expect(modelOutputIssue("Error: No API key found for anthropic.\n───────────────\n~/repo")).toBeNull();
});
