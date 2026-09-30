import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { queuePath, readDesk } from "./desk.ts";
import { deskReport, deskRulings } from "./desk-report-ops.ts";
import { FEEDBACK_SCHEMA, decodeReport, redactionHits, renderReport, rulingText, rulings } from "./desk-report.ts";
import type { DeskItem } from "./domain.ts";
import { failWith, harness, runWith } from "./test-support.ts";
import { openDeskItems } from "./tokens.ts";

const report = {
  schema: "muster-desk-report.items.v1",
  slug: "probe-desk-2026-09-30-abc",
  snapshot: "Sep 30, 15:34 UTC",
  seed: "probe-desk-v1",
  title: "probe desk",
  doFirst: "01, the pricing rule.",
  groups: [
    { key: "policy", name: "policy calls", desc: "Answer these first." },
    { key: "ops", name: "housekeeping", desc: "Internal only." },
  ],
  items: [
    {
      id: "p1",
      extra_ids: ["p2"],
      group: "policy",
      kind: "decision",
      age: "1d",
      title: "Does the credit stack with team tiers?",
      why: "Blocks every team pitch.",
      timeline: "Ruled on the credit, left stacking open.",
      shows: ["Two proposals still say <90 days>."],
      not_shows: ["No seat data yet."],
      drafts: [{ label: "sample", text: "Hi [name],\n\nThanks & sorry." }],
      choices: [
        {
          key: "stack",
          label: "Stacking",
          suggest: "yes",
          options: [
            { v: "yes", label: "Stacks", then: "One formula for every pitch." },
            { v: "no", label: "Better of the two", then: "Simpler margin." },
          ],
        },
      ],
      refs: [["OL-1 in open-loops", null]],
    },
    {
      id: "o1",
      group: "ops",
      kind: "approval",
      age: "3h",
      title: "Void the stale invoices?",
      why: "They distort receivables.",
      timeline: "Flagged twice.",
      shows: ["Four invoices past 90 days."],
      not_shows: ["Whether any customer still intends to pay."],
      choices: [],
      rows: { key: "void", label: "Which to void", items: [["a", "Void A", true], ["b", "Void B", false]] },
    },
    {
      id: "o2",
      group: "ops",
      kind: "decision",
      age: "2h",
      title: "Drop the old post?",
      why: "Clutter.",
      timeline: "Drafted once.",
      shows: [],
      not_shows: [],
      choices: [{ key: "post", label: "Post", suggest: "drop", options: [{ v: "drop", label: "Drop it", then: "Gone." }] }],
    },
  ],
};

const decoded = Effect.runSync(decodeReport(report));
const plainItem = (id: string, kind: DeskItem["kind"]): DeskItem => ({ id, ts: "2026-09-29T05:00:00.000Z", from: "🦅 hawk", kind, title: `item ${id}` });

