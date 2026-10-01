import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { queuePath, readDesk } from "./desk.ts";
import { deskReport, deskRulings } from "./desk-report-ops.ts";
import { registerSwitchboardSession } from "./switchboard-ops.ts";
import { FEEDBACK_SCHEMA, decodeReport, redactionHits, renderReport, rulingText, rulings } from "./desk-report.ts";
import { reportIcon } from "./desk-report-icons.ts";
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

/** Minimal form DOM: controls come from the HTML, behavior from its real script. */
function feedbackPage(html: string) {
  const inputs = new Map<string, { id: string; value: string; checked: boolean; defaultChecked: boolean }>();
  const notes = new Map<string, { id: string; value: string }>();
  const cards = [...html.matchAll(/<section class="item"[^>]*data-id="([^"]+)">([\s\S]*?)<\/section>/g)].map(([, id, body]) => {
    const fields = [...body!.matchAll(/<fieldset class="(choice|rows)" data-key="([^"]+)">([\s\S]*?)<\/fieldset>/g)].map(([, kind, key, contents]) => {
      const controls = [...contents!.matchAll(/<input\b[^>]+>/g)].map(([tag]) => {
        const input = { id: /id="([^"]+)"/.exec(tag)![1]!, value: /value="([^"]+)"/.exec(tag)![1]!, checked: / checked/.test(tag), defaultChecked: / checked/.test(tag) };
        inputs.set(input.id, input);
        return input;
      });
      return { kind, dataset: { key }, controls, querySelector: () => controls.find((input) => input.checked), querySelectorAll: () => controls.filter((input) => input.checked) };
    });
    const note = { id: /<textarea id="([^"]+)"/.exec(body!)![1]!, value: "" };
    notes.set(note.id, note);
    return {
      dataset: { id },
      querySelector: () => note,
      querySelectorAll: (selector: string) => selector === "input" ? fields.flatMap((field) => field.controls) : fields.filter((field) => selector === `fieldset.${field.kind}`),
    };
  });
  const label = { textContent: "copy feedback" };
  const elements = new Map(["copy", "show", "reset", "payload", "count"].map((id) => [id, { textContent: "", hidden: true, onclick: () => {}, querySelector: () => label }]));
  let copied = "";
  let resetCopyLabel = () => {};
  runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, {
    document: {
      querySelectorAll: (selector: string) => selector === ".item" ? cards : selector === ".item input" ? [...inputs.values()] : [...notes.values()],
      getElementById: (id: string) => elements.get(id) ?? inputs.get(id) ?? notes.get(id),
      addEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { clipboard: { writeText: (text: string) => { copied = text; return Promise.resolve(); } } },
    setTimeout: (callback: () => void) => { resetCopyLabel = callback; },
  });
  return {
    copy: async () => { elements.get("copy")!.onclick(); await Promise.resolve(); },
    copied: () => copied,
    copyLabel: () => label.textContent,
    resetCopyLabel: () => resetCopyLabel(),
    input: (id: string) => inputs.get(id)!,
    note: (id: string) => notes.get(id)!,
  };
}

