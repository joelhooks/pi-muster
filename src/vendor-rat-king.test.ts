import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("restart-wave compatibility only", () => {
  it("removes all vendor code, fixtures and package allowlist entries", () => {
    expect(existsSync(new URL("./vendor/", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./__fixtures__/ratking-v0/", import.meta.url))).toBe(false);
    expect(readFileSync(new URL("../package.json", import.meta.url), "utf8")).not.toContain("src/vendor/");
  });
  it("drops the comms-network restart stand-in once every Pi loads post-fb2b29b code", () => {
    expect(existsSync(new URL("./comms-network.ts", import.meta.url))).toBe(false);
    expect(readFileSync(new URL("../package.json", import.meta.url), "utf8")).not.toContain("comms-network");
  });
});
