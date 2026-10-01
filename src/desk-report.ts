import { Schema } from "effect";

import { kindIcon, reportIcon } from "./desk-report-icons.ts";

/**
 * The desk report: when a desk holds several decisions for Joel, it publishes
 * one static feedback page instead of a chat digest. Each card asks one plain
 * question with its evidence both ways, one radio set per real decision axis,
 * and a note that overrides the ticks. `copy feedback` hands back compact JSON
 * keyed by desk item id, which `rulings` turns into one resolving line per item.
 * The contract lives in skills/muster/references/desk-report.md.
 */

export const REPORT_SCHEMA = "muster-desk-report.items.v1";
export const FEEDBACK_SCHEMA = "muster-desk-feedback.v1";

const Option = Schema.Struct({ v: Schema.String, label: Schema.String, then: Schema.String });

const Choice = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  suggest: Schema.String,
  options: Schema.Array(Option),
});

const Rows = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  /** `[value, label, ticked]` */
  items: Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.Boolean])),
});

const Card = Schema.Struct({
  id: Schema.String,
  extra_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  group: Schema.String,
  kind: Schema.String,
  age: Schema.String,
  title: Schema.String,
  why: Schema.String,
  timeline: Schema.String,
  shows: Schema.Array(Schema.String),
  not_shows: Schema.Array(Schema.String),
  drafts: Schema.optionalKey(Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String }))),
  choices: Schema.Array(Choice),
  rows: Schema.optionalKey(Rows),
  /** `[label, link]`: only the label reaches the page. */
  refs: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.String, Schema.NullOr(Schema.String)]))),
});

export const DeskReport = Schema.Struct({
  schema: Schema.String,
  slug: Schema.String,
  snapshot: Schema.String,
  /** Browser-state key; bump it when the cards change so old ticks do not leak onto new questions. */
  seed: Schema.String,
  title: Schema.optionalKey(Schema.String),
  /** One plain paragraph on what is going on. */
  intro: Schema.optionalKey(Schema.String),
  /** The one card that unblocks the most, in words. */
  doFirst: Schema.optionalKey(Schema.String),
  /** Lines of the `Before you act.` box. */
  before: Schema.optionalKey(Schema.Array(Schema.String)),
  privacyNote: Schema.optionalKey(Schema.String),
  refsNote: Schema.optionalKey(Schema.String),
  footer: Schema.optionalKey(Schema.String),
  expires: Schema.optionalKey(Schema.String),
  feedbackSchema: Schema.optionalKey(Schema.String),
  groups: Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String, desc: Schema.String })),
  items: Schema.Array(Card),
});
export type DeskReport = typeof DeskReport.Type;
export type ReportCard = DeskReport["items"][number];

export const decodeReport = Schema.decodeUnknownEffect(DeskReport);

const DEFAULTS = {
  title: "desk",
  intro: "These are the calls the desk won't make without you.",
  before: [
    "Before you act.",
    "Nothing here has executed.",
    "Suggested options are pre-ticked. They are recommendations, not actions.",
    "A note overrides the ticks when they conflict.",
    "Copy feedback, paste it to the desk. The owner re-checks every item first.",
  ],
  privacyNote: "Names are masked. Ticks and notes save in this browser until you reset.",
  refsNote: "Ask the desk for links.",
  footer: "Pasted feedback is intent only. The owner re-checks every item before acting.",
  expires: "48h",
} as const;

/** Python's html.escape, so pages match the reference generator byte for byte. */
export const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const e = escape;
const para = (text: string) => text.split("\n\n").map((p) => `<p>${e(p)}</p>`).join("");
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
const pad2 = (n: number) => String(n).padStart(2, "0");

export const deskIds = (card: ReportCard) => [card.id, ...(card.extra_ids ?? [])];

