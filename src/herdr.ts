import { Effect, Schedule } from "effect";
import {
  HERDR_TRANSPORT_GRACE_MS,
  type HerdrError,
  type HerdrMethod,
  type HerdrRequest,
  type HerdrResultFor,
} from "@joelhooks/pi-bellwether/herdr-client";

import { HerdrFailure } from "./errors.ts";
import { Herdr, MusterEnv } from "./runtime.ts";
import { modelOutputIssue } from "./models.ts";

/**
 * The Herdr operations Muster needs, over Bellwether's socket client. Every
 * Herdr error becomes one typed `HerdrFailure` carrying Herdr's `error.code`;
 * nothing classifies errors from message text.
 */

export const PROOF_OF_LIFE_MS = 30_000;
const NAME_READY_STEP_MS = 500;
const NAME_READY_TRIES = 20;
const START_TIMEOUT_MS = 60_000;

type PaneInfo = HerdrResultFor<"pane.get">["pane"];
type AgentInfo = HerdrResultFor<"agent.get">["agent"];
export type { AgentInfo, PaneInfo };

function toFailure(error: HerdrError): HerdrFailure {
  return new HerdrFailure({
    operation: error.operation,
    code: error._tag === "HerdrApiError" ? error.code : null,
    message: `${error._tag}: ${error.message}`,
  });
}

export function call<M extends HerdrMethod>(request: HerdrRequest<M>): Effect.Effect<HerdrResultFor<M>, HerdrFailure, Herdr> {
  return Effect.gen(function* () {
    const client = yield* Herdr;
    return yield* client.request(request).pipe(Effect.mapError(toFailure));
  });
}

export const isCode = (error: HerdrFailure, ...codes: string[]) => error.code !== null && codes.includes(error.code);

export const paneGet = (paneId: string) =>
  call({ method: "pane.get", params: { pane_id: paneId } }).pipe(
    Effect.map((result): PaneInfo | null => result.pane),
    Effect.catchIf(
      (error) => isCode(error, "pane_not_found", "not_found"),
      () => Effect.succeed(null),
    ),
  );

export const paneList = (workspaceId?: string) =>
  call({ method: "pane.list", params: workspaceId ? { workspace_id: workspaceId } : {} }).pipe(
    Effect.map((result) => (workspaceId ? result.panes.filter((pane) => pane.workspace_id === workspaceId) : result.panes)),
  );

export const workspaceList = () => call({ method: "workspace.list" }).pipe(Effect.map((result) => result.workspaces));

export const workspaceRename = (workspaceId: string, label: string) =>
  call({ method: "workspace.rename", params: { workspace_id: workspaceId, label } }).pipe(Effect.asVoid);

export const workspaceCreate = (label: string, cwd: string) =>
  call({ method: "workspace.create", params: { cwd, focus: false, label, env: {} } });

export const tabCreate = (workspaceId: string, cwd: string, label: string) =>
  call({ method: "tab.create", params: { workspace_id: workspaceId, cwd, focus: false, label, env: {} } });

export const paneSplit = (targetPaneId: string, direction: "right" | "down", cwd: string) =>
  call({ method: "pane.split", params: { target_pane_id: targetPaneId, direction, cwd, focus: false, env: {} } }).pipe(
    Effect.map((result) => result.pane),
  );

export const paneRename = (paneId: string, label: string) =>
  call({ method: "pane.rename", params: { pane_id: paneId, label } }).pipe(Effect.asVoid);

/** Types one line into the pane's shell and presses Enter. */
export const paneRun = (paneId: string, text: string) =>
  call({ method: "pane.send_input", params: { pane_id: paneId, text, keys: ["Enter"] } }).pipe(Effect.asVoid);

export const paneSendKeys = (paneId: string, keys: readonly string[]) =>
  call({ method: "pane.send_keys", params: { pane_id: paneId, keys } }).pipe(Effect.asVoid);

export const paneSendText = (paneId: string, text: string) =>
  call({ method: "pane.send_text", params: { pane_id: paneId, text } }).pipe(Effect.asVoid);

export const paneRead = (paneId: string, lines: number) =>
  call({
    method: "pane.read",
    params: { pane_id: paneId, source: "recent_unwrapped", lines, format: "text", strip_ansi: true },
  }).pipe(Effect.map((result) => result.read.text));

