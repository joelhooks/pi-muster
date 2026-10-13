import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { decodeProject } from "./domain.ts";
import { ratkingSend, RATKING_SEND_KIND } from "./comms-ratking.ts";
import { projectPath } from "./store.ts";
import { TurnLog, turnUnsupported } from "./turn-wake.ts";

export type PiPromptResult =
  | { outcome: "working" | "queued"; row: string; receipt: string }
  | { outcome: "refused"; row?: string; receipt?: string; reason: string };

type Events = Parameters<typeof ratkingSend>[0];

/** Claim synchronously, but only for this session's live catalog row. Never type into a Pi pane. */
export function registerPiPrompt(events: Events, options: {
  project: string | undefined;
  session: string;
  turns: TurnLog;
}) {
  return events.on("bellwether/pi-prompt/v1", payload => {
    if (typeof payload !== "object" || payload === null) return;
    const event = payload as { paneId?: unknown; terminalId?: unknown; target?: unknown; text?: unknown; claim?: unknown };
    if (typeof event.paneId !== "string" || typeof event.target !== "string" || typeof event.text !== "string" ||
      typeof event.claim !== "function" || (event.terminalId !== undefined && typeof event.terminalId !== "string") || !options.project) return;
    let project;
    try { project = decodeProject(JSON.parse(readFileSync(projectPath(options.project), "utf8"))); } catch { return; }
    const row = project.agents.find(row => row.state !== "closed" && row.owner === options.session &&
      row.pane !== null && row.pane.paneId === event.paneId &&
      (event.terminalId === undefined || row.pane.terminalId === undefined || row.pane.terminalId === event.terminalId));
    if (!row) return;
    const body = event.text;
    const deliver = async (): Promise<PiPromptResult> => {
      const unsupported = turnUnsupported(row);
      if (unsupported) return { outcome: "refused", row: row.name, reason: unsupported };
      const agent = `${project.slug}/${row.name}`;
      // Capture before sending: a working record may arrive before the send result does.
      const since = Date.now();
      const busy = options.turns.latest(agent)?.state === "working";
      try {
        const delivery = await Effect.runPromise(ratkingSend(events, randomUUID, {
          to: agent, kind: RATKING_SEND_KIND,
          body: JSON.stringify({ type: "message", recipient: row.sessionId, author: options.session, body }),
        }));
        if (delivery.status !== "delivered" || !delivery.id) return { outcome: "refused", row: row.name,
          reason: delivery.status === "delivered" ? "Rat King send returned no message id" : delivery.detail ?? "Rat King send failed" };
        const receipt = delivery.id;
        // S4 live proof, 2026-10-13: mail to a busy Pi runs as a follow-up inside its current run, so no new working
        // record comes; that run's done record, after the send, is the proof. Busy is judged before the send.
        if (busy) {
          if (await options.turns.waitWorking(agent, since, 30_000, true) || options.turns.latest(agent)?.state === "working") return { outcome: "queued", row: row.name, receipt };
        } else if (await options.turns.waitWorking(agent, since, 30_000)) return { outcome: "working", row: row.name, receipt };
        if (options.turns.latest(agent)?.state === "working") return { outcome: "queued", row: row.name, receipt };
        return { outcome: "refused", row: row.name, receipt,
          reason: `PromptUnproven: ${row.name} showed no working turn within 30 s of mail ${receipt}. Debug: comms_doctor row:"${row.name}"` };
      } catch (error) {
        return { outcome: "refused", row: row.name, reason: error instanceof Error ? error.message : String(error) };
      }
    };
    // Defer sending until after the synchronous claim.
    event.claim(Promise.resolve().then(deliver));
  });
}