function renderCard(card: ReportCard, n: number, refsNote: string): string {
  const id = card.id;
  const out = [`<section class="item" id="i-${e(id)}" data-id="${e(id)}">`];
  out.push(`<h3>${pad2(n)}. ${e(card.title)}</h3>`);
  out.push(`<p><em>${kindIcon(card.kind)}${e(card.kind)} · ${e(deskIds(card).join(" + "))} · ${e(card.age)} old</em></p>`);
  out.push(`<p>${e(card.why)}</p>`);
  out.push(`<p><strong>So far.</strong> ${e(card.timeline)}</p>`);
  out.push(`<p><strong>Shows</strong></p><ul>${card.shows.map((s) => `<li>${e(s)}</li>`).join("")}</ul>`);
  out.push(`<p><strong>Does not show</strong></p><ul>${card.not_shows.map((s) => `<li>${e(s)}</li>`).join("")}</ul>`);
  for (const draft of card.drafts ?? []) {
    out.push(`<details><summary>Draft: ${e(draft.label)}</summary><blockquote>${para(draft.text)}</blockquote></details>`);
  }
  for (const choice of card.choices) {
    out.push(`<fieldset class="choice" data-key="${e(choice.key)}"><legend>${e(choice.label)}</legend>`);
    for (const option of choice.options) {
      const suggested = option.v === choice.suggest;
      const oid = e(`${id}-${choice.key}-${option.v}`);
      out.push(
        `<label class="opt" for="${oid}"><input type="radio" id="${oid}" name="${e(`${id}-${choice.key}`)}" value="${e(option.v)}"${suggested ? " checked" : ""}> ` +
          `<strong>${e(option.label)}</strong>${suggested ? " <em>(suggested)</em>" : ""} <span class="state"></span><br>` +
          `<small>then: ${e(option.then)}</small></label>`,
      );
    }
    out.push("</fieldset>");
  }
  if (card.rows) {
    const rows = card.rows;
    out.push(`<fieldset class="rows" data-key="${e(rows.key)}"><legend>${e(rows.label)}</legend>`);
    for (const [value, label, on] of rows.items) {
      const oid = e(`${id}-${rows.key}-${value}`);
      out.push(`<label class="opt" for="${oid}"><input type="checkbox" id="${oid}" value="${e(value)}"${on ? " checked" : ""}> ${e(label)} <span class="state"></span></label>`);
    }
    out.push("</fieldset>");
  }
  out.push(`<p><label for="${e(id)}-t">Note to the owner <em>(overrides the ticks if they conflict)</em></label><br>`);
  out.push(`<textarea id="${e(id)}-t" data-note rows="2" placeholder="rewrite, conditions, or a different call"></textarea></p>`);
  const refs = (card.refs ?? []).map(([label]) => e(label));
  if (refs.length) out.push(`<p><small>Threads: ${refs.join(" · ")}. ${e(refsNote)}</small></p>`);
  out.push("</section>");
  return out.join("\n");
}

/** The whole page. `css` is the ratstack stylesheet, inlined verbatim. */
export function renderReport(report: DeskReport, css: string): string {
  let n = 0;
  const body: string[] = [];
  const toc: string[] = [];
  const refsNote = report.refsNote ?? DEFAULTS.refsNote;
  for (const group of report.groups) {
    body.push(`<h2 id="g-${e(group.key)}">${reportIcon("group")}${e(capitalize(group.name))}</h2><p><em>${e(group.desc)}</em></p>`);
    for (const card of report.items.filter((item) => item.group === group.key)) {
      n += 1;
      toc.push(`<li><a href="#i-${e(card.id)}">${pad2(n)}. ${e(card.title)}</a></li>`);
      body.push(renderCard(card, n, refsNote));
    }
  }
  const nav = report.groups.map((group) => `<a href="#g-${e(group.key)}">${e(group.name)}</a>`).join(" · ");
  const count = report.items.reduce((sum, card) => sum + deskIds(card).length, 0);
  const fill: Record<string, string> = {
    CSS: css,
    TITLE: e(report.title ?? DEFAULTS.title),
    NAV: nav,
    SLUG: e(report.slug),
    SNAPSHOT: e(report.snapshot),
    SEED: e(report.seed),
    COUNT: String(count),
    INTRO: `<p>${e(report.intro ?? DEFAULTS.intro)}</p>`,
    BEFORE: `<pre><code>${reportIcon("before")}${(report.before ?? DEFAULTS.before).map(e).join("\n")}</code></pre>`,
    DOFIRST: report.doFirst ? `<p><strong>${reportIcon("doFirst")}Do first:</strong> ${e(report.doFirst)}</p>\n` : "",
    PRIVACY: e(report.privacyNote ?? DEFAULTS.privacyNote),
    EXPIRES: e(report.expires ?? DEFAULTS.expires),
    FOOTER: e(report.footer ?? DEFAULTS.footer),
    SCHEMA: e(report.feedbackSchema ?? FEEDBACK_SCHEMA),
    COPYICON: reportIcon("copy"),
    TOC: toc.join("\n"),
    BODY: body.join("\n"),
  };
  // One pass, so text inside a card can never be read as a placeholder.
  return TEMPLATE.replace(/%%([A-Z]+)%%/g, (whole, key: string) => fill[key] ?? whole);
}

