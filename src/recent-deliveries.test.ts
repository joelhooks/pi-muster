import { describe, expect, it } from "vitest";
import { deliveryId, recentDeliveries } from "./recent-deliveries.ts";

describe("process-local inbound receipt index", () => {
  it("claims once, bounds the last 500 unique ids, and permits retry of an unhandled write", () => {
    const recent = recentDeliveries();
    expect(recent.claim("first")).toBe(true); expect(recent.claim("first")).toBe(false);
    for (let n = 0; n < 500; n++) expect(recent.claim(`message-${n}`)).toBe(true);
    expect(recent.size).toBe(500); expect(recent.has("first")).toBe(false);
    expect(recent.has("message-0")).toBe(true); expect(recent.claim("message-499")).toBe(false);
    recent.forget("message-499"); expect(recent.claim("message-499")).toBe(true);
  });
  it("rejects invalid window sizes and only extracts nonempty string delivery ids", () => {
    for (const limit of [0, -1, 1.5, NaN]) expect(() => recentDeliveries(limit)).toThrow();
    for (const event of [null, {}, { id: "" }, { id: 1 }, "id"]) expect(deliveryId(event)).toBeUndefined();
    expect(deliveryId({ id: "actual-id" })).toBe("actual-id");
  });
});
