import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Effect } from "effect";

import { appendDesk, deskRecord, queuePath, readDesk } from "./desk.ts";
import { decodeReport, redactionHits, renderReport, rulingText, rulings } from "./desk-report.ts";
import type { DeskReport, Feedback } from "./desk-report.ts";
import { GuardFailed, InputError } from "./errors.ts";
import { MusterEnv, Proc } from "./runtime.ts";
import { openDeskItems } from "./tokens.ts";

/** ratstack.sh's stylesheet, from the wzrrd template. Read at build time, never vendored. */
export const RATSTACK_CSS = (home: string) => join(home, "Code", "joelhooks", "wzrrd-sh-cli", "templates", "joel", "ratstack-mdsvx", "template", "src", "app.css");

/** Used only when no ratstack stylesheet is on the machine: the same idea, plain monospace in an 80-column measure. */
const FALLBACK_CSS = `html { font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
body { box-sizing: border-box; margin: 0 auto; max-width: 80ch; padding: 1rem; }
`;

const SCAN_TIMEOUT_MS = 60_000;

const input = (message: string) => new InputError({ message });

const readReport = (path: string) =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({ try: () => JSON.parse(readFileSync(path, "utf8")) as unknown, catch: (error) => input(`cannot read report items ${path}: ${String(error)}`) });
    return yield* decodeReport(raw).pipe(Effect.mapError((error) => input(`report items ${path} do not match the desk report shape: ${String(error)}`)));
  });

export interface DeskReportInput {
  /** Items JSON, `muster-desk-report.items.v1`. */
  readonly report: string;
  /** Output folder; the page is written as index.html. */
  readonly out: string;
  readonly css?: string | undefined;
  /** The project's own redaction scan, run with PAGE set to the written page. A nonzero exit fails the build. */
  readonly scan?: string | undefined;
  readonly cwd?: string | undefined;
}

/**
 * Write the page, then refuse it unless it clears the privacy floor (no links,
 * no email addresses) and the project's scan. Publishing stays with the desk.
 */
export const deskReport = (params: DeskReportInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const proc = yield* Proc;
    const cwd = params.cwd ?? process.cwd();
    const report: DeskReport = yield* readReport(resolve(cwd, params.report));
    const cssPath = params.css ? resolve(cwd, params.css) : (process.env.MUSTER_DESK_REPORT_CSS ?? RATSTACK_CSS(env.home));
    const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : FALLBACK_CSS;
    const html = renderReport(report, css);

    const hits = redactionHits(html);
    if (hits.length) {
      return yield* new GuardFailed({ guard: "redaction", message: `the page would leak ${hits.length} link or address value(s); remove them from the items: ${hits.slice(0, 5).join(", ")}` });
    }
    const page = join(resolve(cwd, params.out), "index.html");
    mkdirSync(dirname(page), { recursive: true });
    writeFileSync(page, html, "utf8");
    if (params.scan) {
      const result = yield* proc.run("sh", ["-c", params.scan], { cwd, timeoutMs: SCAN_TIMEOUT_MS, env: { ...process.env, PAGE: page } as Record<string, string> });
      if (result.code !== 0) {
        return yield* new GuardFailed({ guard: "redaction", message: `scan failed (exit ${result.code}); the page at ${page} must not be shared:\n${`${result.stdout}\n${result.stderr}`.trim().slice(0, 800)}` });
      }
    }
    const ids = report.items.reduce((sum, card) => sum + 1 + (card.extra_ids?.length ?? 0), 0);
    return { page, cards: report.items.length, ids, css: existsSync(cssPath) ? cssPath : "built-in fallback", scanned: Boolean(params.scan) };
  });

export interface DeskRulingsInput {
  readonly project: string;
  readonly report: string;
  /** Joel's pasted feedback, as JSON text. */
  readonly feedback: string;
  readonly from?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly cwd?: string | undefined;
}

/**
 * Pasted feedback is operator intent. Each answered card resolves every desk
 * item it covers with the ruling in words; the owner gets one message and still
 * runs its own stale checks and gates before acting on any of it.
 */
export const deskRulings = (params: DeskRulingsInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const report = yield* readReport(resolve(params.cwd ?? process.cwd(), params.report));
    const feedback = yield* Effect.try({
      try: () => JSON.parse(params.feedback) as Feedback,
      catch: () => input("feedback is not JSON; paste exactly what copy feedback produced"),
    });
    if (!feedback || typeof feedback.items !== "object" || feedback.items === null) return yield* input("feedback has no items; paste exactly what copy feedback produced");
    if (feedback.page && feedback.page !== report.slug) return yield* input(`feedback is for page ${feedback.page}, not ${report.slug}; use that page's items`);

    const path = queuePath(params.project, env.home);
    const open = new Set(openDeskItems(readDesk(path)).map((item) => item.id));
    const result = rulings(report, feedback);
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const ruling of result.rulings) {
      const body = rulingText(ruling);
      for (const id of ruling.ids) {
        if (!open.has(id)) {
          skipped.push(`${id} (not open in ${params.project}'s queue)`);
          continue;
        }
        const title = `Ruled: ${ruling.card.title}`;
        const record = deskRecord(
          { from: params.from ?? "💬 desk", kind: "done", title: title.length <= 80 ? title : `${title.slice(0, 79)}…`, body, resolves: id },
          env.createId().slice(0, 8),
          env.now(),
        );
        if (!params.dryRun) appendDesk(path, record);
        applied.push(id);
      }
    }

    const owner = [
      `Joel's rulings from desk report ${report.slug}: ${result.rulings.length} card(s), ${applied.length} desk item(s) resolved. This is operator intent: re-run stale checks and exact-text gates before any send, charge, void or delete.`,
      ...result.rulings.map((ruling) => `\n[${ruling.ids.join(", ")}] ${ruling.card.title}\n${rulingText(ruling).replace(/^/gm, "  - ")}`),
    ].join("\n");
    return { applied, skipped, unanswered: result.unanswered.map((card) => card.id), unknown: result.unknown, owner, dryRun: Boolean(params.dryRun) };
  });