describe("desk report page", () => {
  it("renders every card in group order with the suggestion ticked and all text escaped", () => {
    const html = renderReport(decoded, "/* css */");
    expect(html).not.toMatch(/%%[A-Z]+%%/);
    expect(html).toContain("<title>🐀 probe desk</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
    expect(html).toContain("<em>4 desk items waiting on you. Snapshot Sep 30, 15:34 UTC.</em>");
    expect(html).toContain("<p><strong>Do first:</strong> 01, the pricing rule.</p>");
    expect(html).toContain('<h2 id="g-policy">Policy calls</h2>');
    expect(html).toContain("<em>decision · p1 + p2 · 1d old</em>");
    expect(html).toContain('value="yes" checked> <strong>Stacks</strong> <em>(suggested)</em>');
    expect(html).toContain('value="no"> <strong>Better of the two</strong> <span class="state">');
    expect(html).toContain("<li>Two proposals still say &lt;90 days&gt;.</li>");
    expect(html).toContain("<blockquote><p>Hi [name],</p><p>Thanks &amp; sorry.</p></blockquote>");
    expect(html).toContain('<input type="checkbox" id="o1-void-a" value="a" checked> Void A');
    expect(html).toContain("Threads: OL-1 in open-loops. Ask the desk for links.");
    expect(html).toContain(`schema:"${FEEDBACK_SCHEMA}"`);
    expect(html.indexOf("01. Does the credit")).toBeLessThan(html.indexOf("02. Void the stale"));
  });

  it("refuses pages that would leak links or email addresses, ignoring its own script", () => {
    expect(redactionHits(renderReport(decoded, ""))).toEqual([]);
    const leaky = Effect.runSync(decodeReport({ ...report, intro: "See https://example.com/x or mail a@b.co" }));
    expect(redactionHits(renderReport(leaky, ""))).toEqual(["https://example.com/x", "a@b.co"]);
  });

  it("reads feedback back as rulings in words, note last, rows by label", () => {
    const result = rulings(decoded, {
      schema: FEEDBACK_SCHEMA,
      page: report.slug,
      items: { p1: { stack: "no", t: "only for teams over 10" }, o1: { void: ["a", "b"] }, zz: {} },
    });
    expect(result.rulings.map((ruling) => ruling.ids)).toEqual([["p1", "p2"], ["o1"]]);
    expect(rulingText(result.rulings[0]!)).toBe("Stacking: Better of the two\nNote (overrides the ticks): only for teams over 10");
    expect(rulingText(result.rulings[1]!)).toBe("Which to void: Void A; Void B");
    expect(result.unanswered.map((card) => card.id)).toEqual(["o2"]);
    expect(result.unknown).toEqual(["zz"]);
  });
});

describe("desk report tools", () => {
  const setup = () => {
    const h = harness();
    const items = join(h.root, "items.json");
    writeFileSync(items, JSON.stringify(report));
    mkdirSync(join(h.home, ".local", "state", "herdr-desk"), { recursive: true });
    writeFileSync(queuePath("probe", h.home), `${["p1", "p2", "o1", "o2"].map((id) => JSON.stringify(plainItem(id, "decision"))).join("\n")}\n${JSON.stringify({ ...plainItem("x", "done"), resolves: "p2" })}\n`);
    return { h, items };
  };

  it("desk_report writes the page and fails closed on a leak or a failing project scan", async () => {
    const { h, items } = setup();
    const built = await runWith(h, deskReport({ report: items, out: join(h.root, "page"), scan: 'grep -q "probe desk" "$PAGE"', cwd: h.root }));
    expect(built).toMatchObject({ cards: 3, ids: 4, css: "built-in fallback", scanned: true });
    expect(readFileSync(built.page, "utf8")).toContain("max-width: 80ch");

    const failed = await failWith(h, deskReport({ report: items, out: join(h.root, "page2"), scan: "exit 3", cwd: h.root }));
    expect(failed).toMatchObject({ _tag: "GuardFailed", guard: "redaction" });
    const leaky = join(h.root, "leaky.json");
    writeFileSync(leaky, JSON.stringify({ ...report, footer: "ping joel@example.com" }));
    expect(await failWith(h, deskReport({ report: leaky, out: join(h.root, "page3"), cwd: h.root }))).toMatchObject({ _tag: "GuardFailed" });
  });

  it("desk_rulings resolves each open item a ruling covers, skips the rest, and drafts one owner message", async () => {
    const { h, items } = setup();
    const feedback = JSON.stringify({ schema: FEEDBACK_SCHEMA, page: report.slug, items: { p1: { stack: "yes" }, o1: { void: ["a"] } } });

    const preview = await runWith(h, deskRulings({ project: "probe", report: items, feedback, dryRun: true, cwd: h.root }));
    expect(preview.applied).toEqual(["p1", "o1"]);
    expect(openDeskItems(readDesk(queuePath("probe", h.home))).map((item) => item.id)).toEqual(["p1", "o1", "o2"]);

    const done = await runWith(h, deskRulings({ project: "probe", report: items, feedback, cwd: h.root }));
    expect(done.skipped).toEqual(["p2 (not open in probe's queue)"]);
    expect(done.unanswered).toEqual(["o2"]);
    expect(done.owner).toContain("[p1, p2] Does the credit stack with team tiers?\n  - Stacking: Stacks (suggested)");
    expect(done.owner).toContain("re-run stale checks");
    const queue = readDesk(queuePath("probe", h.home));
    expect(openDeskItems(queue).map((item) => item.id)).toEqual(["o2"]);
    expect(queue.at(-1)).toMatchObject({ kind: "done", from: "💬 desk", resolves: "o1", title: "Ruled: Void the stale invoices?", body: "Which to void: Void A" });

    const wrong = await failWith(h, deskRulings({ project: "probe", report: items, feedback: JSON.stringify({ page: "other", items: {} }), cwd: h.root }));
    expect(wrong.message).toContain("feedback is for page other");
    expect((await failWith(h, deskRulings({ project: "probe", report: items, feedback: "not json", cwd: h.root }))).message).toContain("not JSON");
  });
});
