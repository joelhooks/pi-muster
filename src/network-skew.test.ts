import { describe, expect, it, vi } from "vitest";

// Simulates a Pi that cached machines.ts before networkLeaseMachine existed.
vi.mock("./machines.ts", async importOriginal => ({ ...(await importOriginal<typeof import("./machines.ts")>()), networkLeaseMachine: undefined }));

describe("network comms under module skew", () => {
  it("detects a missing sibling import", async () => {
    const { networkModuleSkew } = await import("./comms-network.ts");
    expect(networkModuleSkew()).toBe(true);
    expect(networkModuleSkew([1, "x"])).toBe(false);
  });

  it("refuses to read config with a typed error instead of crashing later", async () => {
    const { readNetworkConfig, NETWORK_SKEW } = await import("./comms-network.ts");
    const { CommsError } = await import("./runtime.ts");
    let thrown: unknown;
    try { readNetworkConfig("/nonexistent-home"); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(CommsError);
    expect((thrown as Error).message).toBe(NETWORK_SKEW);
  });
});
