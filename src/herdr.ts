import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Effect } from "effect";
import { decodeFirstTurnEntry, decodeSessionSlice, decodeSessionEntryCount } from "./domain.ts";
import {
  HERDR_TRANSPORT_GRACE_MS,
  type HerdrError,
  type HerdrMethod,
  type HerdrRequest,
  type HerdrResultFor,
} from "@joelhooks/pi-bellwether/herdr-client";

import { HerdrFailure } from "./errors.ts";
import { Herdr, MusterEnv, Proc } from "./runtime.ts";
import { modelOutputIssue } from "./models.ts";

/**
 * The Herdr operations Muster needs, over Bellwether's socket client. Every
 * Herdr error becomes one typed `HerdrFailure` carrying Herdr's `error.code`;
 * nothing classifies errors from message text.
 */

export const PROOF_OF_LIFE_MS = 30_000;
const NAME_READY_STEP_MS = 500;

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

export const agentRename = (target: string, name: string) =>
  call({ method: "agent.rename", params: { target, name } }).pipe(Effect.map((result) => result.agent));

export const agentGet = (target: string) =>
  call({ method: "agent.get", params: { target } }).pipe(Effect.map((result) => result.agent));

export const reportTokens = (workspaceId: string, source: string, tokens: Readonly<Record<string, string | null>>, seq: number, ttlMs: number) =>
  call({
    method: "workspace.report_metadata",
    params: { workspace_id: workspaceId, source, tokens, seq, ttl_ms: ttlMs },
  }).pipe(Effect.asVoid);

export type FirstTurnFailure = "discovery_timeout" | "unreadable_slice" | "wrong_boundary" | "substituted_message" | "missing_prompt" | "assistant_error" | "assistant_timeout";
export type Proof = { readonly state: "proven"; readonly via: "argv" | "prompt" | "wait" | "enter"; readonly warning?: string } | { readonly state: "unproven"; readonly submission: "submitted" | "uncertain"; readonly detail: string; readonly modelError?: string; readonly firstTurn?: true; readonly failureKind?: FirstTurnFailure; readonly repairPrompt?: string; readonly warning?: string };

export const FIRST_TURN_MS = 90_000;

/** Short shell probe runs in the pane's actual PATH; it never changes launch argv. */
export const piReceiptSuffix = (id: string) => ` && { (umask 077; { command -v pi; pi --version; } >~/.pi/agent/m-${id}.pi) & }`;
export const readPiReceipt = (home: string, id: string) => sessionSlice(`${home}/.pi/agent/m-${id}.pi`, 0).pipe(
  Effect.map(slice => `Pi binary: ${slice.text.trim().split("\n")[0] || "unknown"}; pi version: ${slice.text.trim().split("\n").slice(1).join(" ") || "unknown"}`),
  Effect.catch(() => Effect.succeed("Pi binary: unknown; pi version: unknown")),
);
// Below Pi's paste-collapse threshold. A file pointer avoids terminal paste semantics.
const INLINE_PROMPT_MAX = 800;
const sessionSlice = (path: string, offset: number, skipEntries = 0, timeoutMs = FIRST_TURN_MS) => Effect.gen(function* () {
  const proc = yield* Proc;
  const result = yield* proc.run("node", ["-e", `const fs=require('node:fs');const p=process.argv[1];let offset=Number(process.argv[2]);const skip=Number(process.argv[3]);let fd;try{fd=fs.openSync(p,'r')}catch(e){process.exit(e.code==='ENOENT'?2:1)}try{const size=fs.fstatSync(fd).size;if(offset===-1){process.stdout.write(JSON.stringify({size,text:''}));process.exit(0)}if(skip){const chunk=Buffer.alloc(65536);let pos=0,count=0,nonempty=false;while(count<skip){const n=fs.readSync(fd,chunk,0,chunk.length,pos);if(!n)process.exit(3);for(let i=0;i<n;i++){const c=chunk[i];if(c===10){if(nonempty)count++;nonempty=false;if(count===skip){offset=pos+i+1;break}}else if(c!==9&&c!==13&&c!==32)nonempty=true}pos+=n}}if(offset>size)process.exit(3);if(size-offset>2097152)process.exit(4);const b=Buffer.alloc(Math.max(0,size-offset));fs.readSync(fd,b,0,b.length,offset);process.stdout.write(JSON.stringify({size,text:b.toString('utf8')}))}finally{fs.closeSync(fd)}`, path, String(offset), String(skipEntries)], { cwd: "/", timeoutMs }).pipe(Effect.mapError(() => new HerdrFailure({ operation: "first-turn", code: "unreadable_slice", message: "unreadable slice: session read failed or exceeded the first-turn budget" })));
  if (result.code !== 0) return yield* new HerdrFailure({ operation: "first-turn", code: result.code === 2 ? "journal_missing" : result.code === 3 ? "wrong_boundary" : "unreadable_slice", message: result.code === 2 ? "session journal missing" : result.code === 3 ? "wrong boundary: inherited journal entries missing or journal truncated" : result.code === 4 ? "unreadable slice: first-turn journal exceeds 2 MiB" : "unreadable slice: session read failed or exceeded the first-turn budget" });
  return yield* Effect.try({ try: () => decodeSessionSlice(JSON.parse(result.stdout)), catch: () => new HerdrFailure({ operation: "first-turn", code: "unreadable_slice", message: "unreadable slice: invalid session slice" }) });
});

