import { describe, expect, it } from "vitest";
import { decodeProject } from "./domain.ts";
import { flowLine } from "./tokens.ts";

const before = "2026-10-05T04:14:02Z";
const cutoff = "2026-10-05T04:14:03Z";
const after = "2026-10-05T04:14:04Z";
const lane = {
  slug: "work", kind: "work", label: "work", goal: "ship", writeScope: [],
  repo: null, generated: [], tabId: null, root: null, state: "closed",
  archived: false, createdAt: "2026-10-05T03:00:00Z", updatedAt: after,
};
const packet = {
  id: "packet", kind: "commit", lane: "work", agent: "worker", artifact: null,
  report: "/report.md", checks: [], state: "committed", verification: null,
  landedAs: "abc123", reportedAt: before, updatedAt: after,
};
const project = {
  version: 1, slug: "probe", label: "probe", dir: "/project", outcome: "ship",
  reviewTrigger: "weekly", criticalPath: [], nextAction: "prove", mode: "rift-merge",
  spaceId: null, sidebar: "off", ephemeral: false, musterExtension: null,
  deskExtension: null, cadenceMinutes: null, state: "active", lanes: [lane],
  agents: [], packets: [packet], reviews: [], createdAt: before, updatedAt: after,
};

describe("missing delivery backfill", () => {
  it("does not prove work committed after done-live shipped", () => {
    expect(decodeProject(project).lanes[0]).toMatchObject({
      delivery: "landed", deliveryAt: after,
      deliveryEvidence: "delivery record missing (written by an older Muster); not proven",
      deliveryHistory: [{ stage: "landed", at: after, evidence: "delivery record missing (written by an older Muster); not proven" }],
    });
  });

  it("keeps pre-cutoff work proven with its original evidence", () => {
    expect(decodeProject({ ...project, packets: [{ ...packet, updatedAt: before }] }).lanes[0]).toMatchObject({
      delivery: "proven", deliveryAt: before, deliveryEvidence: "before done-live",
      deliveryHistory: [{ stage: "proven", at: before, evidence: "before done-live" }],
    });
  });

  it("treats a commit exactly at the cutoff as landed", () => {
    expect(decodeProject({ ...project, packets: [{ ...packet, updatedAt: cutoff }] }).lanes[0]?.delivery).toBe("landed");
  });

  it("uses the newest committed packet, not packet order or uncommitted work", () => {
    const newer = { ...packet, id: "newer", updatedAt: after };
    const older = { ...packet, id: "older", updatedAt: before };
    for (const packets of [[newer, older], [older, newer]]) {
      expect(decodeProject({ ...project, packets }).lanes[0]).toMatchObject({ delivery: "landed", deliveryAt: after });
    }
    expect(decodeProject({ ...project, packets: [older, { ...newer, state: "verified" }] }).lanes[0]?.delivery).toBe("proven");
  });

  it("compares instants, including equivalent timestamps with offsets", () => {
    const offsetAfter = "2026-10-04T21:14:04-07:00";
    expect(decodeProject({ ...project, packets: [{ ...packet, updatedAt: offsetAfter }, { ...packet, id: "old", updatedAt: before }] }).lanes[0])
      .toMatchObject({ delivery: "landed", deliveryAt: offsetAfter });
  });

  it("leaves lanes without a committed packet at none", () => {
    for (const packets of [[], [{ ...packet, state: "verified" }], [{ ...packet, lane: "other" }]]) {
      const decoded = decodeProject({ ...project, packets }).lanes[0];
      expect(decoded?.delivery).toBe("none");
      expect(decoded?.deliveryHistory).toBeUndefined();
      expect(decoded?.deliveryAt).toBeUndefined();
      expect(decoded?.deliveryEvidence).toBeUndefined();
    }
  });

  it.each(["none", "landed", "deployed", "proven", "waived"])("preserves explicit %s delivery", delivery => {
    const explicit = { ...lane, base: null, delivery, deliveryAt: before, deliveryEvidence: "owner record",
      deliveryHistory: [{ stage: delivery, at: before, evidence: "owner record" }] };
    expect(decodeProject({ ...project, lanes: [explicit] }).lanes[0]).toEqual(explicit);
  });

  it("does not count missing post-cutoff proof in flow metrics", () => {
    const line = flowLine(decodeProject(project), Date.parse(after));
    expect(line).toContain("landed, not live: work");
    expect(line).not.toContain("last proven");
    expect(line).not.toContain("cycle");
    expect(line).not.toContain("/wk");
    const legacyLine = flowLine(decodeProject({ ...project, packets: [{ ...packet, updatedAt: before }] }), Date.parse(after));
    expect(legacyLine).toContain("last proven");
    expect(legacyLine).toContain("cycle");
    expect(legacyLine).toContain("1/wk");
  });
});
