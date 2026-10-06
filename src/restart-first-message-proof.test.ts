import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { FIRST_TURN_MS, firstTurnDetail, proveStartedPrompt } from "./herdr.ts";
import { Proc } from "./runtime.ts";
import { harness, runWith } from "./test-support.ts";

// Source oracle: pi-claude-bridge 1dff6271f067dcf4606e8c4405264a5182164e04,
// src/index.ts turnStart/extractUserPrompt. Trailing user messages are joined;
// no journal notice type or provenance marker is written. Never trust notice text.
const user = (content: string) => JSON.stringify({ type: "message", message: { role: "user", content } }) + "\n";
const assistant = (extra = {}) => JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "toolUse", ...extra } }) + "\n";
const prompt = "You continue worker after a restart onto " + "a".repeat(40) + ". Re-read your brief and owner inbox.";
const notice = user("instructions refreshed; continue with updated instructions");

function fixture(text: string) {
  const h = harness();
  h.sleep = ms => { h.now = new Date(h.now.getTime() + ms); };
  const file = join(h.root, "fork.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session" }) + "\n" + text);
  return { h, file };
}

describe("restart's own first message", () => {
  it.each([notice + user(prompt) + assistant(), user(prompt) + notice + assistant(), notice + assistant()])("refuses an unmarked notice precisely", async text => {
    const { h, file } = fixture(text);
    expect(await runWith(h, proveStartedPrompt(file, prompt, 1))).toMatchObject({ state: "unproven", detail: expect.stringContaining("unverified user message") });
  });
  it("does not accept a substituted continuation with the same 80-character prefix", async () => {
    const { h, file } = fixture(user(prompt.slice(0, 80) + " unrelated work") + assistant());
    expect(await runWith(h, proveStartedPrompt(file, prompt, 1))).toMatchObject({ state: "unproven", detail: expect.stringContaining("unverified user message") });
  });
  it("refuses an assistant before the intended user instead of accepting a later turn", () => {
    expect(firstTurnDetail(assistant() + user(prompt) + assistant(), prompt)).toMatchObject({ state: "unproven", detail: expect.stringContaining("wrong boundary") });
  });
  it("names a missing intended prompt", async () => {
    const { h, file } = fixture("");
    expect(await runWith(h, proveStartedPrompt(file, prompt, 1))).toMatchObject({ state: "unproven", detail: expect.stringContaining("intended prompt missing") });
  });
  it("reads a 33 MiB inherited fork using the first-turn budget, not a 10 s subprocess cap", async () => {
    const { h, file } = fixture("");
    writeFileSync(file, JSON.stringify({ type: "session", padding: "x".repeat(33 * 1024 * 1024) }) + "\n" + user(prompt) + assistant());
    const base = h.proc;
    const proc = { run: (command: string, args: readonly string[], options: { cwd: string; timeoutMs?: number }) => {
      if (args.includes(file) && options.timeoutMs! <= 10_000) return Effect.succeed({ code: 124, stdout: "", stderr: "simulated read beyond 10 s" });
      return base.run(command, args, options);
    } };
    expect(await runWith(h, proveStartedPrompt(file, prompt, 1).pipe(Effect.provideService(Proc, proc)))).toMatchObject({ state: "proven" });
  });
  it("distinguishes unreadable slice from a missing inherited boundary", async () => {
    const { h, file } = fixture(user(prompt) + assistant());
    const proc = { run: () => Effect.succeed({ code: 1, stdout: "", stderr: "private output withheld" }) };
    expect(await runWith(h, proveStartedPrompt(file, prompt, 1).pipe(Effect.provideService(Proc, proc)))).toMatchObject({ state: "unproven", detail: expect.stringContaining("unreadable slice") });
    expect(await runWith(h, proveStartedPrompt(file, prompt, 20))).toMatchObject({ state: "unproven", detail: expect.stringContaining("wrong boundary") });
  });
  it("proves only the complete intended prompt and its clean first assistant", async () => {
    const { h, file } = fixture(user(prompt) + assistant());
    expect(await runWith(h, proveStartedPrompt(file, prompt, 1))).toMatchObject({ state: "proven" });
    expect(FIRST_TURN_MS).toBe(90_000);
  });
});