/** Only the newly appended user and its first assistant can prove this submission. */
export function firstTurnDetail(journal: string, prompt: string, exactPrompt = false): { state: "waiting" | "proven" | "unproven"; detail: string; failureKind?: FirstTurnFailure } {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  let matched = false;
  for (const line of journal.split("\n").slice(0, -1)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = decodeFirstTurnEntry(JSON.parse(line)); }
    catch { return { state: "unproven", failureKind: "unreadable_slice", detail: "unreadable slice: invalid first-turn session entry" }; }
    const message = entry.message;
    if (entry.type !== "message" || !message) continue;
    if (message.role === "user") {
      if (matched) return { state: "unproven", failureKind: "substituted_message", detail: "unverified user message after intended prompt: no verified bridge provenance; first assistant refused" };
      const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter(block => block.type === "text").map(block => block.text ?? "").join(" ");
      if (/^\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]$/.test(text.trim())) return { state: "unproven", failureKind: "substituted_message", detail: "user entry is only a paste marker" };
      if (exactPrompt ? normalize(text) !== normalize(prompt) : !normalize(text).startsWith(normalize(prompt).slice(0, 80))) return { state: "unproven", failureKind: "substituted_message", detail: "unverified user message instead of intended prompt: no verified bridge provenance; substituted message refused" };
      matched = true;
    } else if (message.role === "assistant") {
      if (!matched) return { state: "unproven", failureKind: "wrong_boundary", detail: "wrong boundary: assistant precedes intended prompt" };
      if (message.stopReason === "error" || message.errorMessage !== undefined) return { state: "unproven", failureKind: "assistant_error", detail: `first assistant error: ${message.errorMessage || message.stopReason}`.replace(/\s+/g, " ").slice(0, 1000) };
      return { state: "proven", detail: "matching user entry and clean first assistant" };
    }
  }
  return { state: "waiting", failureKind: matched ? "assistant_timeout" : "missing_prompt", detail: matched ? "no first turn within 90 s" : "intended prompt missing: no matching user entry within 90 s" };
}

const proveFirstTurn = (path: string, offset: number, prompt: string, proof: Proof, exactPrompt = false) => Effect.gen(function* () {
  if (proof.state !== "proven") return proof;
  const env = yield* MusterEnv;
  const started = env.now().getTime();
  let slept = 0;
  while (true) {
    const read = yield* sessionSlice(path, offset, 0, Math.max(1, FIRST_TURN_MS - Math.max(slept, env.now().getTime() - started))).pipe(Effect.result);
    if (read._tag === "Failure") return { state: "unproven", submission: "submitted", firstTurn: true, failureKind: read.failure.code === "wrong_boundary" ? "wrong_boundary" : "unreadable_slice", detail: read.failure.message } satisfies Proof;
    const slice = read.success;
    if (slice.size < offset) return { state: "unproven", submission: "submitted", firstTurn: true, failureKind: "wrong_boundary", detail: "wrong boundary: session journal truncated" } satisfies Proof;
    const result = firstTurnDetail(slice.text, prompt, exactPrompt);
    if (result.state === "proven") return proof;
    if (result.state === "unproven" || Math.max(slept, env.now().getTime() - started) >= FIRST_TURN_MS) return { state: "unproven", submission: "submitted", firstTurn: true, failureKind: result.failureKind, detail: result.detail } satisfies Proof;
    const delay = Math.min(1000, FIRST_TURN_MS - Math.max(slept, env.now().getTime() - started));
    yield* env.sleep(delay);
    slept += delay;
    if (Math.max(slept, env.now().getTime() - started) >= FIRST_TURN_MS) return { state: "unproven", submission: "submitted", firstTurn: true, failureKind: result.failureKind, detail: result.detail } satisfies Proof;
  }
});

