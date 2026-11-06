import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boundedDetails, boundedToolResult, DETAILS_LIMIT, TEXT_LIMIT } from "./tool-result.ts";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe("persisted tool result bounds", () => {
  it("caps 5 MB details (plant: remove details cap)", () => {
    const value = { catalog: "x".repeat(5 * 1024 * 1024) };
    const result = boundedToolResult("unused", "project_status", "board", value);
    expect(result.details).toEqual({ ok: true, truncated: true, bytes: size(value), keys: ["catalog"], tool: "project_status" });
    expect(size(result.details)).toBeLessThan(DETAILS_LIMIT);
  });

  it("preserves small JSON values and the exact inclusive byte boundary", () => {
    for (const value of [{ ok: false, error: { _tag: "InputError", message: "bad input" } }, [1, null, true], "small", null, { text: "é".repeat(8190) }]) {
      if (size(value) <= DETAILS_LIMIT) expect(boundedDetails(value)).toEqual(value);
    }
    const value = "x".repeat(DETAILS_LIMIT - 2);
    expect(boundedDetails(value)).toEqual(value);
    expect(boundedDetails(value + "x")).toMatchObject({ truncated: true });
  });

  it("bounds pathological keys and preserves a failure's ok:false", () => {
    const value = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${"\u0000".repeat(1000)}${i}`, "value"]));
    expect(size(boundedDetails(value))).toBeLessThan(DETAILS_LIMIT);
    expect(boundedDetails({ ok: false, error: "x".repeat(5 * 1024 * 1024) })).toMatchObject({ ok: false, truncated: true });
  });

  it("caps text bytes, spills full UTF-8 privately, and never overwrites (plant: remove text cap)", () => {
    const home = mkdtempSync(join(tmpdir(), "muster-result-"));
    const body = "🐀\"\\\n".repeat(18000);
    const result = boundedToolResult(home, "project_status", body, {});
    const text = result.content[0]!.text;
    expect(Buffer.byteLength(text)).toBeLessThan(TEXT_LIMIT);
    const path = text.match(/Full text: (.+) \((\d+) bytes\)/)!;
    expect(path).not.toBeNull();
    expect(Number(path[2])).toBe(Buffer.byteLength(body));
    expect(readFileSync(path[1]!, "utf8")).toBe(body);
    expect(statSync(path[1]!).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".local", "state", "muster", "results")).mode & 0o777).toBe(0o700);
    const second = boundedToolResult(home, "project_status", body, {});
    expect(second.content[0]!.text).not.toBe(text);
    expect(readFileSync(path[1]!, "utf8")).toBe(body);
    expect(size(result)).toBeLessThan(64 * 1024);
  });

  it("retains at most 200 spills and seven days, leaving unrelated files alone", () => {
    const home = mkdtempSync(join(tmpdir(), "muster-retention-"));
    const body = "x".repeat(TEXT_LIMIT + 1);
    const first = boundedToolResult(home, "project_status", body, {});
    const firstFile = first.content[0]!.text.match(/Full text: (.+) \(/)![1]!;
    const dir = join(home, ".local", "state", "muster", "results");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(firstFile, old, old);
    writeFileSync(join(dir, "unrelated.txt"), "keep");
    for (let i = 0; i < 205; i += 1) boundedToolResult(home, "project_status", body, {});
    const files = readdirSync(dir);
    expect(files.filter(name => name !== "unrelated.txt")).toHaveLength(200);
    expect(files).not.toContain(firstFile.split("/").at(-1));
    expect(readFileSync(join(dir, "unrelated.txt"), "utf8")).toBe("keep");
  });

  it("returns the bounded preview when a spill cannot be written", () => {
    const home = mkdtempSync(join(tmpdir(), "muster-unwritable-"));
    const state = join(home, ".local", "state", "muster");
    mkdirSync(state, { recursive: true });
    const blocked = join(state, "results");
    writeFileSync(blocked, "preserve this file");
    const body = "x".repeat(TEXT_LIMIT + 1);
    const result = boundedToolResult(home, "project_status", body, { catalog: "x".repeat(5 * 1024 * 1024) });
    expect(result.content[0]!.text).toContain("[Truncated; full text not saved:");
    expect(result.content[0]!.text).toContain(`(${Buffer.byteLength(body)} bytes)]`);
    expect(result.content[0]!.text).toMatch(/^x{24576}\n\n\[Truncated;/);
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThan(TEXT_LIMIT);
    expect(result).toMatchObject({ details: { ok: true, truncated: true, tool: "project_status" } });
    expect(result).not.toHaveProperty("isError");
    expect(readFileSync(blocked, "utf8")).toBe("preserve this file");
  });

  it("does not touch disk for text at the limit", () => {
    const body = "é".repeat(TEXT_LIMIT / 2);
    expect(boundedToolResult("unused", "project_status", body, {}).content[0]!.text).toBe(body);
  });
});
