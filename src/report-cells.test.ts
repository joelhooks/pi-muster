import { marked, type Tokens } from "marked";
import { describe, expect, it } from "vitest";
import { reportMarkdown } from "./ops.ts";

const row = { name: "worker", lane: "one", cwd: "/repo", clone: null } as Parameters<typeof reportMarkdown>[0];
const samples = ["&&", "a | b", "<T>", "{x}", "a ` b", "```", "first\nsecond", "&amp; &#124;", "\\| *bold* _em_ [link](url)", "<script>{x}</script>"];

// Decode text nodes after GFM inline parsing, with <br> representing a visual newline.
// Do not decode twice: worker-written entity strings must remain literal.
function renderedText(html: string): string {
  return html.replace(/<br\s*\/?\s*>/g, "\n").replace(/<[^>]*>/g, "")
    .replace(/&(?:#(\d+)|amp|lt|gt|quot);/g, (entity, number: string | undefined) =>
      number ? String.fromCodePoint(Number(number)) : ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' }[entity] ?? entity));
}

function report(text: string) {
  return reportMarkdown(row, { id: "abc", kind: "artifact", artifact: "/artifact", checks: [{ name: text, outcome: "pass", detail: text }] }, text, text,
    { deploy: text, proof: text, signals: { working: text, failing: text, where: text } });
}

function table(source: string) {
  const token = marked.lexer(source).find(token => token.type === "table");
  if (!token || token.type !== "table") throw new Error("Missing checks table");
  return token as Tokens.Table;
}

function inlineText(source: string) {
  return renderedText(marked.parseInline(source, { async: false }));
}

describe("report cell fidelity", () => {
  it.each(samples)("round-trips GFM cells containing %j", text => {
    const source = report(text);
    const checks = table(source);
    expect(checks.header).toHaveLength(3);
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0]).toHaveLength(3);
    expect(checks.rows[0]!.map(cell => inlineText(cell.text))).toEqual([text, "pass", text]);
    // The same rule applies to signals and metadata, not just table cells.
    const signal = source.split("- Working: ")[1]!.split("\n")[0]!;
    expect(inlineText(signal)).toBe(text);
    expect(checks.rows[0]![2]!.text).not.toMatch(/[{}]/);
  });

  it.each(samples)("preserves fenced deploy, proof and notes containing %j", text => {
    const source = report(text);
    for (const title of ["Deploy", "Live proof", "Notes"]) {
      const section = source.split(`## ${title}\n\n`)[1]!.split("\n\n## ")[0]!;
      const code = marked.lexer(section).find(token => token.type === "code");
      expect((code as Tokens.Code | undefined)?.text).toBe(text);
    }
  });

  it("still parses the existing entity-in-code report format without rewriting it", () => {
    const legacy = '---\ntitle: "Packet abc from worker"\npacket: "abc"\nlane: "one"\n---\n\n# Packet abc from ``` worker ```\n\n## Checks\n\n| Check | Outcome | Detail |\n| --- | --- | --- |\n| ``` gate ``` | pass | ``` npm run check &amp;&amp; a &#124; b ``` |\n';
    const checks = table(legacy);
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0]!.map(cell => inlineText(cell.text))).toEqual(["gate", "pass", "npm run check &amp;&amp; a &#124; b"]);
  });
});