describe("desk report page", () => {
  it("renders every card in group order with the suggestion ticked and all text escaped", () => {
    const html = renderReport(decoded, "/* css */");
    expect(html).not.toMatch(/%%[A-Z]+%%/);
    expect(html).toContain("<title>🐀 probe desk</title>");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
    expect(html).toContain("<em>4 desk items waiting on you. Snapshot Sep 30, 15:34 UTC.</em>");
    expect(html).toContain(`<p><strong>${reportIcon("doFirst")}Do first:</strong> 01, the pricing rule.</p>`);
    expect(html).toContain(`<h2 id="g-policy">${reportIcon("group")}Policy calls</h2>`);
    expect(html).toContain(`<em>${reportIcon("decision")}decision · p1 + p2 · 1d old</em>`);
    expect(html).toContain('value="yes" checked> <strong>Stacks</strong> <em>(suggested)</em>');
    expect(html).toContain('value="no"> <strong>Better of the two</strong> <span class="state">');
    expect(html).toContain("<li>Two proposals still say &lt;90 days&gt;.</li>");
    expect(html).toContain("<blockquote><p>Hi [name],</p><p>Thanks &amp; sorry.</p></blockquote>");
    expect(html).toContain('<input type="checkbox" id="o1-void-a" value="a" checked> Void A');
    expect(html).toContain("Threads: OL-1 in open-loops. Ask the desk for links.");
    expect(html).toContain(`schema:"${FEEDBACK_SCHEMA}"`);
    expect(html.indexOf("01. Does the credit")).toBeLessThan(html.indexOf("02. Void the stale"));
  });

  it("renders the fixed icon set beside words, without links or accessible decoration", () => {
    const kinds = ["decision", "approval", "blocked", "fyi"];
    const allKinds = { ...decoded, items: kinds.map((kind, i) => ({ ...decoded.items[0]!, id: `kind-${i}`, kind })) };
    const html = renderReport(allKinds, "");
    for (const kind of kinds) expect(html).toContain(`${reportIcon(kind as "decision" | "approval" | "blocked" | "fyi")}${kind} ·`);
    for (const group of decoded.groups) expect(html).toContain(`<h2 id="g-${group.key}">${reportIcon("group")}`);
    expect(html).toContain(`<pre><code>${reportIcon("before")}Before you act.`);
    expect(html).toContain(`${reportIcon("doFirst")}Do first:`);
    expect(html).toContain(`<button id="copy" type="button">${reportIcon("copy")}<span>copy feedback</span></button>`);
    const icons = html.match(/<svg\b[^>]*>/g)!;
    expect(icons).toHaveLength(9);
    for (const icon of icons) {
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('focusable="false"');
      expect(icon).toContain('width="1.1em" height="1.1em"');
      expect(icon).toContain('fill="none" stroke="currentColor"');
    }
    expect(html).toContain("vertical-align: -0.15em");
    expect(html).not.toMatch(/xmlns|<use\b|<img\b|<svg[^>]*href/);
    expect(redactionHits(html)).toEqual([]);
  });

  it("preserves custom caution text and unknown kinds without changing the schema", () => {
    const html = renderReport({ ...decoded, before: ["Stop <here>.", "Read first."], doFirst: undefined, items: [{ ...decoded.items[0]!, kind: "custom" }] }, "");
    expect(html).toContain(`<pre><code>${reportIcon("before")}Stop &lt;here&gt;.\nRead first.</code></pre>`);
    expect(html).toContain("<em>custom · p1 + p2 · 1d old</em>");
    expect(html).not.toContain('data-icon="doFirst"');
  });

  it("copies byte-identical pre-icon feedback for defaults and edited choices, rows, and notes", async () => {
    // Captured from this fixture's page before icons. Run the actual page script
    // against its rendered form controls; SVG never participates in the payload.
    const page = feedbackPage(renderReport(decoded, ""));
    await page.copy();
    expect(page.copied()).toBe('{"schema":"muster-desk-feedback.v1","page":"probe-desk-2026-09-30-abc","items":{"p1":{"stack":"yes"},"o1":{"void":["a"]},"o2":{"post":"drop"}}}');
    expect(page.copyLabel()).toBe("copied ✓");
    page.resetCopyLabel();
    expect(page.copyLabel()).toBe("copy feedback");
    page.input("p1-stack-yes").checked = false;
    page.input("p1-stack-no").checked = true;
    page.input("o1-void-a").checked = false;
    page.input("o1-void-b").checked = true;
    page.note("p1-t").value = "  only for teams over 10  ";
    await page.copy();
    expect(page.copied()).toBe('{"schema":"muster-desk-feedback.v1","page":"probe-desk-2026-09-30-abc","items":{"p1":{"stack":"no","t":"only for teams over 10"},"o1":{"void":["b"]},"o2":{"post":"drop"}}}');
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
    registerSwitchboardSession(h.home, "switchboard-session");
    h.live = ["switchboard-session"];

    const preview = await runWith(h, deskRulings({ project: "probe", report: items, feedback, dryRun: true, cwd: h.root }));
    expect(preview.applied).toEqual(["p1", "o1"]);
    expect(h.sent).toEqual([]);
    expect(openDeskItems(readDesk(queuePath("probe", h.home))).map((item) => item.id)).toEqual(["p1", "o1", "o2"]);

    const done = await runWith(h, deskRulings({ project: "probe", report: items, feedback, cwd: h.root }));
    expect(done.skipped).toEqual(["p2 (not open in probe's queue)"]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent.every((sent) => sent.to === "switchboard-session" && sent.message.includes("resolved"))).toBe(true);
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
