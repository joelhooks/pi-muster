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
it.each(["NO API KEY FOUND", "HTTP 401", "Unauthorized", "invalid api key", "authentication failed", "Model xyz not found", "Unknown model", "No models available"])("classifies %s as a model error", (line) => {
  expect(modelOutputIssue(`header\n${line}\nfooter`)).toEqual({ severity: "error", line });
});
it("treats rate limit exceeded as a warning, not a model failure", () => {
  expect(modelOutputIssue("Rate limit exceeded")).toEqual({ severity: "warning", line: "Rate limit exceeded" });
});
