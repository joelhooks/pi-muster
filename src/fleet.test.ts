import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { FleetStatus, busyQueue, gatesLine } from "./fleet.ts";

const now = Date.parse("2026-09-29T06:00:00Z");
const ticket = (id: string, project = "probe", hosts = ["flagg"], enqueuedAt = "2026-09-29T05:57:00Z") =>
  ({ id, project, repo: "repo", hosts, enqueuedAt });
const decode = Schema.decodeUnknownSync(FleetStatus);

describe("fleet status", () => {
  it("renders live slots, off hosts, and oldest queue age, ignoring extra fields", () => {
    const status = decode({ generatedAt: "ignored", machines: [
      { host: "flagg", reading: { state: "live", data: { slots: 4, load: 9, holders: [{ held: true }, { held: false }, { held: true }] } } },
      { host: "pennywise", reading: { state: "unavailable", reason: "offline" } },
    ], queue: [ticket("one")] });
    expect(gatesLine(status, now)).toBe("gates: flagg 2/4, pennywise off, 1 waiting (oldest 3m)");
  });
  it.each([null, {}, { slots: null }, { slots: 4, holders: null }, { slots: 4 }])("accepts nullable/missing data and holders: %j", (data) => {
    const status = decode({ machines: [{ host: "pennywise", reading: { state: "live", data } }], queue: [] });
    expect(gatesLine(status, now)).toBe(data?.slots === 4 ? "gates: pennywise 0/4" : "gates: pennywise off");
  });
  it("handles missing data and not-probed hosts, without an empty queue suffix", () => {
    expect(gatesLine(decode({ machines: [
      { host: "flagg", reading: { state: "live" } },
      { host: "pennywise", reading: { state: "not-probed" } },
    ], queue: [] }), now)).toBe("gates: flagg off, pennywise off");
  });
  it("orders per host by timestamp then id, accepting the runner's eligibleHosts", () => {
    const status = decode({ machines: [], queue: [
      { id: "b", project: "probe", repo: "repo", enqueuedAt: "2026-09-29T05:57:00Z", eligibleHosts: ["flagg", "pennywise"] },
      ticket("z", "other", ["pennywise"], "2026-09-29T05:56:00Z"),
      ticket("a", "other"),
    ] });
    expect(busyQueue(status, "probe", "repo", now)).toBe("queue position: flagg 2, pennywise 2; oldest waiter 4m");
    expect(busyQueue(status, "gone", "repo", now)).toBe("queue length: 3; oldest waiter 4m");
  });
  it("handles drained queues and clamps future timestamps", () => {
    expect(busyQueue(decode({ machines: [], queue: [] }), "probe", "repo", now)).toBe("queue length: 0; oldest waiter 0m");
    expect(gatesLine(decode({ machines: [], queue: [ticket("a", "probe", ["flagg"], "2026-09-29T07:00:00Z")] }), now)).toContain("oldest 0m");
  });
  it("rejects invalid fields used by the board", () => {
    expect(() => decode({ machines: [], queue: [ticket("a", "probe", ["flagg"], "bad")] })).toThrow();
    expect(() => decode({ machines: [{ host: "flagg", reading: { state: "live", data: { slots: -1 } } }], queue: [] })).toThrow();
  });
});
