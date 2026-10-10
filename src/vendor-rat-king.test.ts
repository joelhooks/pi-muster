import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("restart-wave compatibility only", () => {
  it("removes all vendor code, fixtures and package allowlist entries", () => {
    expect(existsSync(new URL("./vendor/", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./__fixtures__/ratking-v0/", import.meta.url))).toBe(false);
    expect(readFileSync(new URL("../package.json", import.meta.url), "utf8")).not.toContain("src/vendor/");
  });
  it("retains only the inert comms-network non-phone restart imports, without phone open/identity exports", async () => {
    const standIn = await import("./comms-network.ts");
    expect(standIn.liveRows()).toEqual([]);
    expect(await Effect.runPromise(standIn.provisionLiveRows())).toEqual([]);
    expect(standIn).not.toHaveProperty("openNetworkMailbox"); expect(standIn).not.toHaveProperty("readNetworkIdentities");
  });
});
