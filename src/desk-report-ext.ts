// No Pi TUI pattern applies: these tools build HTML and return plain receipts.
// Keep Pi's stock renderer; shared-shell/status-ribbon would add unrelated UI.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { deskReport, deskRulings } from "./desk-report-ops.ts";
import type { SwitchboardDeps } from "./switchboard-ext.ts";

/** The desk report tools. Any project desk can publish one; the contract is skills/muster/references/desk-report.md. */
export function registerDeskReport(pi: ExtensionAPI, deps: Pick<SwitchboardDeps, "run">) {
  pi.registerTool({
    name: "desk_report",
    label: "Desk report page",
    description:
      "Build the desk report page (ratstack look, one card per decision, copy-feedback JSON) from items JSON in the muster-desk-report.items.v1 shape. Refuses a page that holds links or email addresses, and runs the project's own redaction scan when given (PAGE is the page without Muster's icons; PAGE_HTML is the page as written). Writes <out>/index.html; publishing, noindex and expiry stay with the desk.",
    promptSnippet: "desk_report: build Joel's desk feedback page from report items",
    parameters: Type.Object({
      report: Type.String({ description: "Items JSON path" }),
      out: Type.String({ description: "Output folder for index.html" }),
      scan: Type.Optional(Type.String({ description: "Project redaction scan command; nonzero exit fails the build" })),
      css: Type.Optional(Type.String({ description: "Stylesheet override; default is ratstack's app.css" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return deps.run(ctx, signal, deskReport({ ...params, cwd: ctx.cwd }), (value) =>
        `Wrote ${value.page}: ${value.cards} cards covering ${value.ids} desk items. Style: ${value.css}. Redaction floor passed${value.scanned ? ", project scan passed" : "; no project scan given"}. Before sharing: publish noindex with a 48h expiry, check HTTP 200 and x-robots-tag, and look at the rendered page.`,
      );
    },
  });

  pi.registerTool({
    name: "desk_rulings",
    label: "Desk report rulings",
    description:
      "Turn Joel's pasted desk report feedback into rulings: each answered card resolves every desk item it covers in the project's queue with the ruling in words, and the result carries one message for the owner. Feedback is operator intent; the owner still runs stale checks and gates. dryRun previews without writing.",
    parameters: Type.Object({
      project: Type.String({ description: "Desk queue slug" }),
      report: Type.String({ description: "The items JSON the page was built from" }),
      feedback: Type.String({ description: "Joel's pasted feedback JSON, verbatim" }),
      from: Type.Optional(Type.String({ description: "Sender on the resolving lines; default 💬 desk" })),
      dryRun: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return deps.run(ctx, signal, deskRulings({ ...params, cwd: ctx.cwd }), (value) =>
        [
          `${value.dryRun ? "Would resolve" : "Resolved"} ${value.applied.length} desk item(s).`,
          value.skipped.length ? `Skipped: ${value.skipped.join(", ")}.` : "",
          value.unanswered.length ? `No feedback for cards: ${value.unanswered.join(", ")}.` : "",
          value.unknown.length ? `Feedback ids not on the page: ${value.unknown.join(", ")}.` : "",
          "",
          "Send the owner this one message:",
          value.owner,
        ]
          .filter((line, index) => line || index === 4)
          .join("\n"),
      );
    },
  });
}
