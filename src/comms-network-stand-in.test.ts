import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("comms-network stand-in", () => {
  it("lets a Pi on older code restart: the lazy import resolves and pushes no bindings", async () => {
    const network = await import("./comms-network.ts");
    expect(network.liveRows()).toEqual([]);
    expect(await Effect.runPromise(network.provisionLiveRows())).toEqual([]);
  });
});
