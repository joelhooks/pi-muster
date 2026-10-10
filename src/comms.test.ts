import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { commsAddress, createComms, selectComms } from "./comms.ts";
import { fakeRatking } from "./ratking-fake.ts";
import { harness } from "./test-support.ts";

describe("Muster's only transport", () => {
  it.each([undefined, "ratking", "network", "intercom", "future"])("ignores hint %s", async hint => {
    const h = harness(); const sent: Array<{ to: string; message: string }> = [];
    const fake = fakeRatking(h.home, () => "me", sent);
    const comms = createComms({ ratking: () => fake.service });
    expect(selectComms(hint)).toBe("ratking");
    expect(await Effect.runPromise(comms.send("owner", "hello"))).toMatchObject({ status: "delivered" });
    expect(sent).toEqual([{ to: "owner", message: "hello" }]);
  });
  it("fails immediately when pi-ratking is absent and detects a reload at call time", async () => {
    const h = harness(); let loaded = false;
    const fake = fakeRatking(h.home, () => "me", []);
    const comms = createComms({ ratking: () => loaded ? fake.service : undefined });
    expect(await Effect.runPromise(comms.send("owner", "hello"))).toMatchObject({ status: "failed", detail: expect.stringContaining("pi-ratking not loaded") });
    loaded = true;
    expect(await Effect.runPromise(comms.send("owner", "hello"))).toMatchObject({ status: "delivered" });
  });
  it("validates qualified row names without resolving keys or leases", () => {
    expect(commsAddress("project/worker")).toEqual({ kind: "alias", project: "project", row: "worker" });
    expect(() => commsAddress("p/w/extra")).toThrow();
    expect(() => commsAddress("P/worker")).toThrow();
  });
});