/** A floor every page must clear before it is shared: no links, no email addresses. Projects add their own scan. */
export function redactionHits(html: string): string[] {
  const text = html.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
  return [...new Set([...(text.match(/https?:\/\/[^\s"<]+/g) ?? []), ...(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [])])];
}

export type FeedbackValue = string | readonly string[];
export interface Feedback {
  readonly schema: string;
  readonly page: string;
  readonly items: Readonly<Record<string, Readonly<Record<string, FeedbackValue>>>>;
}

export interface Ruling {
  readonly card: ReportCard;
  /** Every desk item the card covers; one ruling resolves them all. */
  readonly ids: readonly string[];
  readonly lines: readonly string[];
  readonly note: string | undefined;
}

/** Pasted feedback read against the page it came from. Cards Joel left alone come back in `unanswered`. */
export function rulings(report: DeskReport, feedback: Feedback): { rulings: Ruling[]; unanswered: ReportCard[]; unknown: string[] } {
  const known = new Set(report.items.flatMap(deskIds));
  const out: Ruling[] = [];
  const unanswered: ReportCard[] = [];
  for (const card of report.items) {
    const answer = deskIds(card).map((id) => feedback.items[id]).find(Boolean);
    if (!answer) {
      unanswered.push(card);
      continue;
    }
    const lines: string[] = [];
    for (const choice of card.choices) {
      const value = answer[choice.key];
      if (typeof value !== "string") {
        lines.push(`${choice.label}: no pick`);
        continue;
      }
      const option = choice.options.find((candidate) => candidate.v === value);
      lines.push(`${choice.label}: ${option ? option.label : value}${value === choice.suggest ? " (suggested)" : ""}`);
    }
    if (card.rows) {
      const picked = answer[card.rows.key];
      const values = Array.isArray(picked) ? picked : [];
      const labels = card.rows.items.filter(([value]) => values.includes(value)).map(([, label]) => label);
      lines.push(`${card.rows.label}: ${labels.length ? labels.join("; ") : "none"}`);
    }
    const t = answer.t;
    out.push({ card, ids: deskIds(card), lines, note: typeof t === "string" && t.trim() ? t.trim() : undefined });
  }
  return { rulings: out, unanswered, unknown: Object.keys(feedback.items).filter((id) => !known.has(id)) };
}

/** The resolving line's body: the ruling in words, the note last because it wins. */
export function rulingText(ruling: Ruling): string {
  return [...ruling.lines, ...(ruling.note ? [`Note (overrides the ticks): ${ruling.note}`] : [])].join("\n");
}

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>🐀 %%TITLE%%</title>
<style>
/* joel/ratstack-mdsvx app.css, verbatim */
%%CSS%%
/* desk controls, kept to browser defaults */
.desk-icon { display: inline-block; vertical-align: -0.15em; margin-right: 0.3em; }
.item { margin-bottom: 2rem; }
fieldset { margin: 1rem 0; }
.opt { display: block; padding: 0.4rem 0; }
.state::before { content: "[ ]"; }
.opt:has(input:checked) .state::before { content: "[x] selected"; font-weight: bold; }
textarea { box-sizing: border-box; font: inherit; width: 100%; }
blockquote { border-left: 1px solid; margin: 0.5rem 0; padding-left: 1rem; }
main { padding-bottom: 7rem; }
.bar { background: Canvas; border-top: 1px solid; bottom: 0; left: 0; padding: 0.5rem 1rem; position: fixed; right: 0; }
.bar div { margin: 0 auto; max-width: 80ch; }
button { font: inherit; }
#payload[hidden] { display: none; }
</style>
</head>
<body>
<header>
<nav aria-label="Primary navigation">%%NAV%%</nav>
<hr>
</header>
<main>
<h1>🐀 %%TITLE%%</h1>
<p><em>%%COUNT%% desk items waiting on you. Snapshot %%SNAPSHOT%%.</em></p>
%%INTRO%%
%%BEFORE%%
%%DOFIRST%%<p><small>%%PRIVACY%%</small></p>
<h2 id="waiting-on-you">Waiting on you</h2>
<ol>
%%TOC%%
</ol>

%%BODY%%

<pre id="payload" hidden></pre>
<hr>
<p><small>Page %%SLUG%%. noindex, expires in %%EXPIRES%%. %%FOOTER%%</small></p>
</main>
<div class="bar"><div>
<span id="count">loading</span><br>
<button id="copy" type="button">%%COPYICON%%<span>copy feedback</span></button>
<button id="show" type="button">show payload</button>
<button id="reset" type="button">reset</button>
</div></div>
<script>
(function(){
  var KEY = "%%SEED%%";
  var items = Array.prototype.slice.call(document.querySelectorAll('.item'));
  var defaults = {};
  items.forEach(function(it){ it.querySelectorAll('input').forEach(function(i){ defaults[i.id] = i.defaultChecked; }); });
  function payload(){
    var out = { schema:"%%SCHEMA%%", page:"%%SLUG%%", items:{} };
    items.forEach(function(it){
      var o = {};
      it.querySelectorAll('fieldset.choice').forEach(function(fs){ var c = fs.querySelector('input:checked'); if (c) o[fs.dataset.key] = c.value; });
      it.querySelectorAll('fieldset.rows').forEach(function(fs){ o[fs.dataset.key] = Array.prototype.map.call(fs.querySelectorAll('input:checked'), function(i){ return i.value; }); });
      var t = it.querySelector('[data-note]').value.trim(); if (t) o.t = t;
      out.items[it.dataset.id] = o;
    });
    return out;
  }
  function touched(it){
    var changed = false;
    it.querySelectorAll('input').forEach(function(i){ if (i.checked !== defaults[i.id]) changed = true; });
    if (it.querySelector('[data-note]').value.trim()) changed = true;
    
    return changed;
  }
  function save(){
    var s = { inputs:{}, notes:{} };
    document.querySelectorAll('.item input').forEach(function(i){ s.inputs[i.id] = i.checked; });
    document.querySelectorAll('[data-note]').forEach(function(t){ s.notes[t.id] = t.value; });
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch(e) {}
    var n = items.filter(touched).length;
    var notes = Array.prototype.filter.call(document.querySelectorAll('[data-note]'), function(t){ return t.value.trim(); }).length;
    document.getElementById('count').textContent = items.length + ' cards · ' + n + ' changed · ' + notes + ' notes';
    var p = document.getElementById('payload'); if (!p.hidden) p.textContent = JSON.stringify(payload(), null, 1);
  }
  try {
    var s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) {
      Object.keys(s.inputs||{}).forEach(function(id){ var i = document.getElementById(id); if (i) i.checked = s.inputs[id]; });
      Object.keys(s.notes||{}).forEach(function(id){ var t = document.getElementById(id); if (t) t.value = s.notes[id]; });
    }
  } catch(e) {}
  document.addEventListener('change', save);
  document.addEventListener('input', save);
  document.getElementById('show').onclick = function(){ var p = document.getElementById('payload'); p.hidden = !p.hidden; this.textContent = p.hidden ? 'show payload' : 'hide payload'; save(); if (!p.hidden) p.scrollIntoView({block:'center'}); };
  document.getElementById('reset').onclick = function(){
    if (!confirm('Reset every tick and note back to the suggestions?')) return;
    document.querySelectorAll('.item input').forEach(function(i){ i.checked = defaults[i.id]; });
    document.querySelectorAll('[data-note]').forEach(function(t){ t.value = ''; });
    save();
  };
  document.getElementById('copy').onclick = function(){
    var txt = JSON.stringify(payload()), b = this.querySelector('span');
    function done(){ b.textContent = 'copied ✓'; setTimeout(function(){ b.textContent = 'copy feedback'; }, 1600); }
    function fallback(){ var p = document.getElementById('payload'); p.hidden = false; p.textContent = txt; var r = document.createRange(); r.selectNodeContents(p); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); try { document.execCommand('copy'); done(); } catch(e) { b.textContent = 'select + copy below'; } }
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
  };
  save();
})();
</script>
</body>
</html>
`;