/** Fork and restore copy/retain the old journal. Count it before starting, never after. */
export const inheritedStartEntries = (path: string | null) => path ? Effect.gen(function* () {
  const proc = yield* Proc;
  const result = yield* proc.run("node", ["-e", `const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');try{const b=Buffer.alloc(65536);let n,count=0,nonempty=false;while((n=fs.readSync(fd,b,0,b.length,null))>0){for(let i=0;i<n;i++){const c=b[i];if(c===10){if(nonempty)count++;nonempty=false}else if(c!==9&&c!==13&&c!==32)nonempty=true}}process.stdout.write(JSON.stringify(count))}finally{fs.closeSync(fd)}`, path], { cwd: "/", timeoutMs: 10_000 });
  if (result.code !== 0) return yield* new HerdrFailure({ operation: "first-turn", code: null, message: "inherited session journal unreadable" });
  return yield* Effect.try({ try: () => decodeSessionEntryCount(JSON.parse(result.stdout)), catch: () => new HerdrFailure({ operation: "first-turn", code: null, message: "invalid inherited session entry count" }) });
}) : Effect.succeed(1);

/** Pi writes no journal until its first assistant entry, so a missing file or boundary means wait, not fail. */
const startBoundary = (path: string, inheritedEntries: number) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const started = env.now().getTime();
  let slept = 0;
  while (true) {
    const slice = yield* sessionSlice(path, 0, inheritedEntries, Math.max(1, FIRST_TURN_MS - Math.max(slept, env.now().getTime() - started))).pipe(Effect.result);
    if (slice._tag === "Success") return slice.success;
    if (slice.failure.code !== "journal_missing" && slice.failure.code !== "wrong_boundary") return yield* slice.failure;
    const elapsed = Math.max(slept, env.now().getTime() - started);
    if (elapsed >= FIRST_TURN_MS) return yield* new HerdrFailure({ operation: "first-turn", code: slice.failure.code, message: slice.failure.code === "wrong_boundary" ? slice.failure.message : "discovery timeout: no session journal within 90 s" });
    const delay = Math.min(1000, FIRST_TURN_MS - elapsed);
    yield* env.sleep(delay);
    slept += delay;
    if (Math.max(slept, env.now().getTime() - started) >= FIRST_TURN_MS) return yield* new HerdrFailure({ operation: "first-turn", code: slice.failure.code, message: slice.failure.code === "wrong_boundary" ? slice.failure.message : "discovery timeout: no session journal within 90 s" });
  }
});

/** The start argv is already submitted. Only new journal entries can prove it. */
export const proveStartedPrompt = (path: string, prompt: string, inheritedEntries: number, repairPrompt = prompt) =>
  startBoundary(path, inheritedEntries).pipe(
    Effect.flatMap(slice => slice
      ? proveFirstTurn(path, slice.size - Buffer.byteLength(slice.text), prompt, { state: "proven", via: "argv" }, true)
      : Effect.succeed<Proof>({ state: "unproven", submission: "submitted", firstTurn: true, failureKind: "discovery_timeout", detail: "discovery timeout: no session journal entries within 90 s" })),
    Effect.catch(error => Effect.succeed<Proof>({ state: "unproven", submission: "submitted", firstTurn: true, failureKind: error.code === "wrong_boundary" ? "wrong_boundary" : error.code === "journal_missing" ? "discovery_timeout" : "unreadable_slice", detail: error.message })),
    Effect.map(proof => proof.state === "unproven" ? { ...proof, repairPrompt } : proof),
  );

/** Save privately on the provided Proc (SSH-backed remotely), then verify exact bytes and mode. */
export const writeLaunchFile = (dir: string, script: string, suffix: "launch.sh" | "prompt.txt" = "launch.sh") => Effect.gen(function* () {
  const path = `${dir}/m-${randomUUID()}.${suffix}`;
  const proc = yield* Proc;
  const saved = yield* proc.run("node", ["-e", `const fs=require('node:fs');fs.mkdirSync(process.argv[1],{recursive:true});const p=process.argv[2];fs.writeFileSync(p,process.argv[3],{mode:0o600,flag:'wx'});if(fs.readFileSync(p,'utf8')!==process.argv[3]||(fs.statSync(p).mode&0o777)!==0o600)process.exit(1)`, dir, path, script], { cwd: "/", timeoutMs: 10_000 });
  if (saved.code !== 0) return yield* new HerdrFailure({ operation: "launch-script", code: null, message: "private launcher could not be copied and verified; no launch typed" });
  return path;
});

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

export const agentReadinessRefusal = (agent: AgentInfo, expectedName?: string) => {
  if (agent.launch_pending) return "pending";
  if (agent.agent !== "pi" || !agent.name || (expectedName !== undefined && agent.name !== expectedName)) return "foreign";
  if (agent.agent_status === "blocked" || agent.agent_status === "unknown") return agent.agent_status;
  return null;
};

export const agentReady = (agent: AgentInfo) => agent.agent_status === "idle" || agent.agent_status === "done";

