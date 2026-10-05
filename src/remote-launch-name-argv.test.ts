import { describe, expect, it } from "vitest";
import { buildArgv, profileFor } from "./argv.ts";
import { decodeSessionEntryCount } from "./domain.ts";

const profile = profileFor("worker", { label: "worker" });
const base = { sessionId: "child", sessionFile: "/sessions/child.jsonl", parentSessionFile: "/sessions/parent.jsonl", profile, musterExtension: "/muster" };

describe("start argv messages", () => {
  it.each(["launch", "fork", "restore"] as const)("puts an explicit %s message after the options terminator", kind => {
    const argv = buildArgv({ ...base, kind, prompt: "--tools" });
    expect(argv.slice(-2)).toEqual(["--", "--tools"]);
    expect(argv.indexOf("--approve")).toBeLessThan(argv.indexOf("--"));
  });

  it("uses @brief plus role text as one initial message", () => {
    const argv = buildArgv({ ...base, kind: "launch", promptFile: "/brief.md", prompt: "Role instructions." });
    expect(argv.slice(-3)).toEqual(["--", "@/brief.md", "Role instructions."]);
  });

  it("decodes only non-negative integer inherited-entry counts", () => {
    expect(decodeSessionEntryCount(0)).toBe(0);
    expect(decodeSessionEntryCount(12)).toBe(12);
    for (const value of [-1, 1.5, "12", NaN, Infinity]) expect(() => decodeSessionEntryCount(value)).toThrow();
  });

  it("keeps the saved restore argv message-free", () => {
    const argv = buildArgv({ ...base, kind: "restore" });
    expect(argv).toContain("--session");
    expect(argv).not.toContain("--");
    expect(argv.some(arg => arg.startsWith("@"))).toBe(false);
  });
});