export const paneClose = (paneId: string) => call({ method: "pane.close", params: { pane_id: paneId } }).pipe(Effect.asVoid);

export const agentStart = (name: string, paneId: string, args: readonly string[]) =>
  call({
    method: "agent.start",
    params: { name, kind: "pi", pane_id: paneId, args, timeout_ms: START_TIMEOUT_MS },
    timeoutMs: START_TIMEOUT_MS + HERDR_TRANSPORT_GRACE_MS,
  }).pipe(Effect.map((result) => result.agent));

export const agentGet = (target: string) =>
  call({ method: "agent.get", params: { target } }).pipe(Effect.map((result) => result.agent));

export const reportTokens = (workspaceId: string, source: string, tokens: Readonly<Record<string, string | null>>, seq: number, ttlMs: number) =>
  call({
    method: "workspace.report_metadata",
    params: { workspace_id: workspaceId, source, tokens, seq, ttl_ms: ttlMs },
  }).pipe(Effect.asVoid);

export type Proof = { readonly state: "proven"; readonly via: "prompt" | "wait" | "enter"; readonly warning?: string } | { readonly state: "unproven"; readonly submission: "submitted" | "uncertain"; readonly detail: string; readonly modelError?: string; readonly warning?: string };

const waitWorking = (paneId: string, timeoutMs: number) =>
  call({
    method: "agent.wait",
    params: { target: paneId, until: ["working"], timeout_ms: timeoutMs },
    timeoutMs: timeoutMs + HERDR_TRANSPORT_GRACE_MS,
  }).pipe(Effect.map((result) => result.agent.agent_status === "working"));

/**
 * Submit once, then require Herdr to observe `working`. Pasting is not
 * delivery: a long paste can sit in the editor waiting for a second Enter, so
 * when proof fails on an idle agent Muster sends exactly one Enter (never the
 * text again) and waits once more.
 */
const checkProof = (paneId: string, via: "prompt" | "enter") => Effect.gen(function* () {
  const env = yield* MusterEnv;
  let warning: string | undefined;
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) yield* env.sleep(3_000);
    const issue = modelOutputIssue(yield* paneRead(paneId, 20));
    if (issue?.severity === "error") return { state: "unproven", submission: "submitted", detail: `model error: ${issue.line}`, modelError: issue.line } satisfies Proof;
    if (issue) warning = issue.line;
  }
  return { state: "proven", via, ...(warning ? { warning } : {}) } satisfies Proof;
});

export const promptWithProof = (paneId: string, text: string): Effect.Effect<Proof, HerdrFailure, Herdr | MusterEnv> =>
  Effect.gen(function* () {
    const started = Date.now();
    const remaining = () => Math.max(1_000, PROOF_OF_LIFE_MS - (Date.now() - started));
    const prompt = call({
      method: "agent.prompt",
      params: { target: paneId, text, wait: { until: ["working"], timeout_ms: PROOF_OF_LIFE_MS } },
      timeoutMs: PROOF_OF_LIFE_MS + HERDR_TRANSPORT_GRACE_MS,
    });
    // A fresh pane can be idle before Herdr registers its agent name. agent_not_ready
    // rejects before any text is typed, so retrying cannot deliver twice.
    const submitted = yield* prompt.pipe(
      Effect.retry({ while: (error) => isCode(error, "agent_not_ready"), schedule: Schedule.spaced(NAME_READY_STEP_MS), times: NAME_READY_TRIES }),
      Effect.map((result) => result.agent.agent_status === "working"),
      Effect.catchIf(
        (error) => isCode(error, "agent_prompt_stalled"),
        () => waitWorking(paneId, remaining()).pipe(Effect.orElseSucceed(() => false)),
      ),
    );
    if (submitted) return yield* checkProof(paneId, "prompt");
    const recovered = yield* paneSendKeys(paneId, ["Enter"]).pipe(
      Effect.andThen(waitWorking(paneId, 15_000)),
      Effect.orElseSucceed(() => false),
    );
    if (recovered) return yield* checkProof(paneId, "enter");
    return {
      state: "unproven",
      submission: "submitted",
      detail: "Herdr never observed working after submit plus one Enter. Do not resend blindly; read the pane.",
    } satisfies Proof;
  });