export const promptWithProof = (paneId: string, text: string): Effect.Effect<Proof, HerdrFailure, Herdr | MusterEnv | Proc> =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const initial = yield* agentGet(paneId);
    const path = initial.agent_session?.kind === "path" ? initial.agent_session.value : null;
    const snapshot = path ? yield* sessionSlice(path, -1).pipe(Effect.catch(() => Effect.succeed(null))) : null;
    if (text.length > INLINE_PROMPT_MAX || text.includes("\n")) {
      if (!path || !snapshot) return { state: "unproven", submission: "uncertain", detail: "long work prompt cannot be saved without session state; no text typed" } satisfies Proof;
      const sessionsAt = path.indexOf("/.pi/agent/sessions/");
      const stateDir = sessionsAt >= 0 ? `${path.slice(0, sessionsAt)}/.pi/agent` : dirname(path);
      const file = `${stateDir}/m-${randomUUID()}.prompt.txt`;
      const proc = yield* Proc;
      const saved = yield* proc.run("node", ["-e", `const fs=require('node:fs');fs.writeFileSync(process.argv[1],process.argv[2],{mode:0o600,flag:'wx'});if(fs.readFileSync(process.argv[1],'utf8')!==process.argv[2])process.exit(1)`, file, text], { cwd: dirname(path), timeoutMs: 10_000 }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!saved || saved.code !== 0) return { state: "unproven", submission: "uncertain", detail: "long work prompt file could not be copied and verified; no text typed" } satisfies Proof;
      text = `Read the complete work prompt at ${file}. Do the work it describes.`;
      if (text.length > INLINE_PROMPT_MAX) return { state: "unproven", submission: "uncertain", detail: "work prompt pointer exceeds safe inline length; no text typed" } satisfies Proof;
    }
    const finish = (proof: Proof) => (path && snapshot ? proveFirstTurn(path, snapshot.size, text, proof) : Effect.succeed<Proof>(proof.state === "proven" ? { state: "unproven", submission: "submitted", firstTurn: true, detail: "first turn not checked: session file unavailable" } : proof)).pipe(Effect.map(result => result.state === "unproven" ? { ...result, repairPrompt: text } : result));
    const started = env.now().getTime();
    let slept = 0;
    const remaining = () => Math.max(0, PROOF_OF_LIFE_MS - Math.max(slept, env.now().getTime() - started));
    // pending -> submitted (idle/done) | working; only accepted submissions may send recovery Enter.
    let submission: "pending" | "idle" | "working" = "pending";
    let refusal: string | null = null;
    while (remaining() > 0) {
      const agent = yield* agentGet(paneId).pipe(Effect.catchIf(
        error => isCode(error, "agent_not_ready", "agent_not_found", "not_found"),
        () => Effect.succeed(null),
      ));
      refusal = agent ? agentReadinessRefusal(agent) : "unknown";
      if (agent && refusal && refusal !== "pending") return yield* finish({
        state: "unproven", submission: "uncertain", detail: `Herdr readiness refused: ${refusal}; no text was typed.`,
      });
      if (remaining() > 0 && agent && !refusal && agentReady(agent)) {
        // Herdr checks foreground identity again before typing. Only this rejection
        // is safe to retry: a successful or uncertain submission never repeats text.
        const outcome = yield* call({
          method: "agent.prompt",
          params: { target: paneId, text, wait: { until: ["working"], timeout_ms: remaining() } },
          timeoutMs: remaining() + HERDR_TRANSPORT_GRACE_MS,
        }).pipe(
          Effect.map(result => ({ ready: true, working: result.agent.agent_status === "working" })),
          Effect.catchIf(error => isCode(error, "agent_not_ready"), () => Effect.succeed({ ready: false, working: false })),
          Effect.catchIf(error => isCode(error, "agent_prompt_stalled"), () => waitWorking(paneId, Math.max(1, remaining())).pipe(
            Effect.orElseSucceed(() => false), Effect.map(working => ({ ready: true, working })),
          )),
        );
        if (outcome.ready) { submission = outcome.working ? "working" : "idle"; break; }
      }
      const delay = Math.min(NAME_READY_STEP_MS, remaining());
      yield* env.sleep(delay);
      slept += delay;
    }
    if (submission === "pending") return yield* finish({
      state: "unproven", submission: "uncertain",
      detail: `Herdr did not accept the prompt within ${PROOF_OF_LIFE_MS} ms${refusal ? `: ${refusal}` : ""}; no text was typed.`,
    });
    if (submission === "working") return yield* finish(yield* checkProof(paneId, "prompt"));
    const recovered = yield* paneSendKeys(paneId, ["Enter"]).pipe(
      Effect.andThen(waitWorking(paneId, 15_000)),
      Effect.orElseSucceed(() => false),
    );
    if (recovered) return yield* finish(yield* checkProof(paneId, "enter"));
    return yield* finish({
      state: "unproven",
      submission: "submitted",
      detail: "Herdr never observed working after submit plus one Enter. Do not resend blindly; read the pane.",
    });
  });
