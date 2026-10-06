import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { availableParallelism, loadavg } from "node:os";
import { stripVTControlCharacters } from "node:util";

import { Effect, Schema } from "effect";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

import {
  agentEnv,
  buildArgv,
  extensionsFor,
  mintSessionId,
  profileFor,
  sessionDirFor,
  sessionIdFromFile,
  shellPrelude,
  shellQuote,
} from "./argv.ts";
import type { LaunchKind, ProfileInput } from "./argv.ts";
import { appendDesk, deskRecord, queuePath, readDesk } from "./desk.ts";
import { AUTOLAND_CAP, AUTOLAND_RECHECK_MS, autolandEligible, findLanding, landingEvidence } from "./autoland.ts";
import type { AgentRow, CheckOutcome, DeskKind, Lane, LaunchProfile, Mode, Packet, PacketGate, PaneBinding, Policy, Project, Role, Thinking } from "./domain.ts";
import { GateReceipt, Project as ProjectSchema, SessionId, MAX_CADENCE_MINUTES, TERMINAL_PACKET_STATES, decodeAgentName, decodeDeployLevel, decodeDeployRule, DEPLOY_RULE_CAPS, decodePolicy, decodeSlug, effectivePolicy, isTempPath, mergePolicy, roleDefaults, silenceLimits } from "./domain.ts";
import { GuardFailed, HeavyJobBusy, HerdrFailure, IllegalTransition, InputError, NotFound, PacketCheckFailed, ProcError, StoreError } from "./errors.ts";
import { tryAcquireHeavy } from "./heavy-lock.ts";
import { FleetStatus, busyQueue, gatesLine } from "./fleet.ts";
import {
  agentRename,
  agentGet,
  inheritedStartEntries,
  proveStartedPrompt,
  writeLaunchFile,
  paneClose,
  paneGet,
  paneList,
  paneRead,
  paneRename,
  paneRun,
  paneSendKeys,
  paneSplit,
  promptWithProof,
  piReceiptSuffix,
  readPiReceipt,
  reportTokens,
  tabCreate,
  workspaceCreate,
  workspaceList,
  workspaceRename,
} from "./herdr.ts";
import type { PaneInfo, Proof } from "./herdr.ts";
import type { AgentEvent } from "./machines.ts";
import { PROCESS_STATES, stepAgent, stepDelivery, stepLane, stepProject } from "./machines.ts";
import { DEFAULT_GENERATED, isGenerated, failures, parsePorcelainZ, sha256File, sourceOf, verifyCommitBranch, verifyGoneClone, verifyPacket } from "./packet.ts";
import { cloneUrl, decodeRemoteNote, machineConfig, mapPath, mapWorkerPath, onRemote, prerequisites, remoteNode, sshProc, withMachineLaunchLock } from "./remote.ts";
import { decodeAgentRow, decodeRemotePacket } from "./domain.ts";
import { remoteCommsEnvironment } from "./comms.ts";
import { BOT_EMAIL, BOT_NAME, Comms, MusterEnv, Proc, git, must } from "./runtime.ts";
import { CACHE_TTL_MS, readSessionCost, sessionMtimeMs } from "./session-file.ts";
import type { SessionCost } from "./session-file.ts";
import { nudgeSwitchboards } from "./switchboard-ops.ts";
import { deliverOwnerItem, forwardOwner, ingestOwnerItem } from "./owner-queue.ts";
import { CAPTURE_REFRESH_MARK, captureRefreshNote, nudgeNote, silenceDecision } from "./silence.ts";
import { loadRoster } from "./roster.ts";
import { retroCadence, retroJudgeModel } from "./retro-cadence.ts";
import { checkRunnableModel, checkRestoreContext, resolveModel, modelOutputIssue } from "./models.ts";
import { parseSessionModel, restoreProfile, SESSION_MODEL_READ_SCRIPT } from "./session-model.ts";
import { resolveSkills, skillIndex } from "./skills.ts";
import { registerProject } from "./switchboard-ops.ts";
import { dataDir, projectPath, closedDir, create, exists, load, mutate, reportsDir } from "./store.ts";
import { readRegistry } from "./registry.ts";
import { relayEvent, watchFallback } from "./relay-events.ts";
import { TOKEN_SOURCE, TOKEN_TTL_MS, deriveTokens, deployPosture, deployPostureLine, laneDeployLevel, flowLine, openDeskItems, wipRefusal } from "./tokens.ts";
import { forkSessionAt } from "./session-tree.ts";
import type { LiveCounts } from "./tokens.ts";

const MAX_WORKERS_PER_TAB = 4;
const GATE_TIMEOUT_MS = 45 * 60_000;
const CLOSE_READ_LINES = 40;
/** Pi expands @files before its first message; extra instructions travel in one complete file. */
const startPrompt = (row: AgentRow, prompt: string | undefined, dir: string) => Effect.gen(function* () {
  let text = workPrompt(row, prompt);
  if (!text) return { expected: undefined };
  if (row.brief) {
    const contents = yield* must("node", ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1],'utf8'))", row.brief], { cwd: row.cwd, timeoutMs: 10_000 });
    if (prompt === undefined && !row.side) return { promptFile: row.brief, expected: `<file name="${row.brief}">\n${contents}\n</file>\n`, repairPrompt: `Read the complete work prompt at ${row.brief}. Do the work it describes.` };
    text = `${text}\n\n<file name="${row.brief}">\n${contents}\n</file>`;
  }
  if (text.length > 800 || text.includes("\n") || text.startsWith("@")) {
    const path = yield* writeLaunchFile(dir, text, "prompt.txt");
    return { promptFile: path, expected: `<file name="${path}">\n${text}\n</file>\n`, repairPrompt: `Read the complete work prompt at ${path}. Do the work it describes.` };
  }
  return { prompt: text, expected: text, repairPrompt: text };
});


const sessionRestore = (profile: LaunchProfile, file: string | null, project: Project, role: Role, roster?: import("./domain.ts").Roster, params: Pick<AgentLaunchInput, "model" | "thinking"> = {}, remote = false) => Effect.gen(function* () {
  const notes: string[] = [];
  const reading: Effect.Effect<string, InputError | ProcError, Proc> = !file ? Effect.succeed("") : remote
    ? must("node", ["--input-type=module", "-e", SESSION_MODEL_READ_SCRIPT, file], { cwd: "/", timeoutMs: 20_000 })
    : Effect.try({ try: () => readFileSync(file, "utf8"), catch: error => new InputError({ message: String(error) }) });
  const text = yield* reading.pipe(Effect.catch(error => Effect.sync(() => { notes.push(`session model unavailable: ${error.message}; warning: using launch profile`); return ""; })));
  const live = parseSessionModel(text);
  const selected = yield* decodeWith(() => restoreProfile({ profile, live, roster, project: project.slug, role, ...params }), null);
  return { ...selected, live, notes: [...notes, selected.note] };
});

const guardLaunchShell = (paneId: string) => Effect.gen(function* () {
  const pane = yield* paneGet(paneId);
  if (!pane) return yield* input(`launch pane ${paneId} is gone`);
  if (pane.agent) return yield* input(`launch pane ${paneId} still hosts agent ${pane.agent}; close or adopt it before starting another Pi`);
});

// ---------- remote lanes (the owner catalog always stays local) ----------

const remoteLaunch = (dir: string, project: Project, params: Omit<AgentLaunchInput, "action"> & { action: LaunchKind | "adopt" }, nameOfMachine: string) => withMachineLaunchLock(nameOfMachine, Effect.gen(function* () {
  const env = yield* MusterEnv;
  const machine = yield* machineConfig(nameOfMachine);
  const catalogs = [project];
  if (machine.maxPanes !== undefined) {
    const registered = yield* decodeWith(() => [...readRegistry(env.home).values()], null);
    for (const entry of registered) if (entry.dir !== project.dir && exists(entry.dir)) catalogs.push(yield* load(entry.dir));
  }
  const openCount = catalogs.flatMap(catalog => catalog.agents).filter(row => row.machine === nameOfMachine && row.state !== "closed").length;
  if (machine.maxPanes !== undefined && openCount >= machine.maxPanes) return yield* input(`machine ${nameOfMachine}: maxPanes ${machine.maxPanes} reached (${openCount} open Muster rows); close one before launching`);
  const wrap = machine.wrap.map(arg => arg.replaceAll("{name}", params.name));
  if (params.action === "adopt" || params.side || params.pane) return yield* input("remote launch does not adopt supplied panes or side desks");
  const name = yield* decodeWith(decodeAgentName, params.name);
  const existing = project.agents.find(row => row.name === name);
  const parent = params.action === "fork" ? yield* findRow(project, params.from ?? "") : null;
  const role = params.role ?? parent?.role ?? existing?.role;
  const lane = yield* findLane(project, params.lane ?? parent?.lane ?? existing?.lane ?? "");
  if (lane.state !== "open") return yield* input(`lane ${lane.slug} is ${lane.state}`);
  if (!role) return yield* input("a remote agent needs a role");
  if (params.action === "restore" && !existing) return yield* input(`no row ${name} to restore`);
  if (params.action !== "restore" && existing && !["planned", "failed"].includes(existing.state)) return yield* input(`row ${name} is ${existing.state}; restore it or choose another name`);
  if (parent && !parent.sessionFile) return yield* input("fork needs a parent session file");
  if (project.policy?.comms === "network") {
    const helper = yield* Effect.promise(() => import("./comms-network.ts"));
    yield* helper.prepareRemoteNetworkAgent({ home: env.home, agent: name, machineName: nameOfMachine, machine }).pipe(Effect.mapError(error => new InputError({ message: error.message })));
  }
  const source = lane.repo ?? project.dir;
  const remoteSource = mapPath(source, machine);
  yield* prerequisites(nameOfMachine, machine, remoteSource);
  const roster = (yield* loadRoster).roster;
  const label = params.label ?? parent?.profile.label ?? existing?.profile.label;
  if (!label) return yield* input("a remote agent needs a label");
  const retroChoice = params.action === "restore" ? null : retroJudgeModel(roster, { kind: lane.kind, role, model: params.model });
  const model = params.model ?? retroChoice?.model ?? parent?.profile.model;
  const profile = profileFor(role, { ...(parent?.profile ?? existing?.profile), label,
    ...(retroChoice?.model ? { thinking: undefined } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
    ...(params.skills !== undefined ? { skills: params.skills } : {}),
    ...(params.noSkills !== undefined ? { noSkills: params.noSkills } : {}),
    ...(params.extensions !== undefined ? { extensions: params.extensions } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.appendSystemPrompt !== undefined ? { appendSystemPrompt: params.appendSystemPrompt } : {}),
    ...(params.compactAt !== undefined ? { compactAt: params.compactAt } : {}),
  }, yield* decodeWith(value => roleDefaults(roster, project.policy, role, model, project.slug), null));
  const selected = params.action === "restore" ? { model: profile.model } : yield* decodeWith(() => resolveModel(profile.model, roster, project.slug, role), null);
  const inheritedSkills = params.skills === undefined && (parent !== null || (params.action === "restore" && existing !== undefined));
  const discovered = inheritedSkills ? { paths: [...profile.skills], notes: [] as string[] } : yield* decodeWith(() => resolveSkills({ skills: profile.skills, index: skillIndex({ cwd: source }) }), null);
  // Absolute remote paths cannot be discovered on the owner filesystem. Validate them over SSH below.
  const remoteOnly = inheritedSkills ? [] : profile.skills.filter(path => isAbsolute(path) && !existsSync(path));
  const resolved = { paths: [...new Set([...discovered.paths, ...remoteOnly])], notes: [...(retroChoice?.notes ?? []), ...discovered.notes.filter(note => !remoteOnly.some(path => note.includes(JSON.stringify(path))))] };
  let remoteProfile: LaunchProfile = { ...profile, model: selected.model, thinking: params.thinking ?? selected.thinking ?? profile.thinking,
    skills: [...new Set(resolved.paths.map(path => mapWorkerPath(path, machine)))], extensions: profile.extensions.map(path => mapWorkerPath(path, machine)),
    appendSystemPrompt: profile.appendSystemPrompt.map(path => mapWorkerPath(path, machine)), env: { ...profile.env, ...machine.env } };
  // onRemote labels transport errors; retain the launch's typed model-proof refusal.
  let modelFailure: GuardFailed | null = null;
  return yield* onRemote(nameOfMachine, machine, Effect.gen(function* () {
    const requiredPaths = [...remoteProfile.skills, ...remoteProfile.extensions, ...remoteProfile.appendSystemPrompt,
      ...(params.brief ? [mapPath(params.brief, machine)] : []), ...(params.action === "restore" && existing?.sessionFile ? [existing.sessionFile] : [])];
    for (const path of requiredPaths) {
      yield* must("test", ["-r", path], { cwd: "/", timeoutMs: 10_000 }).pipe(Effect.mapError(error => new ProcError({ ...error,
        message: `${path} is not readable on ${nameOfMachine}${params.brief && path === mapPath(params.brief, machine) ? "; briefs are not copied to remote machines, so put the brief in the lane repo or copy it there first" : ""}` })));
    }
    let cwd = params.cwd ? mapPath(yield* requireAbsolute("cwd", params.cwd), machine) : existing?.cwd ?? parent?.cwd ?? remoteSource;
    let clone = existing?.clone ?? null;
    const cloneNotes: string[] = [];
    if (params.clone && params.action !== "restore") {
      // onRemote supplies the remote Proc, so branch selection reads the remote source.
      const allocated = yield* cloneFor(remoteSource, name, lane, project.mode, machine.workerWorktree);
      cwd = yield* requireAbsolute("remote clone", allocated.path);
      clone = { source, branch: allocated.branch, base: allocated.base };
      cloneNotes.push(...allocated.notes);
    }
    yield* must("test", ["-d", cwd], { cwd: "/", timeoutMs: 10_000 });
    yield* guardDurable(project, "remote cwd", cwd);
    const sessionFile = params.action === "restore" ? existing?.sessionFile ?? null : null;
    if (params.action === "restore" && !sessionFile) return yield* input(`machine ${nameOfMachine}: no session file to restore`);
    let parentSessionFile = parent?.sessionFile ?? null;
    if (params.at) {
      const script = `import {forkSessionAt} from ${JSON.stringify(`${machine.musterExtension}/src/session-tree.ts`)}; console.log(forkSessionAt(process.argv[1], process.argv[2], process.argv[3]));`;
      // This Proc is already SSH-backed; do not nest SSH.
      parentSessionFile = (yield* must("node", ["--input-type=module", "-e", script, parentSessionFile ?? "", params.at, `${cwd}/.pi/muster/forks`], { cwd, timeoutMs: 30_000 })).trim();
    }
    const restoreNotes: string[] = [];
    if (params.action === "restore") {
      const selected = yield* sessionRestore(remoteProfile, sessionFile, project, role, roster, params, true);
      remoteProfile = selected.profile;
      restoreNotes.push(...selected.notes);
      const note = yield* checkRestoreContext(remoteProfile.model, cwd, selected.live.contextTokens);
      if (note) restoreNotes.push(note);
    }
    const now = iso(env);
    let row: AgentRow = { name, machine: nameOfMachine, intercomAddress: `${name}@${machine.herdr}`, role, lane: lane.slug, side: null, cwd, clone,
      profile: remoteProfile, owner: env.sessionId, sessionId: existing?.sessionId ?? mintSessionId(name, env.now()), sessionFile, parentSessionFile, pane: null,
      brief: params.brief ? mapPath(params.brief, machine) : existing?.brief ?? null,
      state: yield* stepAgent(name, existing?.state ?? "planned", { type: params.action === "restore" ? "RESTORE" : "LAUNCH" }), delivery: "none", restarts: existing?.restarts ?? 0,
      restore: null, createdAt: existing?.createdAt ?? now, updatedAt: now };
    const launchProfile = extensionsFor({ ...project, musterExtension: machine.musterExtension, deskExtension: project.deskExtension ? mapPath(project.deskExtension, machine) : null }, row);
    const promptDir = (yield* git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "muster-launch")
      .pipe(Effect.orElseSucceed(() => join(cwd, ".pi/muster")))).trim();
    const message = params.action === "restore" && params.prompt === undefined && params.brief === undefined ? { expected: undefined } : yield* startPrompt(row, params.prompt, promptDir);
    const inheritedEntries = message.expected ? yield* inheritedStartEntries(params.action === "fork" ? parentSessionFile : params.action === "restore" ? sessionFile : existing?.cwd === cwd ? existing.sessionFile : null) : 1;
    const networkBrief = project.policy?.comms === "network" && project.agents.some(agent => agent.sessionId === env.sessionId);
    const argv = buildArgv({ kind: params.action === "adopt" ? "launch" : params.action, sessionId: row.sessionId, sessionFile, parentSessionFile, profile: launchProfile, musterExtension: machine.musterExtension, ...(networkBrief ? {} : message) });
    const agentEnvironment: Record<string, string> = { ...agentEnv(project, row), ...machine.env, MUSTER_MACHINE: nameOfMachine, MUSTER_PROJECT_SLUG: project.slug, ...remoteCommsEnvironment(project, machine), ...(project.policy?.comms === "network" ? { MUSTER_NETWORK_PEERS: JSON.stringify(Object.fromEntries([...project.agents.filter(agent => agent.name !== row.name), row].map(agent => [agent.sessionId, agent.name]))) } : {}), MUSTER_REMOTE_ROW: JSON.stringify(row) };
    // Read the remote environment, never transplant the owner's machine-specific PATH.
    const remotePath = agentEnvironment.PATH ?? (yield* must("printenv", ["PATH"], { cwd, timeoutMs: 10_000 })).trim();
    agentEnvironment.PATH = [join(machine.musterExtension, "bin"), remotePath].filter(Boolean).join(":");
    yield* mutate(dir, current => Effect.succeed([withRow(current, row), row] as const));
    const launch = Effect.gen(function* () {
      const spaces = yield* workspaceList();
      const matches = spaces.filter(space => space.label === project.label);
      if (matches.length > 1) return yield* input(`machine ${nameOfMachine}: multiple workspaces labelled ${project.label}; resolve ambiguity first`);
      const spaceId = matches[0]?.workspace_id ?? (yield* workspaceCreate(project.label, remoteSource)).workspace.workspace_id;
      const laneRows = project.agents.filter(other => other.machine === nameOfMachine && other.lane === lane.slug && other.state !== "closed" && other.pane);
      const sibling = laneRows[0]?.pane ? yield* locatePane(laneRows[0].pane) : null;
      if (sibling && laneRows.length >= MAX_WORKERS_PER_TAB) return yield* input(`machine ${nameOfMachine}: lane tab is full`);
      const pane = sibling ? yield* paneSplit(sibling.pane_id, "right", cwd) : (yield* tabCreate(spaceId, cwd, lane.label)).root_pane;
      const binding: PaneBinding = { paneId: pane.pane_id, terminalId: pane.terminal_id, tabId: pane.tab_id, openedByMuster: true };
      row = yield* patchRow(dir, name, row.state, [], { pane: binding });
      // Shell execution is required for the owner's argv prefix; Herdr agent.start always executes pi directly.
      // Keep exec's normal pane lifecycle, but retain stderr independently of the terminal.
      // Git metadata keeps diagnostics out of the clone's work tree and close/land guards.
      const logDir = promptDir;
      yield* must("mkdir", ["-p", logDir], { cwd, timeoutMs: 10_000 });
      const launchLog = (yield* must("mktemp", [join(logDir, `launch-${name}-XXXXXXXX`)], { cwd, timeoutMs: 10_000 })).trim();
      const piReceiptId = env.createId();
      yield* guardLaunchShell(binding.paneId);
      const script = yield* writeLaunchFile(logDir, `#!/bin/sh\nset -e\n${shellPrelude(cwd, agentEnvironment)}${piReceiptSuffix(piReceiptId)}\nexec ${[...wrap, "pi", ...argv].map(shellQuote).join(" ")} 2> ${shellQuote(launchLog)}`);
      yield* paneRun(binding.paneId, `exec sh ${shellQuote(script)}`);
      if (networkBrief && message.expected) {
        const comms = yield* Comms;
        const sent = yield* comms.send(row.sessionId, message.expected);
        if (!["accepted", "queued", "delivered", "acked"].includes(sent.status)) return yield* input(`NetworkComms brief send refused for ${row.name}: ${sent.detail ?? sent.status}`);
      }
      const wait = yield* waitForSession(binding.paneId, null);
      if (wait.state !== "ready") {
        const logTail = yield* must("tail", ["-n", "12", launchLog], { cwd, timeoutMs: 10_000 }).pipe(Effect.orElseSucceed(() => ""));
        // Classify before redacting: a short env value can also occur in a model error code.
        const evidence = stripVTControlCharacters(logTail.trim() ? logTail : wait.tail)
          .split(/\r?\n/).filter(line => !/\bexport\s|MUSTER_REMOTE_ROW/.test(line))
          .slice(-12).join("\n");
        const redact = (text: string) => Object.values(remoteProfile.env).filter(value => value.length > 0)
          .reduce((safe, value) => safe.replaceAll(value, "[remote env redacted]"), text);
        const tail = redact(evidence).trim().slice(-1500) || "(launch tail unavailable)";
        const issue = modelOutputIssue(evidence);
        const modelLine = issue ? redact(issue.line) : "";
        const detail = `machine ${nameOfMachine}: Pi session not ready in ${binding.paneId}; inspect it before retrying (${wait.state}). Launch tail (UNTRUSTED):\n${tail}`;
        row = yield* patchRow(dir, name, row.state, [{ type: "LAUNCH_FAILED" }], {
          ...(issue?.severity === "error" ? { delivery: "unproven" as const } : {}),
          events: [...(row.events ?? []), { type: "LAUNCH_FAILED", at: iso(env), detail },
            ...(issue?.severity === "error" ? [{ type: "MODEL_ERROR" as const, at: iso(env), detail: modelLine }] : [])],
        });
        if (issue?.severity === "error") {
          modelFailure = new GuardFailed({ guard: "model-proof", message: `machine ${nameOfMachine}: pane ${binding.paneId}: delivery: unproven (model error: ${modelLine})` });
          return yield* modelFailure;
        }
        return yield* input(detail);
      }
      const named = yield* agentRename(binding.paneId, row.name).pipe(Effect.result);
      if (named._tag === "Failure") cloneNotes.push(`machine ${nameOfMachine}: agent rename refused (${named.failure.code ?? "transport"}): ${named.failure.message}; leaving existing names unchanged.`);
      const requestedId = row.sessionId;
      const actual = sessionIdFromFile(wait.sessionFile) ?? requestedId;
      const liveRestore = yield* sessionRestore(launchProfile, wait.sessionFile, project, role, roster, params.action === "restore" ? params : {}, true);
      const restoreArgv = buildArgv({ kind: "restore", sessionId: actual, sessionFile: wait.sessionFile, parentSessionFile: null, profile: liveRestore.profile, musterExtension: machine.musterExtension });
      const restore = { cwd, argv: [...wrap, "pi", ...restoreArgv], env: agentEnvironment };
      row = yield* patchRow(dir, name, row.state, [{ type: "STARTED" }], { sessionId: actual, sessionFile: wait.sessionFile, restore });
      yield* paneRename(binding.paneId, label);
      const prompt = message.expected;
      const proof = prompt ? yield* proveStartedPrompt(wait.sessionFile, prompt, inheritedEntries, "repairPrompt" in message ? message.repairPrompt : undefined) : null;
      if (proof) row = yield* patchRow(dir, name, row.state, [], { delivery: proof.state === "proven" ? "proven" : "unproven", ...(proof.state === "unproven" ? { events: [...(row.events ?? []), { type: "FIRST_TURN", at: iso(env), detail: proof.detail }] } : {}) });
      const repair = proof?.state === "unproven" ? { tool: "herdr_agent", args: { action: "prompt", target: binding.paneId, prompt: proof.repairPrompt ?? prompt } } : null;
      const piReceipt = yield* readPiReceipt(wait.sessionFile.split("/.pi/agent/sessions/")[0]!, piReceiptId);
      return { row, argv, readiness: "proven", proof, ...(repair ? { repair } : {}), sessionIdMatched: actual === requestedId, notes: [...resolved.notes, ...cloneNotes, ...restoreNotes, piReceipt, ...(repair ? [`delivery: unproven: ${proof?.state === "unproven" ? proof.detail : ""}; inspect before repair: ${JSON.stringify(repair)}`] : [])] };
    });
    return yield* launch.pipe(Effect.tapError(() => patchRow(dir, name, null, [{ type: "LAUNCH_FAILED" }]).pipe(Effect.catch(() => Effect.void))));
  })).pipe(Effect.mapError(error => modelFailure ?? error));
}));

/** Force may trash a clone only when its work is safe elsewhere: verified, or recorded as landed with a sha (e.g. a squash-merged PR whose branch is gone). */
export function forceCloseAllowed(project: Project, agent: string): boolean {
  return project.packets.some(packet => packet.agent === agent &&
    (Boolean(packet.verification) || ((packet.state === "committed" || packet.state === "no_changes") && Boolean(packet.landedAs))));
}

/** Proc and Herdr are machine-scoped by onRemote for remote rows.
 * A missing pane directory falls back to raw paths; missing root/list evidence blocks retirement. */
const cloneRetirementNotes = (row: AgentRow) => Effect.gen(function* () {
  const panes = yield* paneList();
  const resolved = row.machine === "local"
    ? yield* Effect.try({
        try: () => ({ root: realpathSync(row.cwd), paths: panes.map(pane => {
          try { return pane.cwd ? realpathSync(pane.cwd) : null; } catch { return null; }
        }) }),
        catch: error => new InputError({ message: `cannot resolve clone root ${row.cwd}: ${String(error)}` }),
      })
    : yield* decodeJsonWith(Schema.decodeUnknownSync(Schema.Struct({ root: Schema.String, paths: Schema.Array(Schema.NullOr(Schema.String)) })),
        yield* must("node", ["-e", "const {realpathSync}=require('node:fs'); const root=realpathSync(process.argv[1]); const paths=JSON.parse(process.argv[2]).map(path=>{try{return path?realpathSync(path):null}catch{return null}}); process.stdout.write(JSON.stringify({root,paths}));", row.cwd, JSON.stringify(panes.map(pane => pane.cwd ?? null))], { cwd: "/", timeoutMs: 10_000 }));
  if (resolved.paths.length !== panes.length) return yield* input("pane resolution count differs from pane list");
  const within = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root.replace(/\/$/, "")}/`);
  const notes: string[] = [];
  let keep = false;
  for (const [index, pane] of panes.entries()) {
    if (!pane.cwd) {
      notes.push(`pane ${pane.pane_id} skipped: no cwd`);
      continue;
    }
    const cwd = resolved.paths[index];
    const matches = cwd !== null && cwd !== undefined
      ? within(cwd, resolved.root)
      : within(resolve(pane.cwd), resolve(row.cwd)) || within(resolve(pane.cwd), resolved.root);
    if (matches) {
      keep = true;
      notes.push(`clone kept: ${pane.pane_id} (${pane.agent ?? "shell"} ${pane.agent_status}) still runs in ${pane.cwd}; close that pane, then agent_close again to retire the clone`);
    }
  }
  return { keep, notes };
}).pipe(Effect.catch(error => Effect.succeed({ keep: true, notes: [`clone kept: cannot establish pane safety: ${error.message}; close any panes in ${row.cwd}, then agent_close again to retire the clone`] })));

const remoteClose = (dir: string, project: Project, row: AgentRow, params: AgentCloseInput) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const machine = yield* machineConfig(row.machine);
  if (params.force && !forceCloseAllowed(project, row.name)) return yield* input("force close requires a verified packet or one recorded as landed");
  const notes: string[] = [];
  const roster = (yield* loadRoster).roster;
  const restore = yield* onRemote(row.machine, machine, Effect.gen(function* () {
    const selected = yield* sessionRestore(extensionsFor({ ...project, musterExtension: machine.musterExtension, deskExtension: project.deskExtension ? mapPath(project.deskExtension, machine) : null }, row), row.sessionFile, project, row.role, roster, {}, true);
    notes.push(...selected.notes);
    const restore = { cwd: row.cwd, argv: [...machine.wrap.map(arg => arg.replaceAll("{name}", row.name)), "pi", ...buildArgv({ kind: "restore", sessionId: row.sessionId, sessionFile: row.sessionFile, parentSessionFile: null, profile: selected.profile, musterExtension: machine.musterExtension })], env: row.restore?.env ?? agentEnv(project, row) };
    if (row.state !== "closed") {
      yield* stepAgent(row.name, row.state, { type: "CLOSE" });
      const holder = project.agents.find(other => other.machine === row.machine && other.name !== row.name && other.state !== "closed" && row.pane && sharesPane(row.pane, other.pane));
      if (row.pane && !holder) {
        const pane = yield* locatePane(row.pane).pipe(Effect.catch(error => {
          notes.push(`pane lookup failed: ${error.message}`);
          return Effect.succeed(null);
        }));
        if (pane) {
          const tail = yield* paneRead(pane.pane_id, CLOSE_READ_LINES);
          const saved = join(closedDir(dir), `${row.name}-${env.now().getTime()}.txt`);
          mkdirSync(dirname(saved), { recursive: true }); writeFileSync(saved, tail);
          notes.push(`pane log saved to ${saved}`);
          // Do not broadcast a remote pane id onto the local Bellwether bus.
          if (row.pane.openedByMuster) yield* paneClose(pane.pane_id);
          else notes.push("left adopted pane open");
        }
      }
    }
    if (row.clone) {
      const proc = yield* Proc;
      const present = yield* proc.run("test", ["-d", row.cwd], { cwd: "/", timeoutMs: 10_000 });
      if (present.code === 0) {
        const kept = yield* cloneRetirementNotes(row);
        notes.push(...kept.notes);
        if (!kept.keep) notes.push((yield* must(machine.workerWorktree, ["remove", ...(params.force ? ["--force"] : []), row.cwd], { cwd: mapPath(row.clone.source, machine), timeoutMs: 120_000 })).trim());
      }
    }
    return restore;
  }));
  const closed = yield* mutate(dir, current => Effect.gen(function* () {
    const latest = yield* findRow(current, row.name);
    yield* requireOwner(latest, env.sessionId, params.takeover);
    if (latest.sessionId !== row.sessionId || latest.pane?.terminalId !== row.pane?.terminalId) return yield* input("remote row changed during close; re-read it");
    const next = { ...latest, restore, pane: null, state: latest.state === "closed" ? latest.state : yield* stepAgent(latest.name, latest.state, { type: "CLOSE" }), updatedAt: iso(env) };
    return [withRow(current, next), next] as const;
  }));
  return { row: closed, restore: closed.restore ?? { cwd: row.cwd, argv: [], env: {} }, cloneError: null, notes };
});

const remoteReport = (params: PacketReportInput) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const comms = yield* Comms;
  const row = yield* decodeJsonWith(decodeAgentRow, process.env.MUSTER_REMOTE_ROW ?? "null");
  if (row.machine !== process.env.MUSTER_MACHINE || row.name !== params.agent || row.cwd !== params.cwd) return yield* input("remote report identity differs from the launch row");
  const artifact = params.artifact ? yield* requireAbsolute("artifact", params.artifact) : null;
  const id = params.commit ? (yield* git(params.cwd, "rev-parse", "--verify", `${params.commit}^{commit}`)).trim() : yield* decodeWith(() => sha256File(artifact!), null);
  const root = join(params.cwd, ".pi/muster/packets", id);
  const report = join(root, "report.svx");
  const packet: Packet = { id, kind: params.commit ? "commit" : "artifact", artifact, lane: row.lane, agent: row.name, report, checks: [...params.checks], state: "reported", verification: null, landedAs: null, gate: null, supersedes: null, reportedAt: iso(env), updatedAt: iso(env) };
  const sidecar = yield* decodeWith(decodeRemotePacket, { project: process.env.MUSTER_PROJECT_SLUG, machine: row.machine, packet, reportText: reportMarkdown(row, packet, params.summary, params.body, params) });
  mkdirSync(root, { recursive: true });
  writeFileSync(report, sidecar.reportText);
  // Publishing the sidecar last makes an interrupted report invisible to ingestion.
  const temporary = join(root, `packet-${env.createId()}.tmp`);
  writeFileSync(temporary, JSON.stringify(sidecar));
  renameSync(temporary, join(root, "packet.json"));
  const message = `Packet ${id.slice(0, 12)} from ${row.intercomAddress}: ${params.summary.trim().split("\n")[0]}. Remote sidecar: ${root}/packet.json. Run project_status to ingest it.`;
  const notice = yield* deliverOwnerItem({ owner: params.owner, home: env.home, session: env.sessionId, project: sidecar.project, item: { author: env.sessionId, lane: row.lane, kind: "action", title: `Packet ${id.slice(0,12)} from ${row.name}`, refs: [report], body: message }, comms, send: comms.send, message });
  return { packet, delivery: notice.delivery, notice };
});

export const ingestRemotePackets = (dir: string) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const project = yield* load(dir);
  const notes: string[] = [];
  const failedMachines = new Set<string>();
  for (const row of project.agents.filter(row => row.machine !== "local" && row.state !== "closed")) {
    const skipped = (reason: string) => notes.push(`machine ${row.machine}: ingest skipped for ${row.name}: ${reason}`);
    if (failedMachines.has(row.machine)) { skipped("machine unavailable earlier in this pass"); continue; }
    const fetched = yield* Effect.gen(function* () {
      const machine = yield* machineConfig(row.machine);
      // One bounded call per row reads both kinds; transport failure skips all remaining machine rows.
      const output = yield* remoteNode(row.machine, machine, `import {existsSync,readdirSync,readFileSync} from 'node:fs'; const root=process.argv[1]; const values=[]; for(const kind of ['packet','note']) { const dir=root+'/'+(kind==='packet'?'packets':'notes'); const files=existsSync(dir)?readdirSync(dir).filter(n=>kind==='packet'?/^[a-f0-9]{40,64}$/.test(n):/^[a-f0-9]{64}\\.json$/.test(n)):[]; for(const id of files){const p=dir+'/'+id+(kind==='packet'?'/packet.json':'');if(!existsSync(p))continue;try{values.push({kind,id,value:JSON.parse(readFileSync(p,'utf8')),error:null})}catch(error){values.push({kind,id,value:null,error:String(error)})}} } console.log(JSON.stringify(values));`, [join(row.cwd, ".pi/muster")]);
      const values = yield* decodeJsonWith(Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ kind: Schema.Literals(["packet", "note"]), id: Schema.String, value: Schema.Unknown, error: Schema.NullOr(Schema.String) }))), output);
      return { machine, values };
    }).pipe(Effect.catch(error => Effect.sync(() => { failedMachines.add(row.machine); skipped(error.message); return null; })));
    if (!fetched) continue;
    const { machine, values } = fetched;
    for (const entry of values) {
      if (failedMachines.has(row.machine)) break;
      if (entry.error) { skipped(`sidecar ${entry.id}: ${entry.error}`); continue; }
      yield* Effect.gen(function* () {
        if (entry.kind === "note") {
          const sidecar = yield* decodeWith(decodeRemoteNote, entry.value);
          if (sidecar.project !== project.slug || sidecar.machine !== row.machine || sidecar.agent !== row.name || sidecar.lane !== row.lane || sidecar.item.lane !== row.lane || sidecar.item.author !== row.sessionId) return yield* input(`machine ${row.machine}: invalid note sidecar identity`);
          // The catalog owns routing; a remote recipient can be stale after a handover.
          yield* Effect.try({ try: () => ingestOwnerItem(row.owner, sidecar.item, env.home, project.slug), catch: error => new StoreError({ path: `remote note ${entry.id}`, message: String(error) }) });
          // The existing owner feed reads this queue and wakes on the post's mention facets.
          return;
        }
        const sidecar = yield* decodeWith(decodeRemotePacket, entry.value);
        const packet = sidecar.packet;
        if (sidecar.project !== project.slug || sidecar.machine !== row.machine || packet.agent !== row.name || packet.lane !== row.lane || packet.id !== entry.id || !/^[a-f0-9]{40,64}$/.test(packet.id) || packet.state !== "reported" || packet.verification !== null || packet.landedAs !== null) return yield* input(`machine ${row.machine}: invalid packet sidecar identity`);
        const report = join(reportsDir(dir), row.lane, `${row.name}-${packet.id.slice(0,12)}.svx`);
        yield* mutate(dir, current => Effect.gen(function* () {
          if (current.packets.some(prior => prior.id === packet.id)) return [current, false] as const;
          const latest = yield* findRow(current, row.name);
          const earlier = [...current.packets].reverse().find(prior => prior.agent === latest.name && !TERMINAL_PACKET_STATES.includes(prior.state));
          if (earlier) {
            if (packet.kind !== "commit" || earlier.kind !== "commit") return yield* input(`machine ${row.machine}: earlier packet needs an outcome first`);
            const runner = yield* Proc;
            const ancestry = yield* sshProc(row.machine, machine, runner, env.home).run("git", ["merge-base", "--is-ancestor", earlier.id, packet.id], { cwd: row.cwd, timeoutMs: 15_000 });
            if (ancestry.code !== 0) return yield* input(`machine ${row.machine}: non-ancestor follow-up requires an outcome first`);
          }
          const reportingAgain = ["reported", "verified", "landed"].includes(latest.state);
          const live = reportingAgain && latest.pane ? yield* onRemote(row.machine, machine, locatePane(latest.pane)) : null;
          const state = yield* stepAgent(latest.name, latest.state, { type: "REPORT", paneLive: !!live?.agent });
          yield* Effect.try({ try: () => { mkdirSync(dirname(report), { recursive: true }); writeFileSync(report, sidecar.reportText); }, catch: error => new StoreError({ path: report, message: String(error) }) });
          const ingested: Packet = { ...packet, report, verification: null, gate: null, landedAs: null, supersedes: earlier?.id ?? null };
          return [withPacket(withRow(current, { ...latest, state, updatedAt: iso(env) }), ingested), true] as const;
        }));
      }).pipe(Effect.catch(error => Effect.sync(() => {
        skipped(`sidecar ${entry.id}: ${error.message}`);
        if (error._tag === "ProcError" && (error.code === null || error.code === 255)) failedMachines.add(row.machine);
      })));
    }
  }
  return { notes, failedMachines };
});

const remoteSessionTimes = (project: Project, failedMachines: Set<string>, notes: string[]) => Effect.gen(function* () {
  const result = new Map<string, number | null>();
  const names = [...new Set(project.agents.filter(row => row.machine !== "local" && row.state !== "closed").map(row => row.machine))];
  for (const name of names) {
    if (failedMachines.has(name)) continue;
    yield* Effect.gen(function* () {
      const machine = yield* machineConfig(name);
      const files = project.agents.filter(row => row.machine === name).slice(0, 100).map(row => row.sessionFile).filter((file): file is string => file !== null);
      const raw = yield* remoteNode(name, machine, `import {statSync} from 'node:fs';console.log(JSON.stringify(process.argv.slice(1).map(p=>{try{return [p,statSync(p).mtimeMs]}catch{return [p,null]}})));`, files);
      const entries = yield* decodeJsonWith(Schema.decodeUnknownSync(Schema.Array(Schema.Tuple([Schema.String, Schema.NullOr(Schema.Number)]))), raw);
      for (const [file, mtime] of entries) result.set(`${name}:${file}`, mtime);
    }).pipe(Effect.catch(error => Effect.sync(() => { failedMachines.add(name); notes.push(`machine ${name}: session stats skipped: ${error.message}`); })));
  }
  return result;
});

/** Re-adoption is evidence-only: no launch, input, or silence actions. */
const READOPT_STATES: readonly AgentRow["state"][] = ["interrupted", "silent", "nudged", "restarted"];
const sameSessionFile = (row: AgentRow, file: string) => file === row.sessionFile || file.endsWith(`_${row.sessionId}.jsonl`);
const adoptionBinding = (row: AgentRow, pane: PaneInfo): PaneBinding => ({
  paneId: pane.pane_id, tabId: pane.tab_id, terminalId: pane.terminal_id,
  openedByMuster: row.pane?.terminalId === pane.terminal_id && row.pane.openedByMuster,
});
const adoptionHolder = (project: Project, row: AgentRow, pane: PaneInfo) => project.agents.find(other =>
  other.machine === row.machine && other.name !== row.name && other.state !== "closed" && sharesPane(adoptionBinding(row, pane), other.pane));

/** Pi's read-only parser owns the header format; never open/migrate a live transcript. */
const adoptionSession = (row: AgentRow, pane: PaneInfo) => Effect.gen(function* () {
  const file = pane.agent_session?.kind === "path" ? pane.agent_session.value : null;
  if (!pane.agent || !(pane.agent === "pi" || pane.agent_session?.agent === "pi") || !file) return null;
  if (sameSessionFile(row, file)) return { sessionFile: file, sessionId: sessionIdFromFile(file) ?? row.sessionId };
  const headerText = row.machine === "local"
    ? yield* Effect.try({ try: () => readFileSync(file, "utf8").split("\n", 1)[0] ?? "", catch: error => input(String(error)) })
    : yield* Effect.gen(function* () {
        const proc = yield* Proc;
        const result = yield* proc.run("node", ["--input-type=module", "-e", "import {readFileSync} from 'node:fs';process.stdout.write(readFileSync(process.argv[1],'utf8').split('\\n',1)[0]??'');", file], { cwd: "/", timeoutMs: 30_000 });
        if (result.code !== 0) return yield* input("cannot read the live session header");
        return result.stdout;
      });
  const header = yield* Effect.try({ try: () => parseSessionEntries(headerText).find(entry => entry.type === "session"), catch: error => input(String(error)) });
  if (!header || typeof header.parentSession !== "string" || !sameSessionFile(row, header.parentSession)) return null;
  const sessionId = yield* decodeWith(Schema.decodeUnknownSync(SessionId), header.id);
  return { sessionFile: file, sessionId };
}).pipe(Effect.orElseSucceed(() => null));

const readoptRow = (dir: string, row: AgentRow, pane: PaneInfo, session: { sessionFile: string; sessionId: string }, preserveState = false) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  return yield* mutate(dir, project => Effect.gen(function* () {
    const latest = yield* findRow(project, row.name);
    yield* requireOwner(latest, env.sessionId, false);
    if (latest.state !== row.state || latest.sessionId !== row.sessionId || latest.sessionFile !== row.sessionFile ||
        latest.pane?.terminalId !== row.pane?.terminalId || latest.machine !== row.machine) return yield* input("row changed during adoption; retry");
    const holder = adoptionHolder(project, latest, pane);
    if (holder) return yield* input(`pane ${pane.pane_id} already bound to ${holder.name}`);
    if (preserveState) {
      const next: AgentRow = { ...latest, pane: adoptionBinding(latest, pane), updatedAt: iso(env) };
      return [withRow(project, next), next] as const;
    }
    const event: AgentEvent[] = latest.state === "running" ? [] : [{ type: READOPT_STATES.includes(latest.state) && latest.state !== "interrupted" ? "ACTIVE" : "ADOPT" }];
    const state = yield* advance(latest, event);
    const selected = yield* sessionRestore(latest.profile, session.sessionFile, project, latest.role, (yield* loadRoster).roster, {}, latest.machine !== "local");
    const restore = latest.restore ? { ...latest.restore, argv: latest.restore.argv.map((arg, index, argv) =>
      argv[index - 1] === "--session" ? session.sessionFile : argv[index - 1] === "--session-id" ? session.sessionId : argv[index - 1] === "--model" ? `${selected.profile.model}:${selected.profile.thinking}` : arg) } : null;
    const next: AgentRow = { ...latest, ...session, pane: adoptionBinding(latest, pane), state, restore, updatedAt: iso(env) };
    return [withRow(project, next), next] as const;
  }));
});

/** Search only the project's space (remote launches use its label on that machine). */
const readoptionPanes = (project: Project, row: AgentRow) => Effect.gen(function* () {
  if (row.machine === "local") return project.spaceId ? yield* paneList(project.spaceId) : [];
  const spaces = (yield* workspaceList()).filter(space => space.label === project.label);
  if (spaces.length !== 1) return [];
  return yield* paneList(spaces[0]!.workspace_id);
});

/** Exact identity repair is independent of lifecycle recovery. Never select among live copies. */
const findRebinding = (project: Project, row: AgentRow, bound: PaneInfo | null | undefined) => Effect.gen(function* () {
  if (row.state === "closed" || READOPT_STATES.includes(row.state) || !row.sessionFile || bound) return { kind: "none" } as const;
  const matches = (yield* readoptionPanes(project, row)).filter(pane =>
    pane.agent === "pi" && pane.agent_session?.kind === "path" && pane.agent_session.value === row.sessionFile);
  if (matches.length > 1) return { kind: "refused", note: `rebind refused ${row.name}: multiple session path matches: ${matches.map(pane => pane.pane_id).join(", ")}` } as const;
  const pane = matches[0];
  if (!pane) return { kind: "none" } as const;
  const holder = adoptionHolder(project, row, pane);
  if (holder) return { kind: "refused", note: `rebind refused ${row.name}: pane ${pane.pane_id} already bound to ${holder.name}` } as const;
  return { kind: "match", pane, session: { sessionFile: row.sessionFile, sessionId: row.sessionId } } as const;
});
/** The saved launcher environment certifies capability only on its original terminal.
 * A session path survives Herdr resume; launcher provenance does not. */
const statusEvidence = (row: AgentRow, pane: PaneInfo | null | undefined) => {
  if (pane?.agent !== "pi" || pane.agent_session?.kind !== "path" || pane.agent_session.value !== row.sessionFile) return {};
  const launched = row.pane?.terminalId === pane.terminal_id && row.pane.openedByMuster &&
    row.restore?.env.MUSTER_AGENT === row.name && !!row.restore.env.MUSTER_PROJECT && !!row.restore.env.MUSTER_OWNER;
  return {
    identity: "proven (session path match)",
    capability: launched ? "launch-profile receipt (Muster launcher, bound terminal)" : "unknown (resumed outside Muster)",
    ...(!launched && ["running", "silent", "nudged", "restarted", "reported", "verified", "landed"].includes(row.state)
      ? { recovery: `agent_launch action:\"restart\" name:${row.name}; re-check until list and herdr_watch list and re-arm still-needed watches` } : {}),
  };
};
const reboundNote = (row: AgentRow, pane: PaneInfo) => `rebound ${row.name} → ${pane.pane_id} (identity: session path match)`;

const findReadoption = (project: Project, row: AgentRow) => Effect.gen(function* () {
  const matches: Array<{ pane: PaneInfo; session: { sessionFile: string; sessionId: string } }> = [];
  for (const pane of yield* readoptionPanes(project, row)) {
    if (adoptionHolder(project, row, pane)) continue;
    const session = yield* adoptionSession(row, pane);
    if (session && (row.state === "interrupted" || pane.pane_id !== row.pane?.paneId || pane.terminal_id !== row.pane?.terminalId || session.sessionFile !== row.sessionFile)) matches.push({ pane, session });
  }
  // Multiple live copies are ambiguous; leave the row alone and require an explicit pane.
  return matches.length === 1 ? matches[0] : undefined;
});

const remoteStatusRow = (dir: string, project: Project, row: AgentRow, act: boolean, mtimes: Map<string, number | null>) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const machine = yield* machineConfig(row.machine);
  return yield* onRemote(row.machine, machine, Effect.gen(function* () {
    let pane = row.pane ? yield* locatePane(row.pane) : null;
    let current = row;
    let action: string | null = null;
    const mine = row.owner === env.sessionId;
    const rebinding = mine ? yield* findRebinding(project, row, pane) : { kind: "none" } as const;
    const reAdoption = rebinding.kind === "none" && act && mine && READOPT_STATES.includes(row.state) ? yield* findReadoption(project, row) : undefined;
    if (rebinding.kind === "match") {
      if (act) current = yield* readoptRow(dir, row, rebinding.pane, rebinding.session, !READOPT_STATES.includes(row.state));
      pane = rebinding.pane;
      action = `${reboundNote(row, pane)}${act ? "" : " (preview; act: false)"}`;
    } else if (rebinding.kind === "refused") {
      action = rebinding.note;
    } else if (reAdoption) {
      current = yield* readoptRow(dir, row, reAdoption.pane, reAdoption.session);
      pane = reAdoption.pane;
      action = `re-adopted ${pane.pane_id}`;
    } else if (act && mine && !pane && row.pane && PROCESS_STATES.includes(row.state)) {
      current = yield* patchRow(dir, row.name, row.state, [{ type: "PANE_GONE" }], { pane: null }); action = "remote pane gone: interrupted";
    } else if (act && mine && pane && !pane.agent && PROCESS_STATES.includes(row.state)) {
      current = yield* patchRow(dir, row.name, row.state, [{ type: "PANE_GONE" }]); action = "remote agent exited: interrupted";
    } else if (pane && row.pane && row.state !== "interrupted") {
      const file = pane.agent_session?.kind === "path" ? pane.agent_session.value : null;
      const matches = file !== null && (file === row.sessionFile || file.endsWith(`_${row.sessionId}.jsonl`));
      const failedModel = row.state === "failed" && row.events?.some(event => event.type === "MODEL_ERROR");
      const adopt = !failedModel && matches && ["launching", "failed"].includes(row.state);
      if (adopt && act && mine) current = yield* patchRow(dir, row.name, row.state, [{ type: "ADOPT" }], { sessionFile: file });
      if (act && mine && (pane.pane_id !== row.pane.paneId || (file && file !== current.sessionFile && !["launching", "failed"].includes(current.state)))) current = yield* patchRow(dir, row.name, current.state, [], { pane: { ...row.pane, paneId: pane.pane_id, tabId: pane.tab_id }, ...(file ? { sessionFile: file, sessionId: sessionIdFromFile(file) ?? row.sessionId } : {}) });
    }
    const mtime = current.sessionFile ? mtimes.get(`${row.machine}:${current.sessionFile}`) ?? null : null;
    const silent = mtime === null ? null : Math.max(0, env.now().getTime() - mtime);
    if (rebinding.kind === "none" && !reAdoption && pane && silent !== null && ["running", "silent", "nudged", "restarted"].includes(current.state)) {
      const decision = silenceDecision(current.state, silent, silenceLimits(project.policy));
      if (decision.action !== "none") {
        action = `${decision.action} due on ${row.machine}`;
        if (act && mine) {
          if (decision.action === "nudge") {
            yield* paneSendKeys(pane.pane_id, ["Escape"]);
            yield* paneRun(pane.pane_id, nudgeNote(silent));
            current = yield* patchRow(dir, row.name, current.state, decision.events);
          } else {
            const result = yield* restartByFork(dir, project, current).pipe(Effect.result);
            if (result._tag === "Failure") action = `restart failed: ${result.failure.message}`;
            else { current = result.success.row; pane = current.pane ? yield* locatePane(current.pane) : null; action = `restarted by fork on ${row.machine}; first turn proven`; }
          }
          if (decision.action === "nudge") action = `${decision.action} on ${row.machine}`;
        }
      }
    }
    return { ...statusEvidence(current, pane), name: row.name, role: row.role, lane: row.lane, state: current.state, pane: pane?.pane_id ?? null, silentMin: silent === null ? null : Math.floor(silent/60_000), cache: null, cost: null, intercom: "unknown" as const, sessionId: row.intercomAddress ?? `${row.name}@${machine.herdr}`, action } satisfies AgentLine;
  }));
});

const verifyRemotePacket = (project: Project, lane: Lane | undefined, row: AgentRow, packet: Packet) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const runner = yield* Proc;
  const machine = yield* machineConfig(row.machine);
  const remote = sshProc(row.machine, machine, runner, env.home);
  const checks: CheckOutcome[] = [{ name: "report exists", outcome: existsSync(packet.report) && statSync(packet.report).size > 0 ? "pass" : "fail", detail: packet.report }];
  const probe = (name: string, args: string[]) => remote.run("git", args, { cwd: row.cwd, timeoutMs: 30_000 }).pipe(Effect.map(result => ({ name, outcome: result.code === 0 ? "pass" as const : "fail" as const, detail: (result.stdout + result.stderr).trim() })));
  if (packet.kind === "artifact") {
    const raw = yield* remoteNode(row.machine, machine, `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';console.log(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'));`, [packet.artifact ?? ""]);
    checks.push({ name: "artifact hash", outcome: raw.trim() === packet.id ? "pass" : "fail", detail: `sha256 is ${raw.trim()}` });
    return { checks, branch: null };
  }
  const cloneExists = (yield* remote.run("test", ["-d", row.cwd], { cwd: "/", timeoutMs: 30_000 })).code === 0;
  if (!cloneExists) {
    const source = mapPath(sourceOf(project, lane, row), machine);
    const sourceExists = (yield* remote.run("test", ["-d", source], { cwd: "/", timeoutMs: 30_000 })).code === 0;
    const fallback = yield* verifyGoneClone(remote, source, lane, row, packet.id, sourceExists);
    return { checks: [...checks, ...fallback.checks], branch: null };
  }
  checks.push(yield* probe("commit exists", ["cat-file", "-e", `${packet.id}^{commit}`]));
  const branchEvidence = yield* verifyCommitBranch(remote, row.cwd, packet.id, row.clone?.branch ?? "HEAD");
  checks.push(branchEvidence.check);
  if (row.clone?.base) checks.push(yield* probe("clone base", ["merge-base", "--is-ancestor", row.clone.base.sha, packet.id]));
  const roots = yield* remote.run("git", ["rev-list", "--max-parents=0", packet.id], { cwd: row.cwd, timeoutMs: 30_000 });
  const sourceRoots = (yield* git(sourceOf(project, lane, row), "rev-list", "--max-parents=0", "HEAD")).split("\n");
  checks.push({ name: "expected repo", outcome: roots.code === 0 && roots.stdout.split("\n").filter(Boolean).some(root => sourceRoots.includes(root)) ? "pass" : "fail" });
  const dirty = yield* remote.run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: row.cwd, timeoutMs: 30_000 });
  const generated = [...(lane?.generated ?? []), ...DEFAULT_GENERATED];
  const paths = parsePorcelainZ(dirty.stdout).filter(path => !isGenerated(path, generated));
  // Compare hashes, not file contents; private files never cross the transport.
  const hashes = paths.length ? yield* remoteNode(row.machine, machine, `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';console.log(JSON.stringify(process.argv.slice(2).map(p=>{try{return createHash('sha256').update(readFileSync(process.argv[1]+'/'+p)).digest('hex')}catch{return null}})));`, [row.cwd, ...paths]) : "[]";
  const remoteHashes = yield* decodeJsonWith(Schema.decodeUnknownSync(Schema.Array(Schema.NullOr(Schema.String))), hashes);
  const differing = paths.filter((path, i) => {
    const local = join(sourceOf(project, lane, row), path);
    return remoteHashes[i] === null ? existsSync(local) : !existsSync(local) || statSync(local).isDirectory() || sha256File(local) !== remoteHashes[i];
  });
  checks.push({ name: "dirty paths", outcome: dirty.code === 0 && differing.length === 0 ? "pass" : "fail", detail: differing.join(", ") });
  return { checks, branch: branchEvidence.branch };
});

// ---------- small pure helpers ----------

const iso = (env: { now: () => Date }) => env.now().toISOString();
const recordOwnerForward = (from: string, to: string, project: string, env: { home: string; now: () => Date }) => Effect.try({
  try: () => forwardOwner({ from, to, project, home: env.home, at: iso(env) }),
  catch: error => new StoreError({ path: env.home, message: `owner handover failed: ${String(error)}` }),
});

const input = (message: string) => new InputError({ message });

export function findRow(project: Project, name: string) {
  const row = project.agents.find((agent) => agent.name === name);
  return row ? Effect.succeed(row) : Effect.fail(new NotFound({ kind: "agent", id: name, message: `no agent row named ${name}` }));
}

export function findLane(project: Project, slug: string) {
  const lane = project.lanes.find((candidate) => candidate.slug === slug);
  return lane ? Effect.succeed(lane) : Effect.fail(new NotFound({ kind: "lane", id: slug, message: `no lane named ${slug}` }));
}

export function findPacket(project: Project, id: string): Effect.Effect<Packet, NotFound | InputError> {
  const matches = project.packets.filter((packet) => packet.id === id || (id.length >= 7 && packet.id.startsWith(id)));
  if (matches.length === 1) return Effect.succeed(matches[0] as Packet);
  return Effect.fail(
    matches.length === 0
      ? new NotFound({ kind: "packet", id, message: `no packet ${id}` })
      : new InputError({ message: `packet id ${id} is ambiguous: ${matches.map((packet) => packet.id.slice(0, 12)).join(", ")}` }),
  );
}

const withRow = (project: Project, row: AgentRow): Project => ({
  ...project,
  agents: project.agents.some((agent) => agent.name === row.name)
    ? project.agents.map((agent) => (agent.name === row.name ? row : agent))
    : [...project.agents, row],
});
const withLane = (project: Project, lane: Lane): Project => ({
  ...project,
  lanes: project.lanes.some((candidate) => candidate.slug === lane.slug)
    ? project.lanes.map((candidate) => (candidate.slug === lane.slug ? lane : candidate))
    : [...project.lanes, lane],
});
const withPacket = (project: Project, packet: Packet): Project => ({
  ...project,
  packets: project.packets.some((candidate) => candidate.id === packet.id)
    ? project.packets.map((candidate) => (candidate.id === packet.id ? packet : candidate))
    : [...project.packets, packet],
});

const advance = (row: AgentRow, events: readonly AgentEvent[]) =>
  Effect.gen(function* () {
    let state = row.state;
    for (const event of events) state = yield* stepAgent(row.name, state, event);
    return state;
  });

/** Apply events to a row inside a locked mutation, only if the row is still in the state the caller read. */
const patchRow = (dir: string, name: string, expected: AgentRow["state"] | null, events: readonly AgentEvent[], patch: Partial<AgentRow> = {}) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    return yield* mutate(dir, (project) =>
      Effect.gen(function* () {
        const row = yield* findRow(project, name);
        if (expected !== null && row.state !== expected) {
          return yield* new IllegalTransition({
            machine: "agent",
            id: name,
            from: row.state,
            event: events.map((event) => event.type).join(","),
            message: `agent ${name} moved to ${row.state} while this operation expected ${expected}`,
          });
        }
        const state = yield* advance(row, events);
        const next: AgentRow = { ...row, ...patch, state, updatedAt: iso(env) };
        return [withRow(project, next), next] as const;
      }),
    );
  });

const requireAbsolute = (label: string, path: string) =>
  isAbsolute(path) ? Effect.succeed(resolve(path)) : Effect.fail(input(`${label} must be an absolute path, got ${path}`));

const guardDurable = (project: Pick<Project, "ephemeral">, label: string, path: string) =>
  !project.ephemeral && isTempPath(path)
    ? Effect.fail(
        new GuardFailed({
          guard: "durable-state",
          message: `${label} ${path} is under a temp dir, which dies on reboot. Use a durable path, or open the project with ephemeral: true for a throwaway run.`,
        }),
      )
    : Effect.void;

const decodeJsonWith = <A>(decode: (value: unknown) => A, raw: string) => Effect.try({ try: () => decode(JSON.parse(raw)), catch: error => input(`invalid remote JSON: ${String(error)}`) });

const decodeWith = <A>(decode: (value: unknown) => A, value: unknown) =>
  Effect.try({ try: () => decode(value), catch: (error) => input(String(error instanceof Error ? error.message : error)) });

// ---------- tokens and Brain projection ----------

/** Display only. A failed publish is a warning, never a failed operation. */
export const publishTokens = (project: Project, live: LiveCounts = {}) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    if (!project.spaceId) return "no space bound; tokens not published";
    const desk = readDesk(queuePath(project.slug, env.home));
    const tokens = deriveTokens(project, desk, live);
    const shown = `now=${tokens.now ?? "-"} progress=${tokens.progress ?? "-"} agents=${tokens.agents ?? "-"} needs=${tokens.needs ?? "-"}`;
    if (project.sidebar === "off") return `sidebar off (shared space); would publish ${shown}`;
    return yield* reportTokens(project.spaceId, TOKEN_SOURCE, { ...tokens }, env.now().getTime(), TOKEN_TTL_MS).pipe(
      Effect.as(`tokens: ${shown}`),
      Effect.catch((error) => Effect.succeed(`tokens not published: ${error.message}`)),
    );
  });

const BRAIN_MARKER = "generated_by: pi-muster";

export function brainSummary(project: Project): string {
  const esc = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lanes = project.lanes.filter((lane) => !lane.archived);
  const lines = [
    "---",
    `title: ${JSON.stringify(`${project.label}: Muster board`)}`,
    `type: ${JSON.stringify(project.boardType)}`,
    `status: ${JSON.stringify(project.state === "archived" ? "archived" : "active")}`,
    `created_at: ${JSON.stringify(project.createdAt.slice(0, 10))}`,
    `privacy: ${JSON.stringify("private")}`,
    BRAIN_MARKER,
    "tags:",
    "  - muster",
    "---",
    "",
    `# ${project.label}`,
    "",
    "Muster writes this page from `.brain/data/muster/project.json`. Edit the project through Muster; hand edits here are overwritten.",
    "",
    `- Outcome: ${project.outcome}`,
    `- Review trigger: ${project.reviewTrigger}`,
    `- Next action: ${project.nextAction}`,
    ...(project.headline ? [`- Now: ${project.headline}`] : []),
    `- Mode: ${project.mode}; state: ${project.state}`,
    "",
    "## Critical path",
    "",
    ...(project.criticalPath.length ? project.criticalPath.map((step, index) => `${index + 1}. ${step}`) : ["(none recorded)"]),
    "",
    "## Lanes",
    "",
    "| Lane | State | Goal |",
    "| --- | --- | --- |",
    ...lanes.map((lane) => `| ${esc(lane.label)} | ${lane.state} | ${esc(lane.goal)} |`),
    "",
    "## Packets",
    "",
    "| Packet | Lane | Agent | State | Report | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...project.packets.map((packet) => `| \`${packet.id.slice(0, 12)}\` | ${packet.lane} | ${packet.agent} | ${packet.state} | \`${esc(packet.report)}\` | ${esc(packet.evidence ?? "-")} |`),
    "",
    "## Agents",
    "",
    "| Agent | Role | Lane | State | Restore |",
    "| --- | --- | --- | --- | --- |",
    ...project.agents.map(
      (agent) =>
        `| ${agent.name} | ${agent.role} | ${agent.lane} | ${agent.state} | ${agent.restore ? `\`cd ${esc(agent.restore.cwd)} && ${agent.machine === "local" ? "pi " : ""}${esc(agent.restore.argv.join(" "))}\`` : "-"} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

export const writeBrain = (project: Project) =>
  Effect.sync(() => {
    const path = join(project.dir, ".brain", "projects", "muster", `${project.slug}.svx`);
    if (existsSync(path) && !readFileSync(path, "utf8").includes(BRAIN_MARKER)) return `kept hand-written ${path}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, brainSummary(project));
    return path;
  });

// ---------- project_open ----------

export interface ProjectOpenInput {
  readonly boardType?: string | undefined;
  readonly dir: string;
  readonly slug?: string | undefined;
  readonly label?: string | undefined;
  readonly outcome?: string | undefined;
  readonly reviewTrigger?: string | undefined;
  readonly criticalPath?: readonly string[] | undefined;
  readonly nextAction?: string | undefined;
  readonly mode?: Mode | undefined;
  readonly space?: string | undefined;
  readonly createSpace?: boolean | undefined;
  readonly desk?: boolean | undefined;
  /** Publish sidebar tokens in an adopted space. A created space always gets them. */
  readonly sidebar?: boolean | undefined;
  readonly cadenceMinutes?: number | null | undefined;
  readonly ephemeral?: boolean | undefined;
  readonly musterExtension?: string | null | undefined;
  readonly deskExtension?: string | null | undefined;
}

export const DEFAULT_DESK_EXTENSION =
  process.env.MUSTER_DESK_EXTENSION ?? join(process.env.HOME ?? "", "Code", "joelhooks", "dark-wizard", "herdr", "desk", "desk-queue.ts");

export function cadenceCall(project: Project) {
  if (!project.cadenceMinutes) return null;
  return {
    tool: "until",
    args: {
      action: "repeat",
      intervalSeconds: project.cadenceMinutes * 60,
      timeoutSeconds: 14 * 24 * 3600,
      label: `🐑 ${project.slug} pass`,
      quickRef: `project_status ${project.dir}`,
      instruction: `Muster owner pass for ${project.slug}. Call project_status for ${project.dir}. Verify and land any reported packets, answer blocks from source, open or close lanes the critical path needs, and post Joel items with desk_post. An empty pass ends in one line.`,
    },
  };
}

export const projectOpen = (params: ProjectOpenInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const dir = yield* requireAbsolute("dir", params.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return yield* input(`project dir ${dir} does not exist`);
    if (params.cadenceMinutes != null && (params.cadenceMinutes < 1 || params.cadenceMinutes > MAX_CADENCE_MINUTES)) {
      return yield* input(`cadenceMinutes must be 1-${MAX_CADENCE_MINUTES}: a wake past the one-hour cache TTL rebuilds the whole prefix cold`);
    }
    const now = iso(env);
    let adopted = exists(dir);
    if (!adopted) {
      const slug = yield* decodeWith(decodeSlug, params.slug);
      for (const [key, value] of [
        ["outcome", params.outcome],
        ["reviewTrigger", params.reviewTrigger],
        ["nextAction", params.nextAction],
      ] as const) {
        if (!value?.trim()) return yield* input(`a new project needs ${key}`);
      }
      const ephemeral = params.ephemeral === true;
      yield* guardDurable({ ephemeral }, "project dir", dir);
      yield* create({
        version: 1,
        slug,
        label: params.label?.trim() || slug,
        dir,
        outcome: params.outcome as string,
        reviewTrigger: params.reviewTrigger as string,
        boardType: params.boardType ?? "project",
        criticalPath: [...(params.criticalPath ?? [])],
        nextAction: params.nextAction as string,
        mode: params.mode ?? "rift-merge",
        spaceId: null,
        sidebar: params.sidebar ? "owned" : "off",
        ephemeral,
        musterExtension: params.musterExtension === undefined ? env.musterRoot : params.musterExtension,
        deskExtension:
          params.deskExtension === undefined ? (existsSync(DEFAULT_DESK_EXTENSION) ? DEFAULT_DESK_EXTENSION : null) : params.deskExtension,
        cadenceMinutes: params.cadenceMinutes ?? null,
        state: "setup",
        lanes: [],
        agents: [],
        packets: [],
        reviews: [],
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const existing = yield* load(dir);
      if (params.slug && params.slug !== existing.slug) return yield* input(`project at ${dir} is ${existing.slug}, not ${params.slug}`);
      yield* guardDurable({ ephemeral: existing.ephemeral || params.ephemeral === true }, "project dir", dir);
    }

    let spaceId: string | null = (yield* load(dir)).spaceId;
    let createdRoot: string | null = null;
    let adoptedLabel: string | null = null;
    if (params.space) {
      const spaces = yield* workspaceList();
      const space = spaces.find((candidate) => candidate.workspace_id === params.space);
      if (!space) return yield* input(`no Herdr workspace ${params.space}`);
      spaceId = params.space;
      adoptedLabel = space.label.trim() || null;
    } else if (!spaceId && params.createSpace) {
      const label = (yield* load(dir)).label;
      const created = yield* workspaceCreate(label, dir);
      spaceId = created.workspace.workspace_id;
      createdRoot = created.root_pane.pane_id;
    }

    const project = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        let state = current.state;
        if (spaceId && state === "setup") state = yield* stepProject(current.slug, state, { type: "ACTIVATE" });
        const next: Project = {
          ...current,
          // An adopted space already has a name; the slug is only a fallback.
          label: params.label?.trim() || (adoptedLabel && current.label === current.slug ? adoptedLabel : current.label),
          boardType: params.boardType ?? current.boardType,
          outcome: params.outcome?.trim() || current.outcome,
          reviewTrigger: params.reviewTrigger?.trim() || current.reviewTrigger,
          criticalPath: params.criticalPath ? [...params.criticalPath] : current.criticalPath,
          nextAction: params.nextAction?.trim() || current.nextAction,
          mode: params.mode ?? current.mode,
          spaceId,
          sidebar: createdRoot || params.sidebar === true ? "owned" : params.sidebar === false ? "off" : current.sidebar,
          ephemeral: current.ephemeral || params.ephemeral === true,
          cadenceMinutes: params.cadenceMinutes === undefined ? current.cadenceMinutes : params.cadenceMinutes,
          musterExtension: params.musterExtension === undefined ? current.musterExtension : params.musterExtension,
          deskExtension: params.deskExtension === undefined ? current.deskExtension : params.deskExtension,
          state,
        };
        return [next, next] as const;
      }),
    );

    const notes: string[] = [];
    const visibility = yield* publicCheckout(dir);
    if (visibility === "public") notes.push(`⚠ ${dir} is a public GitHub checkout; Muster state there is one commit from being published. Use a private dir.`);
    if (visibility === "unknown") notes.push("GitHub checkout visibility unknown (git/gh unavailable or failed).");
    if (params.desk && !project.lanes.some((lane) => lane.slug === "desk" && lane.state !== "closed")) {
      const desk = yield* laneOpen(dir, { slug: "desk", kind: "role", label: "💬 desk", goal: "Joel's gateway: answers from evidence and turns feedback into dispatches" });
      notes.push(`desk tab ${desk.lane.tabId}${createdRoot ? " (first tab)" : " (appended; an adopted space keeps its tab order)"}`);
      if (createdRoot) yield* paneClose(createdRoot).pipe(Effect.catch(() => Effect.void));
    }
    const final = yield* load(dir);
    yield* registerProject(final);
    notes.push(yield* publishTokens(final));
    notes.push(`brain: ${yield* writeBrain(final)}`);
    notes.push(deployPostureLine(final));
    return { project: final, adopted, cadence: cadenceCall(final), notes };
  });

// ---------- project_move ----------

export type CheckoutVisibility = "public" | "private" | "unknown" | "not-github";

/** Pure boundary decisions; only github.com origins qualify. */
export function githubOrigin(origin: string): string | null {
  const match = /^(?:git@github\.com:|(?:https?|ssh):\/\/(?:git@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(origin.trim());
  return match?.[1] ?? null;
}

export function checkoutVisibility(origin: string, response: unknown): CheckoutVisibility {
  if (!githubOrigin(origin)) return "not-github";
  if (typeof response !== "object" || response === null || !("visibility" in response)) return "unknown";
  return response.visibility === "PUBLIC" ? "public" : response.visibility === "PRIVATE" || response.visibility === "INTERNAL" ? "private" : "unknown";
}

export const publicCheckout = (dir: string) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    const repo = yield* proc.run("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 10_000 });
    if (repo.code !== 0) return "unknown" as const;
    const origin = yield* proc.run("git", ["remote", "get-url", "origin"], { cwd: dir, timeoutMs: 10_000 });
    if (origin.code !== 0) return "unknown" as const;
    const name = githubOrigin(origin.stdout);
    if (!name) return "not-github" as const;
    const result = yield* proc.run("gh", ["repo", "view", name, "--json", "visibility"], { cwd: dir, timeoutMs: 10_000 });
    if (result.code !== 0) return "unknown" as const;
    return yield* Effect.try({ try: () => checkoutVisibility(origin.stdout, JSON.parse(result.stdout) as unknown), catch: () => input("invalid gh visibility response") });
  }).pipe(Effect.catch(() => Effect.succeed("unknown" as const)));

/** Check a not-yet-created target using its nearest existing parent checkout. */
const existingParent = (path: string): string => {
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  return parent;
};

const guardMoveTree = (root: string, paths: readonly string[]) => {
  for (const path of paths) {
    let at = path;
    while (at !== root) {
      if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error(`refusing symlinked state path ${at}`);
      at = dirname(at);
    }
  }
};

const moveIO = <A>(path: string, run: () => A) =>
  Effect.try({ try: run, catch: (error) => new StoreError({ path, message: `project move failed: ${String(error)}` }) });

export const projectMove = (dir: string, destination: string) =>
  Effect.gen(function* () {
    const toInput = yield* requireAbsolute("to", destination);
    const old = yield* moveIO(dir, () => realpathSync(dir));
    yield* moveIO(old, () => guardMoveTree(old, [dataDir(old)]));
    const initial = yield* load(old);
    yield* guardDurable(initial, "to", toInput);
    const parent = existingParent(toInput);
    const visibility = yield* publicCheckout(parent);
    if (visibility === "public") return yield* input(`target ${toInput} is inside a public GitHub checkout; use a private dir`);
    yield* moveIO(toInput, () => mkdirSync(toInput, { recursive: true }));
    const to = yield* moveIO(toInput, () => realpathSync(toInput));
    yield* guardDurable(initial, "to", to);
    if (to === old || to.startsWith(`${dataDir(old)}/`) || old.startsWith(`${dataDir(to)}/`)) return yield* input("source and target Muster state overlap");
    if (exists(to)) return yield* input(`target ${to} already holds a Muster project`);

    const result = yield* mutate(old, (current) => Effect.gen(function* () {
        yield* moveIO(to, () => {
          guardMoveTree(to, [dataDir(to), join(to, ".brain", "projects", "muster")]);
          guardMoveTree(old, [join(old, ".brain", "projects", "muster")]);
          mkdirSync(dataDir(to), { recursive: true });
        });
        const targetLock = `${projectPath(to)}.lock`;
        return yield* Effect.acquireUseRelease(
          moveIO(to, () => mkdirSync(targetLock)),
          () => Effect.gen(function* () {
            if (exists(to)) return yield* input(`target ${to} already holds a Muster project`);
            const oldBoard = join(old, ".brain", "projects", "muster", `${current.slug}.svx`);
            const newBoard = join(to, ".brain", "projects", "muster", `${current.slug}.svx`);
            if (existsSync(newBoard)) return yield* input(`target board already exists: ${newBoard}`);
            const rewrittenPaths: Array<{ from: string; to: string }> = [];
            const rewritePath = (value: string) => {
              const next = value === oldBoard ? newBoard : value.startsWith(`${dataDir(old)}/`) ? `${dataDir(to)}/${value.slice(dataDir(old).length + 1)}` : value;
              if (next !== value && !rewrittenPaths.some((entry) => entry.from === value)) rewrittenPaths.push({ from: value, to: next });
              return next;
            };
            const rewrite = (value: unknown, key = ""): unknown => {
              if (key === "cwd" || key === "repo") return value;
              if (typeof value === "string") return rewritePath(value);
              if (Array.isArray(value)) return value.map((entry) => rewrite(entry));
              if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]));
              return value;
            };
            const next = yield* decodeWith(Schema.decodeUnknownSync(ProjectSchema), rewrite(current));
            const lanesGivenRepo = current.lanes.filter((lane) => lane.repo === null).map((lane) => lane.slug);
            const moved: Project = {
              ...next, dir: to,
              lanes: next.lanes.map((lane) => ({ ...lane, repo: lane.repo ?? old })),
              agents: next.agents.map((row) => ({ ...row, restore: row.restore ? { ...row.restore, env: { ...row.restore.env, MUSTER_PROJECT: to } } : null })),
            };
            const manifest = yield* moveIO(old, () => {
              const files: Array<{ from: string; to: string; hash: string }> = [];
              const walk = (source: string, target: string) => {
                for (const entry of readdirSync(source, { withFileTypes: true })) {
                  const from = join(source, entry.name);
                  const dest = join(target, entry.name);
                  if (from === `${projectPath(old)}.lock`) continue;
                  if (entry.isDirectory()) walk(from, dest);
                  else if (entry.isFile()) files.push({ from, to: dest, hash: sha256File(from) });
                  else throw new Error(`refusing non-regular state file ${from}`);
                }
              };
              walk(dataDir(old), dataDir(to));
              if (existsSync(oldBoard)) {
                if (!lstatSync(oldBoard).isFile()) throw new Error(`refusing non-regular board ${oldBoard}`);
                files.push({ from: oldBoard, to: newBoard, hash: sha256File(oldBoard) });
              }
              // Never overwrite pre-existing target files, including a hand-written board.
              for (const file of files) {
                guardMoveTree(to, [file.to]);
                if (existsSync(file.to)) throw new Error(`target file already exists: ${file.to}`);
              }
              for (const file of files) {
                mkdirSync(dirname(file.to), { recursive: true });
                copyFileSync(file.from, file.to);
                if (sha256File(file.to) !== file.hash) throw new Error(`copy hash mismatch: ${file.to}`);
              }
              return files;
            });
            yield* moveIO(to, () => writeFileSync(projectPath(to), `${JSON.stringify(Schema.encodeSync(ProjectSchema)(moved), null, 2)}\n`));
            const verified = yield* load(to);
            yield* moveIO(to, () => {
              for (const packet of verified.packets) {
                if (rewrittenPaths.some((entry) => entry.to === packet.report) && !existsSync(packet.report)) throw new Error(`missing rewritten report ${packet.report}`);
              }
              // Before any removal, ensure the source hasn't changed since copying.
              for (const file of manifest) if (sha256File(file.from) !== file.hash) throw new Error(`source changed during move: ${file.from}`);
            });
            yield* writeBrain(verified);
            yield* moveIO(to, () => {
              for (const file of manifest) {
                // Catalog and board are the deliberate rewrites; every other copied file stays byte-identical.
                if (file.to !== projectPath(to) && file.to !== newBoard && sha256File(file.to) !== file.hash) throw new Error(`final copy hash mismatch: ${file.to}`);
              }
            });
            yield* registerProject(verified);
            yield* moveIO(old, () => {
              for (const file of manifest) unlinkSync(file.from);
              const prune = (path: string) => {
                for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory() && join(path, entry.name) !== `${projectPath(old)}.lock`) prune(join(path, entry.name));
                if (readdirSync(path).length === 0) rmdirSync(path);
              };
              prune(dataDir(old));
              const boardDir = dirname(oldBoard);
              if (existsSync(boardDir) && readdirSync(boardDir).length === 0) rmdirSync(boardDir);
            });
            const agentsToRestore = moved.agents.filter((row) => row.pane !== null && row.state !== "closed").map((row) => `restore ${row.name} to pick up the new project dir`);
            return [current, { project: verified, copiedFiles: manifest.length, rewrittenPaths, lanesGivenRepo, agentsToRestore,
              notes: [...(visibility === "unknown" ? ["Target GitHub visibility unknown (git/gh unavailable or failed)."] : []), "A live desk's cadence still points at the old dir until it restores; replace its old cadence with the new project dir."] }] as const;
          }),
          () => moveIO(to, () => rmdirSync(targetLock)),
        );
      }));
    yield* moveIO(old, () => { if (existsSync(dataDir(old)) && readdirSync(dataDir(old)).length === 0) rmdirSync(dataDir(old)); });
    return result;
  });

// ---------- lanes ----------

export interface LaneOpenInput {
  readonly slug: string;
  readonly label?: string | undefined;
  readonly goal?: string | undefined;
  readonly kind?: Lane["kind"] | undefined;
  readonly writeScope?: readonly string[] | undefined;
  readonly repo?: string | undefined;
  readonly base?: string | undefined;
  readonly generated?: readonly string[] | undefined;
  /** False records the lane as proposed without a tab. */
  readonly open?: boolean | undefined;
  readonly override?: string | undefined;
  readonly deployLevel?: number | undefined;
  readonly deployRule?: string | undefined;
}

export const laneOpen = (dir: string, params: LaneOpenInput & { readonly rank?: number | undefined }) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const slug = yield* decodeWith(decodeSlug, params.slug);
    const project = yield* load(dir);
    yield* guardSideDesk(project, env.sessionId, "lane_open");
    const posture = deployPosture(project);
    const requestedLevel = params.deployLevel === undefined ? undefined : yield* decodeWith(decodeDeployLevel, params.deployLevel);
    if (requestedLevel === undefined && params.deployRule !== undefined) return yield* input("deployRule requires deployLevel");
    const requestedRule = requestedLevel === undefined ? undefined : yield* decodeWith(decodeDeployRule, params.deployRule);
    if (requestedLevel !== undefined) {
      if (requestedLevel > posture.level) return yield* input(`deployLevel cannot raise project level ${posture.level}`);
      if (requestedRule !== undefined && requestedLevel > DEPLOY_RULE_CAPS[requestedRule]) return yield* input(`deployRule ${requestedRule} caps deployLevel at ${DEPLOY_RULE_CAPS[requestedRule]}`);
    }
    const deployPatch = requestedLevel !== undefined ? { deployLevel: requestedLevel, deployRule: requestedRule } : {};
    const rank = params.rank;
    if (rank !== undefined && !Number.isSafeInteger(rank)) return yield* input("rank must be a safe integer");
    if (params.repo) yield* requireAbsolute("repo", params.repo);
    const existing = project.lanes.find((lane) => lane.slug === slug);
    if (params.kind === "retro" && existing && existing.kind !== "retro") return yield* input(`lane ${slug} is kind ${existing.kind}, not retro; choose a fresh slug for the retro lane`);
    const wantOpen = params.open !== false;
    const label = params.label ?? existing?.label;
    const goal = params.goal ?? existing?.goal;
    if (label === undefined || goal === undefined) return yield* input(`new lane ${slug} requires goal and label`);
    if (wantOpen && existing?.state === "proposed" && params.goal === undefined) return yield* input(`first opening lane ${slug} requires goal`);
    if (existing?.state === "open" && existing.root) {
      const live = yield* locatePane(existing.root);
      if (live && live.pane_id === existing.root.paneId && live.tab_id === existing.tabId) {
        const requestedBase = params.base;
        // An open lane is never archived; this also repairs a lane reopened before reopening cleared the flag.
        const lane = requestedBase === undefined && params.deployLevel === undefined && !existing.archived ? existing : yield* mutate(dir, (current) => {
          const latest = current.lanes.find((candidate) => candidate.slug === slug) ?? existing;
          const next = { ...latest, ...deployPatch, base: requestedBase ?? latest.base, archived: false, updatedAt: iso(env) };
          return Effect.succeed([withLane(current, next), next] as const);
        });
        return { lane, created: false, note: null, outcome: project.outcome };
      }
    }
    if (wantOpen && !project.spaceId) return yield* input("the project has no space; run project_open with space or createSpace first");

    const refusal = wantOpen ? wipRefusal(project, slug, existing?.kind ?? params.kind ?? "work", env.now().getTime()) : null;
    if (params.override !== undefined && !params.override.trim()) return yield* input("override must contain Joel's words");
    if (refusal && ((existing?.kind ?? params.kind) === "retro" || !params.override?.trim())) return yield* input(refusal);
    const base: Lane = existing ?? {
      slug,
      kind: params.kind ?? "work",
      label,
      goal,
      writeScope: [...(params.writeScope ?? [])],
      repo: params.repo ?? null,
      base: params.base ?? null,
      generated: [...(params.generated ?? [])],
      ...(params.rank !== undefined ? { rank: params.rank } : {}),
      tabId: null,
      root: null,
      state: "proposed",
      delivery: "none",
      archived: false,
      createdAt: iso(env),
      updatedAt: iso(env),
    };
    if (!wantOpen) {
      const { lane, note } = yield* mutate(dir, (current) => {
        const stored = current.lanes.find((candidate) => candidate.slug === slug);
        const latest = stored ?? base;
        const next = {
          ...latest,
          ...deployPatch,
          ...(rank !== undefined ? { rank } : {}),
          base: params.base ?? latest.base,
          goal: latest.state === "proposed" ? params.goal ?? latest.goal : latest.goal,
          label: latest.state === "proposed" ? params.label ?? latest.label : latest.label,
        };
        const changes: string[] = [];
        if (next.rank !== latest.rank) changes.push(`rank ${latest.rank ?? "unset"}→${next.rank}`);
        if (next.goal !== latest.goal) changes.push("goal updated");
        if (next.label !== latest.label) changes.push("label updated");
        if (next.base !== latest.base) changes.push("base updated");
        if (next.deployLevel !== latest.deployLevel) changes.push("deployLevel updated");
        if (next.deployRule !== latest.deployRule) changes.push("deployRule updated");
        // A pure re-rank preserves the brief timestamp; amendments share one locked write.
        const rankOnly = stored?.state === "proposed" && rank !== undefined && changes.every(change => change.startsWith("rank "));
        const lane = rankOnly ? next : { ...next, updatedAt: iso(env) };
        const note = lane.state === "proposed"
          ? `changed: ${stored ? changes.join(", ") || "none" : "created"}; stored goal: ${lane.goal.slice(0, 200)}`
          : null;
        return Effect.succeed([withLane(current, lane), { lane, note }] as const);
      });
      return { lane, created: !existing, note, outcome: project.outcome };
    }
    const event = base.state === "open" ? null : base.state === "proposed" ? ({ type: "OPEN" } as const) : ({ type: "REOPEN" } as const);
    // Reserve WIP under the catalog lock before opening any pane. Other callers see it immediately.
    yield* mutate(dir, current => Effect.gen(function* () {
      const latest = current.lanes.find(lane => lane.slug === slug) ?? base;
      if (params.kind === "retro" && latest.kind !== "retro") return yield* input(`lane ${slug} is kind ${latest.kind}, not retro; choose a fresh slug for the retro lane`);
      const refusal = wipRefusal(current, slug, latest.kind, env.now().getTime());
      if (refusal && (latest.kind === "retro" || !params.override?.trim())) return yield* input(refusal);
      const next: Lane = { ...latest, ...deployPatch, state: event ? yield* stepLane(slug, latest.state, event) : latest.state,
        ...(params.override ? { override: params.override.trim() } : {}), archived: false, updatedAt: iso(env) };
      return [withLane(current, next), next] as const;
    }));
    let tabId = base.tabId;
    let root = base.root;
    const liveRoot = root ? yield* locatePane(root) : null;
    let note: string | null = null;
    if (!liveRoot) {
      const tab = yield* tabCreate(project.spaceId as string, base.repo ?? project.dir, base.label).pipe(Effect.tapError(() =>
        mutate(dir, current => Effect.gen(function* () {
          const latest = yield* findLane(current, slug);
          const state = base.state === "open" ? latest.state : yield* stepLane(slug, latest.state, { type: "OPEN_FAILED", prior: base.state });
          return [withLane(current, { ...latest, state, updatedAt: iso(env) }), null] as const;
        }))));
      tabId = tab.tab.tab_id;
      root = { paneId: tab.root_pane.pane_id, terminalId: tab.root_pane.terminal_id, tabId, openedByMuster: true };
      if (base.root) note = `root pane was gone; opened tab ${tabId} pane ${root.paneId}`;
    } else if (root) {
      tabId = liveRoot.tab_id;
      root = { ...root, paneId: liveRoot.pane_id, tabId };
    }
    const lane = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        const latest = current.lanes.find((candidate) => candidate.slug === slug) ?? base;
        const state = latest.state;
        const next: Lane = {
          ...latest,
          label: params.label || latest.label,
          goal: params.goal || latest.goal,
          writeScope: params.writeScope ? [...params.writeScope] : latest.writeScope,
          generated: params.generated ? [...params.generated] : latest.generated,
          repo: params.repo ?? latest.repo,
          base: params.base ?? latest.base,
          tabId,
          root,
          state,
          ...(params.rank !== undefined ? { rank: params.rank } : {}),
          ...(event ? { openedAt: iso(env) } : {}),
          // A reopened lane is live work again; the weekly review archived it only because it was closed.
          archived: false,
          updatedAt: iso(env),
        };
        return [withLane(current, next), next] as const;
      }),
    );
    yield* publishTokens(yield* load(dir));
    return { lane, created: !existing, note, outcome: project.outcome };
  });

export const laneDeliver = (dir: string, params: { slug: string; stage: "deployed" | "proven" | "waived"; evidence: string }) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    if (!params.evidence.trim()) return yield* input("lane_deliver needs evidence in plain words");
    const lane = yield* mutate(dir, current => Effect.gen(function* () {
      yield* guardSideDesk(current, env.sessionId, "lane_deliver");
      const latest = yield* findLane(current, params.slug);
      const level = laneDeployLevel(latest, deployPosture(current).level);
      if (params.stage === "deployed") {
        if (level >= 2 && !/^rollback:[ \t]*\S.+$/im.test(params.evidence)) return yield* input(`deploy level ${level} needs a rollback line (Rollback: ...)`);
        if (level === 2 && !/^watch(?: signal)?:[ \t]*\S.+$/im.test(params.evidence)) return yield* input("deploy level 2 needs a watch signal (Watch: ...)");
        if (level === 0) {
          const items = readDesk(queuePath(current.slug, env.home));
          const cited = new Set(params.evidence.split(/[^a-zA-Z0-9_-]+/));
          const approved = items.some(item => item.kind === "approval" && cited.has(item.id) && items.some(resolution => resolution.resolves === item.id));
          if (!approved) return yield* input("deploy level 0 needs a cited resolved approval desk item");
        }
      }
      const stage = yield* stepDelivery(latest.slug, latest.delivery ?? "none", params.stage);
      const at = iso(env);
      const evidence = params.evidence.trim();
      const next: Lane = { ...latest, delivery: stage, deliveryAt: at, deliveryEvidence: evidence,
        deliveryHistory: [...(latest.deliveryHistory ?? []), { stage, at, evidence }], updatedAt: at };
      return [withLane(current, next), next] as const;
    }));
    yield* publishTokens(yield* load(dir));
    return lane;
  });

const laneCounts = (project: Project, slug: string) => ({
  liveAgents: project.agents.filter((agent) => agent.lane === slug && agent.state !== "closed"),
  openPackets: project.packets.filter((packet) => packet.lane === slug && !TERMINAL_PACKET_STATES.includes(packet.state)),
});

/** Close a pane only when it is still the terminal Muster opened. Never by name. */
const closeOwnedPane = (binding: PaneBinding | null, dir: string, reason: string) =>
  Effect.gen(function* () {
    if (!binding) return "no pane";
    if (!binding.openedByMuster) return `left ${binding.paneId} open: Muster did not open it`;
    const located = yield* locatePane(binding);
    if (!located) return `pane ${binding.paneId} already gone`;
    const env = yield* MusterEnv;
    const retired = yield* Effect.sync(() => env.emitPaneClose({
      paneId: located.pane_id, terminalId: binding.terminalId, reason,
    }));
    if (retired !== undefined) {
      for (const itemId of retired) relayEvent({ ts: iso(env), session: env.sessionId, kind: "watch_retired", project: dir, itemId }, env.home);
    }
    yield* paneClose(located.pane_id);
    const watches = retired === undefined
      ? watchFallback([binding.paneId, located.pane_id])
      : `watches retired: ${retired.length ? retired.join(", ") : "none"}`;
    return `closed ${located.pane_id}; ${watches}`;
  });

/** Pane ids change on moves; the terminal id does not. */
const locatePane = (binding: PaneBinding) =>
  Effect.gen(function* () {
    const direct = yield* paneGet(binding.paneId);
    if (direct && direct.terminal_id === binding.terminalId) return direct;
    const all = yield* paneList();
    return all.find((pane) => pane.terminal_id === binding.terminalId) ?? null;
  });

export const laneClose = (dir: string, slug: string, params: { discard?: boolean } = {}) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const project = yield* load(dir);
    const lane = yield* findLane(project, slug);
    const { liveAgents, openPackets } = laneCounts(project, slug);
    if (lane.state === "proposed" && !params.discard) return yield* input(`lane ${slug} was never opened; lane_open starts it (open: false keeps it parked). Pass discard: true to drop it from the backlog.`);
    if (liveAgents.length > 0 || openPackets.length > 0) {
      const drained =
        lane.state === "open"
          ? yield* mutate(dir, (current) =>
              Effect.gen(function* () {
                const latest = yield* findLane(current, slug);
                const next: Lane = { ...latest, state: yield* stepLane(slug, latest.state, { type: "DRAIN" }), updatedAt: iso(env) };
                return [withLane(current, next), next] as const;
              }),
            )
          : lane;
      const pendingResult: { lane: Lane; closed: false; pending: string[]; paneNote?: string; retro?: string } = {
        lane: drained,
        closed: false,
        pending: [
          ...liveAgents.map((agent) => `agent ${agent.name} is ${agent.state}`),
          ...openPackets.map((packet) => `packet ${packet.id.slice(0, 12)} is ${packet.state}`),
        ],
      };
      return pendingResult;
    }
    yield* stepLane(slug, lane.state, { type: "CLOSE", liveAgents: 0, openPackets: 0, discard: params.discard === true });
    const paneNote = lane.root ? yield* closeOwnedPane(lane.root, dir, `lane_close ${slug}`) : "no root pane";
    const closed = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        const latest = yield* findLane(current, slug);
        if (latest.state === "proposed" && !params.discard) return yield* input(`lane ${slug} was never opened; lane_open starts it (open: false keeps it parked). Pass discard: true to drop it from the backlog.`);
        const counts = laneCounts(current, slug);
        const state = yield* stepLane(slug, latest.state, {
          type: "CLOSE",
          liveAgents: counts.liveAgents.length,
          openPackets: counts.openPackets.length,
          discard: params.discard === true,
        });
        const next: Lane = { ...latest, state, root: null, discarded: latest.state === "proposed", closedAt: latest.closedAt ?? iso(env), updatedAt: iso(env) };
        return [withLane(current, next), next] as const;
      }),
    );
    yield* publishTokens(yield* load(dir));
    const latest = yield* load(dir);
    const cadence = retroCadence(latest, env.now().getTime());
    const judge = closed.kind === "work" && !closed.discarded && cadence.due
      ? yield* Effect.gen(function* () {
        const roster = (yield* loadRoster).roster;
        const choice = retroJudgeModel(roster);
        const profile = yield* decodeWith(() => roleDefaults(roster, latest.policy, "judge", choice.model, latest.slug), null);
        return `judge model: ${profile.model}:${profile.thinking}; ${choice.notes.length ? `${choice.notes.join("; ")}; ` : ""}`;
      }) : null;
    const retroBase = `retro-${iso(env).slice(0, 10)}`;
    const taken = new Set(latest.lanes.map(lane => lane.slug));
    let retroSlug = retroBase;
    for (let index = 2; taken.has(retroSlug); index++) {
      let suffix = "";
      for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) suffix = String.fromCharCode(97 + (n - 1) % 26) + suffix;
      retroSlug = `${retroBase}-${suffix}`;
    }
    return { lane: closed, closed: true, pending: [] as string[], paneNote,
      ...(judge ? { retro: `retro: ${cadence.count} lanes closed since the last retro${cadence.reason === "day" ? " (1d)" : ""}; ${judge}run project_review note: "retro evidence" for pending lanes' session, tail and report paths; run lane_open slug: "${retroSlug}" label: "🔁 retro" goal: "Review finished lanes" kind: "retro"; run references/retro.md` } : {}) };
  });

// ---------- agents ----------

export interface AgentLaunchInput {
  readonly action: LaunchKind | "adopt" | "restart";
  readonly machine?: string | undefined;
  readonly side?: boolean | undefined;
  readonly name: string;
  readonly role?: Role | undefined;
  readonly lane?: string | undefined;
  readonly label?: string | undefined;
  readonly cwd?: string | undefined;
  readonly clone?: boolean | undefined;
  readonly from?: string | undefined;
  readonly at?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: Thinking | undefined;
  readonly appendSystemPrompt?: readonly string[] | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly noSkills?: boolean | undefined;
  readonly extensions?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly compactAt?: number | null | undefined;
  readonly brief?: string | undefined;
  readonly prompt?: string | undefined;
  readonly pane?: string | undefined;
  readonly slot?: "root" | "split" | undefined;
}

/** Keep warm selection independent of side-desk fork topology. */
const warmForkSource = (dir: string, parent: AgentRow | null, at: string | undefined) =>
  at === undefined ? Effect.succeed(parent?.sessionFile ?? null) : Effect.try({
    try: () => {
      if (!parent?.sessionFile) throw new Error("at requires action fork and a parent session file");
      return forkSessionAt(parent.sessionFile, at, join(dataDir(dir), "forks"));
    },
    catch: error => input(String(error instanceof Error ? error.message : error)),
  });

const cloneFor = (source: string, name: string, lane: Lane, mode: Mode, script?: string) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const proc = yield* Proc;
    const workerWorktree = script ?? env.workerWorktree;
    const slug = name.replace(/_/g, "-");
    const notes: string[] = [];
    let requestedBase = lane.base;
    let localBase = false;
    if (requestedBase === null && mode === "rift-merge") {
      const branch = yield* proc.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: source });
      if (branch.code === 0 && branch.stdout.trim()) {
        requestedBase = branch.stdout.trim();
        localBase = true;
      } else if (branch.code === 1) {
        notes.push("source HEAD is detached; using worker-worktree.sh default base");
      } else {
        return yield* input(`cannot resolve source local branch in ${source}: ${branch.stderr.trim()}`);
      }
    }
    const out = yield* must(workerWorktree, ["create", source, slug, ...(requestedBase !== null ? ["--base", requestedBase] : [])], { cwd: source, timeoutMs: 300_000 });
    const path = /^worktree:\s+(.+)$/m.exec(out)?.[1]?.trim();
    const branch = /^branch:\s+(.+)$/m.exec(out)?.[1]?.trim();
    if (!path || !branch) return yield* input(`worker-worktree.sh create printed no worktree/branch:\n${out}`);
    const reported = /^base:[ \t]+(.+)[ \t]+([0-9a-f]{40}|[0-9a-f]{64})[ \t]*$/m.exec(out);
    if (!reported) return yield* input(`${workerWorktree} create printed no valid base: line; cannot prove clone base for lane ${lane.slug}. Update the script.`);
    const base = { ref: (reported[1] as string).trim(), sha: reported[2] as string };
    const head = (yield* git(path, "rev-parse", "HEAD")).trim();
    if (head !== base.sha) return yield* new GuardFailed({
      guard: "clone-base",
      message: `lane ${lane.slug} clone HEAD ${head} differs from base ${base.ref} ${base.sha}`,
    });
    notes.push(`base: ${base.ref} ${base.sha.slice(0, 7)} (${localBase ? "local, rift-merge" : lane.base !== null ? "explicit" : "script default"})`);
    if (localBase) {
      // create fetches origin first; compare its fresh default ref with the proven clone base.
      const origin = (yield* git(source, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").pipe(Effect.orElseSucceed(() => ""))).trim();
      if (origin) {
        const behind = (yield* git(source, "rev-list", "--count", `${base.sha}..${origin}`).pipe(Effect.orElseSucceed(() => ""))).trim();
        if (/^\d+$/.test(behind) && Number(behind) > 0) notes.push(`source ${base.ref} is ${behind} behind ${origin}`);
      }
    }
    return { path, branch, base, notes };
  });

/** Tail text is UNTRUSTED: it can buy time, never prove a session or prompt delivery. */
const piStarting = (tail: string) => tail.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).some(line =>
  /^(?:pi\s*[:·-]\s*)?creating a new session(?:\s|[.…]|$)/i.test(line.trim()) ||
  /^Warning: No project session found with id '[^'\r\n]+'; creating a new session with that id\.$/.test(line.trim()) ||
  /^pi v\d+\.\d+\.\d+(?:\s|$)/i.test(line.trim()));

/** Shared launch/restart wait: budget → evidenced extension → ready, missing or pending. */
const waitForSession = (paneId: string, previous: string | null, fallback: () => string | null = () => null) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const sample = env.startupLoad?.() ?? { load: loadavg()[0] ?? 0, cpus: availableParallelism() };
    const load = Number.isFinite(sample.load) ? Math.max(0, sample.load) : 0;
    const cpus = Number.isFinite(sample.cpus) ? Math.max(1, sample.cpus) : 1;
    const budget = Math.min(60_000, Math.max(10_000, 10_000 * Math.ceil(load / cpus)));
    const started = env.now().getTime();
    let slept = 0;
    let extended = false;
    let nextTail = budget;
    while (true) {
      const elapsed = Math.max(slept, env.now().getTime() - started);
      const pane = yield* paneGet(paneId);
      const value = pane?.agent_session?.kind === "path" ? pane.agent_session.value : null;
      const sessionFile = value && value !== previous ? value : fallback();
      if (sessionFile) return { state: "ready" as const, sessionFile, elapsed, load, slow: extended || elapsed > 10_000 };
      if (elapsed >= nextTail) {
        const tail = yield* paneRead(paneId, 12).pipe(Effect.orElseSucceed(() => "(pane unreadable)"));
        if (modelOutputIssue(tail)?.severity === "error" || !piStarting(tail)) {
          return { state: "missing" as const, tail, elapsed, load };
        }
        if (elapsed >= 120_000) return { state: "pending" as const, tail, elapsed, load };
        extended = true;
        nextTail = Math.min(120_000, elapsed + 1_000);
      }
      const pause = Math.min(250, nextTail - elapsed);
      yield* env.sleep(pause);
      slept += pause;
    }
  });

const slowStartNote = (wait: { elapsed: number; load: number }) =>
  `slow start: Pi session appeared after ${Math.ceil(wait.elapsed / 1_000)}s (load ${wait.load})`;
const pendingPromptNote = (paneId: string, text: string | undefined) =>
  `slow start, prompt pending: Pi still starting after 120 s in ${paneId}; delivery: none (pending). ` +
  (text ? `Run herdr_agent ${JSON.stringify({ action: "prompt", target: paneId, prompt: text })}` : "No work prompt supplied.");

const findSessionFile = (cwd: string, sessionId: string, home: string) => {
  const dir = sessionDirFor(cwd, home);
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir)
    .filter((file) => file.endsWith(`_${sessionId}.jsonl`))
    .sort()
    .pop();
  return hit ? join(dir, hit) : null;
};

/** Pane ids can change; either identity is enough to protect another row's binding. */
const sharesPane = (binding: PaneBinding, other: PaneBinding | null) =>
  other !== null && (other.paneId === binding.paneId || other.terminalId === binding.terminalId);

const blocksPane = (row: AgentRow) => !["failed", "interrupted", "closed"].includes(row.state);

const guardPaneBinding = (project: Project, row: AgentRow, binding: PaneBinding) => {
  const holder = project.agents.find((other) => other.machine === row.machine && other.name !== row.name && blocksPane(other) && sharesPane(binding, other.pane));
  return holder ? input(`pane ${binding.paneId} already bound to ${holder.name} (${holder.state}); choose another pane`) : Effect.void;
};

const pickPane = (project: Project, lane: Lane, row: AgentRow, params: AgentLaunchInput) =>
  Effect.gen(function* () {
    if (params.action === "fork" && row.side) {
      const parent = yield* findRow(project, row.side.parent);
      const root = parent.pane ? yield* locatePane(parent.pane) : null;
      if (!root || root.tab_id !== lane.tabId) return yield* input("side fork needs its desk parent's live pane in the lane tab");
      const pane = yield* paneSplit(root.pane_id, "right", row.cwd);
      return { paneId: pane.pane_id, terminalId: pane.terminal_id, tabId: pane.tab_id, openedByMuster: true } satisfies PaneBinding;
    }
    if (params.pane) {
      const pane = yield* paneGet(params.pane);
      if (!pane) return yield* input(`no pane ${params.pane}`);
      const binding = { paneId: pane.pane_id, terminalId: pane.terminal_id, tabId: pane.tab_id, openedByMuster: false } satisfies PaneBinding;
      yield* guardPaneBinding(project, row, binding);
      return binding;
    }
    if (row.pane) {
      const kept = yield* locatePane(row.pane);
      if (kept) return { ...row.pane, paneId: kept.pane_id, tabId: kept.tab_id } satisfies PaneBinding;
    }
    if (!lane.root) return yield* input(`lane ${lane.slug} has no tab; lane_open it first`);
    const root = yield* locatePane(lane.root);
    if (!root) return yield* input(`lane ${lane.slug}'s root pane is gone; lane_open it again`);
    const slot = params.slot ?? (row.role === "worker" ? "split" : "root");
    const rootInUse = project.agents.some((agent) => agent.name !== row.name && blocksPane(agent) && agent.pane && (agent.pane.paneId === root.pane_id || agent.pane.terminalId === root.terminal_id));
    if (slot === "root") {
      if (rootInUse) return yield* input(`lane ${lane.slug}'s root pane already runs an agent; use slot split`);
      return { paneId: root.pane_id, terminalId: root.terminal_id, tabId: root.tab_id, openedByMuster: true } satisfies PaneBinding;
    }
    const workers = project.agents.filter(
      (agent) => agent.lane === lane.slug && agent.name !== row.name && agent.state !== "closed" && agent.pane && agent.pane.terminalId !== root.terminal_id,
    );
    if (workers.length >= MAX_WORKERS_PER_TAB) {
      return yield* input(`lane ${lane.slug} already has ${MAX_WORKERS_PER_TAB} worker panes; Pi will not start in a narrower pane. Open an overflow lane.`);
    }
    const last = workers.at(-1)?.pane;
    const target = last ? yield* locatePane(last) : null;
    const pane = yield* paneSplit(target ? target.pane_id : root.pane_id, target ? "down" : "right", row.cwd);
    return { paneId: pane.pane_id, terminalId: pane.terminal_id, tabId: pane.tab_id, openedByMuster: true } satisfies PaneBinding;
  });

const sideDeskFence = (parent: string) =>
  `You are a side desk of ${parent}. Talk with Joel and evolve designs. Write briefs and decision notes, and hand them to the parent desk over intercom. A side desk never prompts or launches lanes or workers, never lands packets, and never acts on prod.`;

/** The default first prompt fits the role; a supplied side-desk prompt cannot omit its fence. */
export const workPrompt = (row: AgentRow, prompt: string | undefined) => {
  if (row.side) return [sideDeskFence(row.side.parent), prompt ?? (row.brief ? `Read your brief at ${row.brief}.` : "Say hello in one line, then wait for Joel.")].join("\n\n");
  if (prompt !== undefined) return prompt;
  if (!row.brief) return undefined;
  switch (row.role) {
    case "desk":
      return `Read your brief at ${row.brief}. You are this project's desk: Joel talks to you here. Say hello in one line, then wait for him.`;
    case "hawk":
    case "judge":
      return `Read your brief at ${row.brief} and take up the role it describes. Report only through the channels it names.`;
    default:
      return `Read your brief at ${row.brief} and do the work it describes. Skills aren't preloaded: call skill_find with your task's key words and read any skill that matches before you start. FYI, progress and done go through owner_note; a blocking question uses owner_note kind=question. Answer threaded questions with owner_reply. Intercom ask/reply is only for live back-and-forth. When your result is committed, call packet_report once with the commit and your checks.`;
  }
};

const guardSideDesk = (project: Project, sessionId: string, tool: string) =>
  Effect.gen(function* () {
    // An explicit project argument must not let a side desk escape its own catalog's fence.
    const ownDir = process.env.MUSTER_PROJECT;
    const own = ownDir && resolve(ownDir) !== resolve(project.dir) ? yield* load(ownDir) : project;
    const side = own.agents.find(row => row.sessionId === sessionId && row.side);
    if (side) return yield* new GuardFailed({ guard: "side-desk", message: `side desk ${side.name} cannot use ${tool}; discuss designs and hand briefs to ${side.side?.parent} over intercom` });
  });

const sideParent = (project: Project, from: string | undefined, sessionId: string) =>
  Effect.gen(function* () {
    const parent = yield* findRow(project, from ?? "");
    if (parent.role !== "desk" || parent.side || parent.state === "closed") return yield* input("side desks need a live, non-side desk parent");
    if (parent.sessionId !== sessionId && parent.owner !== sessionId) return yield* input("only the parent desk or the session that owns it can create or adopt a side desk");
    return parent;
  });

/** Catalog-only adoption: verify the moved pane, and release its former lane's root. */
const adoptSideDesk = (dir: string, project: Project, params: AgentLaunchInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    if (params.side !== true) return yield* input("adopt requires side: true and from: the parent desk");
    const parent = yield* sideParent(project, params.from, env.sessionId);
    const row = yield* findRow(project, params.name);
    yield* requireOwner(row, env.sessionId, false);
    if (row.name === parent.name || row.state !== "running" || !row.pane) return yield* input("adopt needs an existing running row with its own pane");
    const lane = yield* findLane(project, params.lane ?? parent.lane);
    if (lane.slug !== parent.lane || lane.state !== "open") return yield* input("adopt lane must be the parent desk's open lane");
    const pane = yield* locatePane(row.pane);
    const parentPane = parent.pane ? yield* locatePane(parent.pane) : null;
    if (!pane || !parentPane || pane.tab_id !== lane.tabId || parentPane.tab_id !== lane.tabId || pane.workspace_id !== project.spaceId || pane.agent !== "pi") return yield* input("adopt needs the running desk's live pane in its parent's lane tab");
    const liveSession = pane.agent_session?.kind === "path" ? sessionIdFromFile(pane.agent_session.value) : null;
    if (liveSession !== row.sessionId) return yield* input("adopt needs the catalog session to match the live pane's Pi session");
    const binding: PaneBinding = { ...row.pane, paneId: pane.pane_id, tabId: pane.tab_id };
    yield* guardPaneBinding(project, row, binding);
    const adopted = yield* mutate(dir, current => Effect.gen(function* () {
      const latest = yield* findRow(current, row.name);
      yield* requireOwner(latest, env.sessionId, false);
      if (latest.state !== "running" || latest.lane !== row.lane || !latest.pane || !sharesPane(binding, latest.pane)) return yield* input("row changed during adoption; retry");
      const latestParent = yield* sideParent(current, parent.name, env.sessionId);
      const latestLane = yield* findLane(current, lane.slug);
      if (latestParent.lane !== lane.slug || latestLane.state !== "open" || latestLane.tabId !== pane.tab_id || latest.sessionId !== row.sessionId) return yield* input("parent lane or session changed during adoption; retry");
      yield* guardPaneBinding(current, latest, binding);
      const next: AgentRow = { ...latest, role: "desk", lane: lane.slug, side: { parent: parent.name }, pane: binding, restore: latest.restore ? { ...latest.restore, env: { ...latest.restore.env, MUSTER_LANE: lane.slug, MUSTER_ROLE: "desk" } } : null, updatedAt: iso(env) };
      const updated = withRow(current, next);
      return [{ ...updated, lanes: updated.lanes.map(old => old.slug === row.lane && old.slug !== lane.slug && old.root && sharesPane(binding, old.root) ? { ...old, root: null, updatedAt: iso(env) } : old) }, next] as const;
    }));
    return { row: adopted, argv: [] as string[], readiness: "not checked (catalog adoption)", proof: null, sessionIdMatched: null, notes: ["adopted without touching the pane", `Parent desk: deliver this fence on the next conversation turn: ${sideDeskFence(parent.name)}`] };
  });

/** Called only at session_shutdown after the old caller's agent_end. */
export const finishRestart = (dir: string, restart: { oldPane: PaneBinding; replacementPane: PaneBinding; name: string }) => Effect.gen(function* () {
  yield* closeOwnedPane(restart.oldPane, dir, `self restart ${restart.name}`);
  yield* agentRename(restart.replacementPane.paneId, restart.name).pipe(Effect.catch(() => Effect.void));
});

/** Replacement is provisional until fresh fork evidence is proven. No catalog launch reservation
 * is needed: the per-name lock fences concurrent replacements while the old row stays live. */
const restartByFork = (dir: string, project: Project, old: AgentRow) => withMachineLaunchLock(`restart-${old.name.slice(0, 23)}`, Effect.gen(function* () {
  const env = yield* MusterEnv;
  const self = old.sessionId === env.sessionId;
  if (!self) yield* requireOwner(old, env.sessionId, false);
  if (!old.pane || !old.sessionFile) return yield* input("restart needs a live pane and current session file");
  const oldPane = old.pane;
  const state = yield* stepAgent(old.name, old.state, { type: "RESTARTED" });
  const pane = yield* locatePane(oldPane);
  if (!pane || pane.agent !== "pi" || pane.agent_session?.kind !== "path" || pane.agent_session.value !== old.sessionFile) return yield* input("restart refused: old pane does not prove the catalog session");
  const remote = old.machine !== "local";
  const machine = remote ? yield* machineConfig(old.machine) : null;
  const launchProject = machine ? { ...project, musterExtension: machine.musterExtension, deskExtension: project.deskExtension ? mapPath(project.deskExtension, machine) : null } : project;
  const selected = yield* sessionRestore(old.profile, old.sessionFile, project, old.role, (yield* loadRoster).roster, {}, remote);
  const notes = [...selected.notes];
  const modelNote = yield* checkRunnableModel(selected.profile.model, old.cwd, { tokens: selected.live.contextTokens });
  if (modelNote) notes.push(modelNote);
  const sha = (yield* git(machine?.musterExtension ?? env.musterRoot, "rev-parse", "HEAD")).trim();
  let row: AgentRow = { ...old, profile: selected.profile, sessionId: `${mintSessionId(old.name, env.now())}-${randomUUID().slice(0, 8)}`, sessionFile: null, parentSessionFile: old.sessionFile, pane: null };
  if (row.owner === old.sessionId) row = { ...row, owner: row.sessionId };
  const profile = extensionsFor(launchProject, row);
  const prompt = `You continue ${old.name} after a restart onto ${sha}. Re-read your brief${old.brief ? ` at ${old.brief}` : " (none recorded)"} and owner inbox before continuing. Do not mutate the catalog or launch work until your row points at your new session; the old owner is committing the handover.`;
  const inherited = yield* inheritedStartEntries(old.sessionFile);
  const argv = buildArgv({ kind: "fork", sessionId: row.sessionId, sessionFile: null, parentSessionFile: old.sessionFile, profile, musterExtension: launchProject.musterExtension, prompt });
  const environment: Record<string, string> = { ...agentEnv(project, row), ...(machine?.env ?? {}), ...(machine ? { MUSTER_MACHINE: old.machine, MUSTER_PROJECT_SLUG: project.slug, MUSTER_COMMS: "intercom", MUSTER_REMOTE_ROW: JSON.stringify(row) } : {}) };
  const bin = join(machine?.musterExtension ?? env.musterRoot, "bin");
  if (machine || environment.PATH !== undefined) environment.PATH = [bin, environment.PATH ?? (yield* must("printenv", ["PATH"], { cwd: old.cwd })).trim()].join(":");
  const launchDir = remote ? (yield* git(old.cwd, "rev-parse", "--path-format=absolute", "--git-path", "muster-launch")).trim() : join(env.home, ".pi/agent");
  const receipt = env.createId();
  const wrap = machine?.wrap.map(arg => arg.replaceAll("{name}", old.name)) ?? [];
  const script = yield* writeLaunchFile(launchDir, `#!/bin/sh\nset -e\n${shellPrelude(old.cwd, environment, environment.PATH === undefined ? bin : undefined)}${piReceiptSuffix(receipt)}\nexec ${[...wrap, "pi", ...argv].map(shellQuote).join(" ")}`);
  // A desk replacement is also a split in its own tab, never a fresh desk tab.
  // The root binding transfers with the row so closing the old root cannot strand the lane.
  let phase: "provisional" | "rebound" = "provisional";
  return yield* Effect.acquireUseRelease(
    paneSplit(pane.pane_id, "right", old.cwd),
    fresh => Effect.gen(function* () {
      const binding: PaneBinding = { paneId: fresh.pane_id, terminalId: fresh.terminal_id, tabId: fresh.tab_id, openedByMuster: true };
      yield* guardLaunchShell(binding.paneId);
      yield* paneRun(binding.paneId, `exec sh ${shellQuote(script)}`);
      const wait = yield* waitForSession(binding.paneId, null, remote ? undefined : () => findSessionFile(row.cwd, row.sessionId, env.home));
      if (wait.state !== "ready") return yield* input(`restart failed before rebind: replacement session ${wait.state}; old agent untouched`);
      const id = sessionIdFromFile(wait.sessionFile);
      if (!id || id === old.sessionId || wait.sessionFile === old.sessionFile) return yield* input("restart failed: replacement did not prove a new session");
      const proof = yield* proveStartedPrompt(wait.sessionFile, prompt, inherited);
      if (proof.state !== "proven") return yield* input(`restart failed before rebind: ${proof.detail}; old agent untouched`);
      row = { ...row, state, sessionId: id, sessionFile: wait.sessionFile, pane: binding, restarts: old.restarts + 1, delivery: "proven", updatedAt: iso(env),
        events: [...(old.events ?? []), { type: "RESTARTED", at: iso(env), detail: `${old.sessionId} -> ${id} onto ${sha}` }],
        restore: { cwd: old.cwd, argv: buildArgv({ kind: "restore", sessionId: id, sessionFile: wait.sessionFile, parentSessionFile: null, profile, musterExtension: launchProject.musterExtension }), env: environment } };
      const stillOld = yield* locatePane(oldPane);
      if (!stillOld || stillOld.agent_session?.kind !== "path" || stillOld.agent_session.value !== old.sessionFile) return yield* input("old Pi changed during restart; rebind refused");
      row = yield* mutate(dir, current => Effect.gen(function* () {
        const latest = yield* findRow(current, old.name);
        if (latest.sessionId !== old.sessionId || latest.sessionFile !== old.sessionFile || latest.owner !== old.owner || latest.state !== old.state || latest.pane?.terminalId !== oldPane.terminalId) return yield* input("row changed during restart; old agent untouched, retry");
        if (!self) yield* requireOwner(latest, env.sessionId, false);
        yield* guardPaneBinding(current, latest, binding);
        const next = withRow(current, row);
        const agents = next.agents.map(other => other.owner === old.sessionId ? { ...other, owner: id, restore: other.restore ? { ...other.restore, env: { ...other.restore.env, MUSTER_OWNER: id } } : null, updatedAt: iso(env) } : other);
        const lanes = next.lanes.map(lane => old.machine === "local" && sharesPane(oldPane, lane.root) ? { ...lane, root: binding, tabId: binding.tabId, updatedAt: iso(env) } : lane);
        return [{ ...next, agents, lanes }, yield* findRow({ ...next, agents }, row.name)] as const;
      })).pipe(Effect.catch(error => Effect.gen(function* () {
        // mutate can fail registering a project after its atomic catalog write.
        // In that case the replacement is already authoritative: never tear it down.
        const saved = yield* load(dir);
        const rebound = saved.agents.find(other => other.name === old.name && other.sessionId === id && other.pane?.terminalId === binding.terminalId);
        if (!rebound) return yield* error;
        notes.push(`catalog rebind committed; post-write bookkeeping failed: ${error.message}`);
        return rebound;
      })));
      phase = "rebound";
      // The catalog is authoritative. Never forward before its atomic write succeeds.
      yield* recordOwnerForward(old.sessionId, id, project.slug, env).pipe(Effect.catch(error => Effect.sync(() => { notes.push(`catalog rebound; scoped owner forward needs repair: ${error.message}`); })));
      if (self) notes.push("Replacement proven and rebound. End this turn now; the old session must quit after agent_end, not reload or restart in place.");
      else {
        if (!oldPane.openedByMuster) {
          const retiring = yield* locatePane(oldPane);
          if (retiring?.agent_session?.kind === "path" && retiring.agent_session.value === old.sessionFile) yield* paneRun(retiring.pane_id, "/quit").pipe(Effect.catch(error => Effect.sync(() => { notes.push(`old Pi quit failed: ${error.message}`); })));
        }
        notes.push(yield* closeOwnedPane(oldPane, dir, `restart ${old.name}`).pipe(Effect.catch(error => Effect.succeed(`old pane close failed: ${error.message}; close only ${oldPane.paneId}/${oldPane.terminalId}`))));
      }
      yield* agentRename(binding.paneId, old.name).pipe(Effect.catch(error => Effect.sync(() => { notes.push(`rename pending: ${error.message}`); })));
      yield* paneRename(binding.paneId, row.profile.label).pipe(Effect.catch(() => Effect.void));
      return { row, argv, readiness: "proven", proof, sessionIdMatched: argv.includes(id), notes, ...(self ? { endSession: { oldPane, replacementPane: binding, name: old.name } } : {}) };
    }),
    fresh => phase === "rebound" ? Effect.void : closeOwnedPane({ paneId: fresh.pane_id, terminalId: fresh.terminal_id, tabId: fresh.tab_id, openedByMuster: true }, dir, "failed restart replacement").pipe(Effect.catch(() => Effect.void)),
  );
}));

export const agentLaunch = (dir: string, params: AgentLaunchInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    if (params.at !== undefined && params.action !== "fork") return yield* input("at is only valid with action fork");
    const name = yield* decodeWith(decodeAgentName, params.name);
    const project = yield* load(dir);
    if (params.action !== "restart") yield* guardSideDesk(project, env.sessionId, "agent_launch");
    const previous = project.agents.find(row => row.name === (params.action === "fork" ? params.from : params.name));
    const machine = params.machine ?? previous?.machine ?? "local";
    if (previous && params.action !== "launch" && machine !== previous.machine) return yield* input("fork and restore reuse the row's machine; cross-machine session transfer is not supported");
    if (params.action === "restart") {
      const row = yield* findRow(project, name);
      const restart = restartByFork(dir, project, row);
      return machine === "local" ? yield* restart : yield* onRemote(machine, yield* machineConfig(machine), restart);
    }
    if (params.action === "adopt") {
      if (params.side) {
        if (machine !== "local") return yield* input("remote side-desk adoption is not supported");
        return yield* adoptSideDesk(dir, project, params);
      }
      const row = yield* findRow(project, name);
      yield* requireOwner(row, env.sessionId, false);
      if (!params.pane) return yield* input("adopt requires name and pane");
      if (row.state === "closed") return yield* input(`cannot adopt a ${row.state} row`);
      const adopt = Effect.gen(function* () {
        const bound = row.pane ? yield* locatePane(row.pane) : null;
        const rebinding = yield* findRebinding(project, row, bound);
        if (rebinding.kind === "refused") return yield* input(rebinding.note);
        if (rebinding.kind === "match") {
          if (rebinding.pane.pane_id !== params.pane) return yield* input(`adopt needs matching pane ${rebinding.pane.pane_id}`);
          const adopted = yield* readoptRow(dir, row, rebinding.pane, rebinding.session, !READOPT_STATES.includes(row.state));
          return { row: adopted, argv: [] as string[], readiness: "not checked (catalog adoption)", proof: null, sessionIdMatched: true, notes: [reboundNote(row, rebinding.pane), "adopted without touching the pane"] };
        }
        if (!["running", "launching", "failed", ...READOPT_STATES].includes(row.state)) return yield* input(`cannot adopt a ${row.state} row without exact session path evidence`);
        const pane = (yield* readoptionPanes(project, row)).find(pane => pane.pane_id === params.pane);
        if (!pane) return yield* input("adopt needs a pane in the project's workspace");
        const holder = adoptionHolder(project, row, pane);
        if (holder) return yield* input(`pane ${pane.pane_id} already bound to ${holder.name}`);
        const session = yield* adoptionSession(row, pane);
        if (!session) return yield* input("adopt refused: live Pi session does not match the row or its fork parent");
        const adopted = yield* readoptRow(dir, row, pane, session);
        return { row: adopted, argv: [] as string[], readiness: "not checked (catalog adoption)", proof: null, sessionIdMatched: true, notes: [`re-adopted ${pane.pane_id}`, "adopted without touching the pane"] };
      });
      return machine === "local" ? yield* adopt : yield* onRemote(machine, yield* machineConfig(machine), adopt);
    }
    if (machine !== "local") return yield* remoteLaunch(dir, project, { ...params, action: params.action }, machine);
    if (params.side && params.action !== "fork") return yield* input("side: true requires action: fork or adopt");
    const side = params.side ? yield* sideParent(project, params.from, env.sessionId) : null;
    const existing = project.agents.find((agent) => agent.name === name);

    const roster = (yield* loadRoster).roster;
    const skillNotes: string[] = [];
    let restoreTokens: number | null = null;
    let row: AgentRow;
    if (params.action === "restore") {
      if (!existing) return yield* new NotFound({ kind: "agent", id: name, message: `no row ${name} to restore` });
      const cwd = params.cwd ? yield* requireAbsolute("cwd", params.cwd) : existing.cwd;
      if (!existsSync(cwd)) {
        return yield* new GuardFailed({ guard: "cwd", message: `${cwd} is gone (a removed clone?). Pass cwd for a fresh clone, or fork from this row.` });
      }
      const sessionFile = existing.sessionFile ?? findSessionFile(existing.cwd, existing.sessionId, env.home);
      if (!sessionFile) return yield* new GuardFailed({ guard: "session", message: `row ${name} has no session file to restore; use launch` });
      const selected = yield* sessionRestore(profileFor(existing.role, existing.profile), sessionFile, project, existing.role, roster, params);
      const restoredProfile = selected.profile;
      skillNotes.push(...selected.notes);
      restoreTokens = selected.live.contextTokens;
      const restoredSkills = yield* Effect.try({
        try: () => resolveSkills({ skills: restoredProfile.skills, index: restoredProfile.skills.some(skill => !isAbsolute(skill)) ? skillIndex({ cwd }) : [] }),
        catch: error => input(`restore skills: ${String(error)}`),
      });
      skillNotes.push(...restoredSkills.notes);
      row = { ...existing, profile: { ...restoredProfile, skills: restoredSkills.paths }, cwd, sessionFile, owner: env.sessionId, state: yield* stepAgent(name, existing.state, { type: "RESTORE" }) };
    } else {
      const relaunchable = existing?.state === "planned" || existing?.state === "failed" || (existing?.state === "interrupted" && !existing.sessionFile);
      if (existing && !relaunchable) {
        return yield* input(`row ${name} is ${existing.state}; restore it, or pick a new name`);
      }
      const parent = params.action === "fork" ? yield* findRow(project, params.from ?? "") : null;
      if (params.action === "fork" && !parent?.sessionFile) return yield* input(`fork needs --from a row with a session file`);
      const parentSessionFile = yield* warmForkSource(dir, parent, params.at);
      const role = side ? "desk" : params.role ?? parent?.role ?? existing?.role;
      const laneSlug = side?.lane ?? params.lane ?? parent?.lane ?? existing?.lane;
      if (!role || !laneSlug) return yield* input("a new agent needs role and lane");
      const lane = yield* findLane(project, laneSlug);
      if (lane.state !== "open") return yield* new GuardFailed({ guard: "lane-open", message: `lane ${laneSlug} is ${lane.state}; new work goes only to an open lane` });
      const label = params.label ?? parent?.profile.label ?? existing?.profile.label;
      if (!label) return yield* input("a new agent needs a label, e.g. \"🔨 session store\"");
      let cwd = params.cwd ? yield* requireAbsolute("cwd", params.cwd) : (parent?.cwd ?? existing?.cwd ?? null);
      let clone: AgentRow["clone"] = existing?.clone ?? null;
      if (clone && existsSync(existing?.cwd ?? "")) {
        cwd = existing?.cwd ?? cwd;
      } else if (params.clone) {
        const source = lane.repo ?? project.dir;
        const allocated = yield* cloneFor(source, name, lane, project.mode);
        skillNotes.push(...allocated.notes);
        cwd = allocated.path;
        clone = { source, branch: allocated.branch, base: allocated.base };
      }
      if (!cwd) return yield* input("a new agent needs cwd or clone: true");
      if (!existsSync(cwd)) return yield* input(`cwd ${cwd} does not exist`);
      yield* guardDurable(project, "cwd", cwd);
      if (params.brief) {
        yield* requireAbsolute("brief", params.brief);
        yield* guardDurable(project, "brief", params.brief);
      }
      for (const prompt of params.appendSystemPrompt ?? []) yield* guardDurable(project, "append-system-prompt", prompt);
      const inherited: ProfileInput = parent
        ? { ...parent.profile, label }
        : { label };
      const retroChoice = retroJudgeModel(roster, { kind: lane.kind, role, model: params.model });
      skillNotes.push(...(retroChoice?.notes ?? []));
      const model = params.model ?? retroChoice?.model ?? parent?.profile.model;
      const requestedProfile: LaunchProfile = profileFor(role, {
        ...inherited,
        ...(retroChoice?.model ? { thinking: undefined } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
        ...(params.appendSystemPrompt !== undefined ? { appendSystemPrompt: params.appendSystemPrompt } : {}),
        ...(params.skills !== undefined ? { skills: params.skills } : {}),
        ...(params.noSkills !== undefined ? { noSkills: params.noSkills } : {}),
        ...(params.extensions !== undefined ? { extensions: params.extensions } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
        ...(params.compactAt !== undefined ? { compactAt: params.compactAt } : {}),
      }, yield* Effect.try({
        try: () => roleDefaults(roster, project.policy, role, model, project.slug),
        catch: (error) => input(String(error instanceof Error ? error.message : error)),
      }));
      const resolved = requestedProfile.skills.length > 0
        ? yield* Effect.try({
          try: () => resolveSkills({ skills: requestedProfile.skills, index: requestedProfile.skills.some(skill => !isAbsolute(skill)) ? skillIndex({ cwd }) : [] }),
          catch: (cause) => new InputError({ message: `skill discovery: ${String(cause)}` }),
        })
        : { paths: [], notes: [] };
      const profile: LaunchProfile = { ...requestedProfile, skills: resolved.paths };
      skillNotes.push(...resolved.notes);
      const now = iso(env);
      row = {
        machine: "local",
        name,
        role,
        side: side ? { parent: side.name } : null,
        lane: laneSlug,
        cwd,
        clone,
        profile,
        sessionId: existing?.sessionId ?? mintSessionId(name, env.now()),
        sessionFile: null,
        parentSessionFile,
        pane: existing?.pane ?? null,
        owner: env.sessionId,
        brief: params.brief ?? existing?.brief ?? null,
        state: yield* stepAgent(name, existing?.state ?? "planned", { type: "LAUNCH" }),
        delivery: "none",
        restarts: 0,
        restore: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
    }
    if (params.brief && params.action === "restore") row = { ...row, brief: params.brief };

    const resolvedModel = yield* Effect.try({
      try: () => resolveModel(params.model ?? row.profile.model, roster, project.slug, row.role),
      catch: (error) => input(String(error instanceof Error ? error.message : error)),
    });
    row = { ...row, profile: { ...row.profile, model: resolvedModel.model, thinking: params.thinking ?? resolvedModel.thinking ?? row.profile.thinking } };
    const modelNote = yield* checkRunnableModel(row.profile.model, row.cwd, params.action === "restore"
      ? { tokens: restoreTokens } : undefined);
    if (modelNote) skillNotes.push(modelNote);
    const kind: LaunchKind = params.action;
    const launchProfile = extensionsFor(project, row);
    const message = kind === "restore" && params.prompt === undefined && params.brief === undefined ? { expected: undefined } : yield* startPrompt(row, params.prompt, join(env.home, ".pi/agent"));
    const inheritedEntries = message.expected ? yield* inheritedStartEntries(kind === "fork" ? row.parentSessionFile : kind === "restore" ? row.sessionFile : existing?.cwd === row.cwd ? existing.sessionFile ?? findSessionFile(row.cwd, row.sessionId, env.home) : null) : 1;
    const network = project.policy?.comms === "network";
    const networkBrief = network && project.agents.some(agent => agent.sessionId === env.sessionId);
    if (network) {
      const helper = yield* Effect.promise(() => import("./comms-network.ts"));
      yield* helper.provisionNetworkAgent({ home: env.home, agent: row.name }).pipe(Effect.mapError(error => new InputError({ message: error.message })));
    }
    const argv = buildArgv({
      kind,
      sessionId: row.sessionId,
      sessionFile: row.sessionFile,
      parentSessionFile: row.parentSessionFile,
      profile: launchProfile,
      musterExtension: project.musterExtension,
      ...(networkBrief ? {} : message),
    });
    const agentEnvironment: Record<string, string> = { ...agentEnv(project, row), ...(network ? { MUSTER_COMMS: "network", MUSTER_NETWORK_PEERS: JSON.stringify(Object.fromEntries([...project.agents.filter(agent => agent.name !== row.name), row].map(agent => [agent.sessionId, agent.name]))) } : {}) };
    const musterBin = join(env.musterRoot, "bin");
    // A profile PATH is typed literally. Otherwise only the prepend is typed: a ~1 KB
    // owner PATH overflows the pane's input line and leaves the quote open.
    if (agentEnvironment.PATH !== undefined) {
      agentEnvironment.PATH = [musterBin, ...agentEnvironment.PATH.split(":").filter(path => path && path !== musterBin)].join(":");
    }
    const pathPrepend = agentEnvironment.PATH === undefined ? musterBin : undefined;
    const piReceiptId = env.createId();
    yield* mutate(dir, (current) => Effect.gen(function* () {
      const previous = current.agents.find(agent => agent.name === row.name);
      if (previous) yield* recordOwnerForward(previous.owner, row.owner, current.slug, env);
      return [withRow(current, row), row] as const;
    }));

    const lane = yield* findLane(project, row.lane);
    const failLaunch = () => patchRow(dir, row.name, row.state, [{ type: "LAUNCH_FAILED" }]).pipe(Effect.catch(() => Effect.void));
    const picked = yield* pickPane(project, lane, row, params).pipe(Effect.tapError(failLaunch));
    // Claim and release stale bindings together, before sending anything to the shell.
    const binding = yield* mutate(dir, (current) => Effect.gen(function* () {
      yield* guardPaneBinding(current, row, picked);
      const stale = current.agents.filter((other) => other.machine === row.machine && other.name !== row.name && sharesPane(picked, other.pane));
      const binding = { ...picked, openedByMuster: picked.openedByMuster || current.agents.some((other) => other.machine === row.machine && sharesPane(picked, other.pane) && other.pane?.openedByMuster) };
      const agents = current.agents.map((other) => other.name === row.name
        ? { ...other, pane: binding, updatedAt: iso(env) }
        : stale.includes(other) ? { ...other, pane: null, updatedAt: iso(env) } : other);
      return [{ ...current, agents }, binding] as const;
    })).pipe(Effect.tapError(failLaunch));
    const launched = yield* Effect.gen(function* () {
      yield* guardLaunchShell(binding.paneId);
      const script = yield* writeLaunchFile(join(env.home, ".pi/agent"), `#!/bin/sh\nset -e\n${shellPrelude(row.cwd, agentEnvironment, pathPrepend)}${piReceiptSuffix(piReceiptId)}\nexec ${["pi", ...argv].map(shellQuote).join(" ")}`);
      yield* paneRun(binding.paneId, `exec sh ${shellQuote(script)}`);
      if (networkBrief && message.expected) {
        const comms = yield* Comms;
        const sent = yield* comms.send(row.sessionId, message.expected);
        if (!["accepted", "queued", "delivered", "acked"].includes(sent.status)) return yield* input(`NetworkComms brief send refused for ${row.name}: ${sent.detail ?? sent.status}`);
      }
      const wait = yield* waitForSession(binding.paneId, null, () => findSessionFile(row.cwd, row.sessionId, env.home));
      const sessionFile = wait.state === "ready" ? wait.sessionFile : null;
      if (wait.state === "ready" && wait.slow) skillNotes.push(slowStartNote(wait));
      if (wait.state === "pending") skillNotes.push(`slow start: Pi still starting after 120 s in ${binding.paneId}; delivery: none (pending). The start argv already carries any work message; inspect the session before any explicit re-prompt.`);
      if (wait.state === "missing") {
        const tail = wait.tail;
        const issue = modelOutputIssue(tail);
        if (issue?.severity === "error") {
          yield* patchRow(dir, row.name, row.state, [{ type: "LAUNCH_FAILED" }], {
            delivery: "unproven", events: [...(row.events ?? []), { type: "MODEL_ERROR", at: iso(env), detail: issue.line }],
          });
          return yield* new GuardFailed({ guard: "model-proof", message: `pane ${binding.paneId}: delivery: unproven (model error: ${issue.line})` });
        }
        return yield* new GuardFailed({
          guard: "launch",
          message: `Herdr started ${row.name} but no Pi session appeared in ${binding.paneId}. Pane tail (UNTRUSTED):\n${tail.trim().slice(-1500)}`,
        });
      }
      let agent = null;
      if (wait.state === "ready") {
        const named = yield* agentRename(binding.paneId, row.name).pipe(Effect.result);
        if (named._tag === "Failure") skillNotes.push(`agent rename refused (${named.failure.code ?? "transport"}): ${named.failure.message}; leaving existing names unchanged.`);
        agent = yield* agentGet(binding.paneId).pipe(Effect.orElseSucceed(() => null));
      }
      yield* paneRename(binding.paneId, row.profile.label).pipe(Effect.catch(() => Effect.void));
      return { binding, agent, sessionFile, pending: wait.state === "pending" };
    }).pipe(Effect.tapError(failLaunch));

    const actualId = launched.sessionFile ? sessionIdFromFile(launched.sessionFile) : null;
    const liveRestore = yield* sessionRestore(launchProfile, launched.sessionFile, project, row.role, roster, params.action === "restore" ? params : {});
    const restore = {
      cwd: row.cwd,
      argv: buildArgv({
        kind: "restore",
        sessionId: actualId ?? row.sessionId,
        sessionFile: launched.sessionFile,
        parentSessionFile: null,
        profile: liveRestore.profile,
        musterExtension: project.musterExtension,
      }),
      env: agentEnvironment,
    };
    let running = yield* patchRow(dir, row.name, row.state, launched.pending ? [] : [{ type: "STARTED" }], {
      ...(launched.pending ? { delivery: "none" as const } : {}),
      pane: launched.binding,
      sessionFile: launched.sessionFile,
      sessionId: actualId ?? row.sessionId,
      restore,
    });

    const text = message.expected;
    let proof: Proof | null = null;
    if (text && !launched.pending) {
      proof = yield* proveStartedPrompt(launched.sessionFile!, text, inheritedEntries, "repairPrompt" in message ? message.repairPrompt : undefined);
      if (proof.state === "unproven") skillNotes.push(`delivery: unproven: ${proof.detail}. Read the pane before this single repair call; do not resend if already working: ${JSON.stringify({ tool: "herdr_agent", args: { action: "prompt", target: launched.binding.paneId, prompt: proof.repairPrompt ?? text } })}`);
      running = yield* patchRow(dir, row.name, "running", [], { delivery: proof.state === "proven" ? "proven" : "unproven", ...(proof.state === "unproven" ? { events: [...(running.events ?? []), { type: "FIRST_TURN", at: iso(env), detail: proof.detail }] } : {}) });
    }
    skillNotes.push(yield* readPiReceipt(agentEnvironment.HOME ?? env.home, piReceiptId));
    const tokens = yield* publishTokens(yield* load(dir));
    return {
      row: running,
      argv,
      readiness: launched.agent?.interactive_ready === true ? "proven" : "unknown",
      proof,
      ...(proof?.state === "unproven" ? { repair: { tool: "herdr_agent", args: { action: "prompt", target: launched.binding.paneId, prompt: proof.repairPrompt ?? text } } } : {}),
      sessionIdMatched: actualId === null ? null : actualId === row.sessionId,
      notes: [...skillNotes, tokens],
    };
  });

export interface AgentCloseInput {
  readonly name: string;
  readonly force?: boolean | undefined;
  readonly takeover?: boolean | undefined;
}

const requireOwner = (row: AgentRow, sessionId: string, takeover: boolean | undefined) =>
  row.owner === sessionId || takeover
    ? Effect.void
    : Effect.fail(
        new GuardFailed({
          guard: "owner",
          message: `${row.name} belongs to owner session ${row.owner}. Only its owner acts on its pane; pass takeover: true to adopt it.`,
        }),
      );

export const agentClose = (dir: string, params: AgentCloseInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const project = yield* load(dir);
    yield* guardSideDesk(project, env.sessionId, "agent_close");
    const row = yield* findRow(project, params.name);
    yield* requireOwner(row, env.sessionId, params.takeover);
    if (row.machine !== "local") return yield* remoteClose(dir, project, row, params);
    if (params.force && !forceCloseAllowed(project, row.name)) {
      return yield* new GuardFailed({ guard: "force-after-verify", message: `--force removes unharvested work; ${row.name} has no packet that passed packet_verify or was recorded as landed` });
    }
    const notes: string[] = [];
    const sessionFile = row.sessionFile ?? findSessionFile(row.cwd, row.sessionId, env.home);
    const selected = yield* sessionRestore(extensionsFor(project, row), sessionFile, project, row.role, (yield* loadRoster).roster);
    notes.push(...selected.notes);
    const profile = selected.profile;
    const restore = {
      cwd: row.cwd,
      argv: buildArgv({ kind: "restore", sessionId: row.sessionId, sessionFile, parentSessionFile: null, profile, musterExtension: project.musterExtension }),
      env: agentEnv(project, row),
    };
    if (row.state !== "closed") {
      yield* stepAgent(row.name, row.state, { type: "CLOSE" });
      if (row.pane) {
        const binding = row.pane;
        const holder = project.agents.find((other) => other.machine === row.machine && other.name !== row.name && other.state !== "closed" && sharesPane(binding, other.pane));
        const located = holder ? null : yield* locatePane(row.pane).pipe(Effect.catch(error => {
          notes.push(`pane lookup failed: ${error.message}`);
          return Effect.succeed(null);
        }));
        if (holder) {
          notes.push(`pane ${row.pane.paneId} kept: ${holder.name} is bound to it`);
        } else if (located) {
          const tail = yield* paneRead(located.pane_id, CLOSE_READ_LINES).pipe(Effect.catch(() => Effect.succeed("")));
          const saved = join(closedDir(dir), `${row.name}-${env.now().getTime()}.txt`);
          mkdirSync(dirname(saved), { recursive: true });
          writeFileSync(saved, tail);
          notes.push(`last ${CLOSE_READ_LINES} lines saved to ${saved}`);
          notes.push(yield* closeOwnedPane(row.pane, dir, `agent_close ${row.name}`));
        } else {
          notes.push(`pane ${row.pane.paneId} already gone`);
        }
      }
    }
    // Pane I/O can overlap landing or another close. Transition the locked,
    // current row, not the snapshot read before closing the pane.
    const closed = yield* mutate(dir, (current) => Effect.gen(function* () {
      const latest = yield* findRow(current, row.name);
      yield* requireOwner(latest, env.sessionId, params.takeover);
      if (latest.state === "closed") return [current, latest] as const;
      if (latest.sessionId !== row.sessionId || latest.cwd !== row.cwd || latest.pane?.terminalId !== row.pane?.terminalId) {
        return yield* new GuardFailed({ guard: "close-binding", message: `${row.name} changed session or pane during close; re-read its row before closing the replacement` });
      }
      const next: AgentRow = { ...latest, state: yield* stepAgent(latest.name, latest.state, { type: "CLOSE" }), pane: null, sessionFile, restore, updatedAt: iso(env) };
      return [withRow(current, next), next] as const;
    }));

    let cloneError: string | null = null;
    const kept = row.clone && existsSync(row.cwd) ? yield* cloneRetirementNotes(row) : { keep: false, notes: [] };
    notes.push(...kept.notes);
    if (row.clone && existsSync(row.cwd) && !kept.keep) {
      const args = params.force ? ["remove", "--force", row.cwd] : ["remove", row.cwd];
      const removal = yield* must(env.workerWorktree, args, { cwd: row.clone.source, timeoutMs: 120_000 }).pipe(
        Effect.match({
          onFailure: (error: ProcError) => ({ removed: false as const, text: error.message }),
          onSuccess: (out) => ({ removed: true as const, text: out.trim() }),
        }),
      );
      if (removal.removed) notes.push(removal.text);
      else cloneError = removal.text;
    }
    notes.push(yield* publishTokens(yield* load(dir)));
    return { row: closed, restore, cloneError, notes };
  });

// ---------- packets ----------

export interface PacketReportInput {
  readonly dir: string;
  readonly agent: string;
  readonly owner: string;
  readonly cwd: string;
  readonly commit?: string | undefined;
  readonly artifact?: string | undefined;
  readonly summary: string;
  readonly checks: readonly CheckOutcome[];
  readonly deploy?: string | undefined;
  readonly proof?: string | undefined;
  readonly signals?: { working: string; failing: string; where: string } | undefined;
  readonly body?: string | undefined;
}

// A longer delimiter prevents worker-written backticks from closing our code.
const reportFence = (text: string): string => "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length)) + 1);
const reportText = (text: string): string => `${reportFence(text)}\n${text}\n${reportFence(text)}`;
// GFM code spans leave entities literal and normalize newlines. Inline HTML code
// decodes entities instead: encode pipes before table splitting, braces before
// Svelte compilation, and Markdown punctuation before inline parsing. <br />
// keeps a multiline check in one source row while rendering its line breaks.
const reportCell = (text: string): string => {
  const cell = text.replace(/[&<>{}|`\\*_\[\]~\r]/g, (char) => `&#${char.charCodeAt(0)};`).replace(/\n/g, "<br />");
  return `<code>${cell}</code>`;
};

export function reportMarkdown(row: AgentRow, packet: Pick<Packet, "id" | "kind" | "artifact" | "checks">, summary: string, body: string | undefined, delivery: Pick<PacketReportInput, "deploy" | "proof" | "signals"> = {}): string {
  const title = `Packet ${packet.id.slice(0, 12)} from ${row.name}`;
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    `packet: ${JSON.stringify(packet.id)}`,
    `lane: ${JSON.stringify(row.lane)}`,
    "---",
    "",
    `# Packet ${packet.id.slice(0, 12)} from ${reportCell(row.name)}`,
    "",
    `- Lane: ${reportCell(row.lane)}`,
    `- Kind: ${packet.kind}`,
    `- Id: ${reportCell(packet.id)}${packet.kind === "artifact" ? ` (sha256 of ${reportCell(packet.artifact ?? "")})` : ` (commit on ${reportCell(row.clone?.branch ?? "the clone's branch")} in ${reportCell(row.cwd)})`}`,
    "",
    "## Summary",
    "",
    reportText(summary),
    "",
    "## Checks",
    "",
    "| Check | Outcome | Detail |",
    "| --- | --- | --- |",
    ...packet.checks.map((check) => `| ${reportCell(check.name)} | ${reportCell(check.outcome)} | ${reportCell(check.detail ?? "")} |`),
    "",
    ...(delivery.deploy ? ["## Deploy", "", reportText(delivery.deploy), ""] : []),
    ...(delivery.proof ? ["## Live proof", "", reportText(delivery.proof), ""] : []),
    ...(delivery.signals ? ["## Signals", "", `- Working: ${reportCell(delivery.signals.working)}`, `- Failing: ${reportCell(delivery.signals.failing)}`, `- Where: ${reportCell(delivery.signals.where)}`, ""] : []),
    ...(body?.trim() ? ["## Notes", "", reportText(body), ""] : []),
  ].join("\n");
}

export const packetReport = (params: PacketReportInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const intercom = yield* Comms;
    const proc = yield* Proc;
    if (!params.commit === !params.artifact) return yield* input("packet_report needs exactly one of commit or artifact");
    if (process.env.MUSTER_MACHINE && process.env.MUSTER_MACHINE !== "local") return yield* remoteReport(params);
    const project = yield* load(params.dir);
    const row = yield* findRow(project, params.agent);
    let id: string;
    let artifact: string | null = null;
    if (params.commit) {
      id = (yield* git(params.cwd, "rev-parse", "--verify", `${params.commit}^{commit}`)).trim();
    } else {
      artifact = yield* requireAbsolute("artifact", params.artifact as string);
      if (!existsSync(artifact)) return yield* input(`artifact ${artifact} does not exist`);
      id = sha256File(artifact);
    }
    const earlier = [...project.packets].reverse().find((candidate) =>
      candidate.agent === row.name && !TERMINAL_PACKET_STATES.includes(candidate.state));
    if (!project.packets.some((packet) => packet.id === id) && earlier) {
      const ancestor = !!params.commit && earlier.kind === "commit" &&
        (yield* proc.run("git", ["merge-base", "--is-ancestor", earlier.id, id], { cwd: params.cwd })).code === 0;
      if (!ancestor) return yield* input(`earlier packet ${earlier.id.slice(0, 12)} needs an outcome first; land or reject it before reporting a non-ancestor follow-up; the owner can record it \`rejected\` or \`no_changes\` with evidence; verification is not needed for those`);
    }
    const report = join(reportsDir(params.dir), row.lane, `${row.name}-${id.slice(0, 12)}.svx`);
    const now = iso(env);
    const draft = { id, kind: params.commit ? ("commit" as const) : ("artifact" as const), artifact, checks: [...params.checks] };
    const saved = yield* mutate(params.dir, (current) =>
      Effect.gen(function* () {
        const latest = yield* findRow(current, params.agent);
        const prior = current.packets.find((packet) => packet.id === id);
        if (prior && TERMINAL_PACKET_STATES.includes(prior.state)) {
          return yield* input(`packet ${id.slice(0, 12)} is already ${prior.state}; commit a new change for rework`);
        }
        let supersedes = prior?.supersedes ?? null;
        if (!prior) {
          const pending = [...current.packets].reverse().find((candidate) =>
            candidate.agent === latest.name && !TERMINAL_PACKET_STATES.includes(candidate.state));
          if (pending?.id !== earlier?.id) return yield* input("earlier packet changed during reporting; retry packet_report");
          supersedes = pending?.id ?? null;
        }
        const packet: Packet = {
          ...draft,
          supersedes,
          lane: latest.lane,
          agent: latest.name,
          report,
          state: "reported",
          verification: null,
          landedAs: null,
          gate: null,
          reportedAt: prior?.reportedAt ?? now,
          updatedAt: now,
        };
        const reportingAgain = latest.state === "reported" || latest.state === "verified" || latest.state === "landed";
        const livePane = reportingAgain && latest.pane ? yield* locatePane(latest.pane) : null;
        if (reportingAgain && !livePane?.agent) {
          return yield* new GuardFailed({
            guard: "pane-live",
            message: `${latest.name} is ${latest.state}; reporting again needs its bound pane ${latest.pane?.paneId ?? "(none)"} to host a live agent, and Herdr reports none. Run project_status to rebind a moved pane, or restore the agent.`,
          });
        }
        const state = yield* stepAgent(latest.name, latest.state, { type: "REPORT", paneLive: !!livePane?.agent });
        const next: AgentRow = { ...latest, state, updatedAt: now };
        mkdirSync(dirname(report), { recursive: true });
        writeFileSync(report, reportMarkdown(latest, draft, params.summary, params.body, params));
        return [withPacket(withRow(current, next), packet), { packet, owner: latest.owner }] as const;
      }),
    );
    const message = `🐑 packet ${id.slice(0, 12)} from ${row.name} (${row.lane}): ${(params.summary.trim().split("\n")[0] ?? "").slice(0, 200).replace(/[.\s]+$/, "")}. Report: ${report}`;
    relayEvent({ ts: iso(env), session: env.sessionId, kind: "packet_report", project: project.slug, packetId: id }, env.home);
    const notice = yield* deliverOwnerItem({ owner: saved.owner, home: env.home, session: env.sessionId, project: project.slug,
      item: { author: env.sessionId, lane: row.lane, kind: "action", title: `Packet ${id.slice(0, 12)} from ${row.name}: ${params.summary.trim().split("\n")[0] ?? ""}`, refs: [report], body: message },
      comms: intercom, send: intercom.send, message });
    return { packet: saved.packet, delivery: notice.delivery, notice };
  });

export const packetVerify = (dir: string, id: string) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    let project = yield* load(dir);
    let ingestNotes: string[] = [];
    if (!project.packets.some(packet => packet.id === id || (id.length >= 7 && packet.id.startsWith(id)))) {
      ingestNotes = (yield* ingestRemotePackets(dir)).notes;
      project = yield* load(dir);
    }
    const packet = yield* findPacket(project, id).pipe(Effect.mapError(error => error._tag === "NotFound" && ingestNotes.length
      ? new NotFound({ ...error, message: `${error.message}; ${ingestNotes.join("; ")}` }) : error));
    const row = yield* findRow(project, packet.agent);
    const lane = project.lanes.find((candidate) => candidate.slug === packet.lane);
    const { checks, branch } = row.machine === "local" ? yield* verifyPacket(project, lane, row, packet) : yield* verifyRemotePacket(project, lane, row, packet);
    const failed = failures(checks);
    if (failed.length > 0) {
      const artifactChanged = packet.kind === "artifact" && failed.some(check => check.name === "artifact hash" && check.detail?.startsWith("sha256 is "));
      const recovery = artifactChanged ? "; the file changed after packet_report: record this packet `rejected` with evidence, then have the worker packet_report the current file" : "";
      return yield* new PacketCheckFailed({
        packet: packet.id,
        failures: failed.map((check) => `${check.name}: ${check.detail ?? "failed"}`),
        message: `packet ${packet.id.slice(0, 12)} failed ${failed.length} check(s)${recovery}`,
      });
    }
    const verified = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        const latest = yield* findPacket(current, packet.id);
        if (TERMINAL_PACKET_STATES.includes(latest.state)) return yield* input(`packet ${packet.id.slice(0, 12)} is already ${latest.state}`);
        const agent = yield* findRow(current, packet.agent);
        if (branch && agent.clone && (agent.cwd !== row.cwd || agent.clone.branch !== row.clone?.branch)) {
          return yield* input(`agent ${agent.name} clone changed during verification; retry packet_verify`);
        }
        if (branch && agent.clone) checks.push({ name: "clone branch", outcome: "pass", detail: `updated to ${branch} (was ${agent.clone.branch})` });
        const next: Packet = { ...latest, state: "verified", verification: { at: iso(env), checks }, updatedAt: iso(env) };
        const state = agent.state === "reported" ? yield* stepAgent(agent.name, agent.state, { type: "VERIFY" }) : agent.state;
        const withAgent = withRow(current, {
          ...agent, state,
          clone: branch && agent.clone ? { ...agent.clone, branch } : agent.clone,
          updatedAt: iso(env),
        });
        return [withPacket(withAgent, next), next] as const;
      }),
    );
    return { packet: verified, checks, note: branch && row.clone ? `updated clone.branch to ${branch} (was ${row.clone.branch})` : null };
  });

export type LandOutcome = "committed" | "rejected" | "no_changes";

export interface PacketLandInput {
  readonly id: string;
  readonly outcome: LandOutcome;
  readonly gate?: string | undefined;
  readonly landedAs?: string | undefined;
  readonly attested?: boolean | undefined;
  readonly evidence?: string | undefined;
  readonly message?: string | undefined;
}

/** Resolve at call time: installing the runner needs no extension restart. `MUSTER_FLEET_COMPUTE=off` turns it off. */
const fleetRunner = (source: string) => Effect.gen(function* () {
  const proc = yield* Proc;
  const configured = process.env.MUSTER_FLEET_COMPUTE;
  if (configured === "off") return null;
  const explicit = configured && isAbsolute(configured) && existsSync(configured) ? configured : null;
  const onPath = explicit ? null : (yield* proc.run("sh", ["-c", "command -v fleet-compute"], { cwd: source, timeoutMs: 10_000 })).stdout.trim();
  return explicit ? { command: "node", prefix: [explicit] } : onPath ? { command: onPath, prefix: [] } : null;
});

const fleetStatus = (source: string, runner: { command: string; prefix: string[] }) => Effect.gen(function* () {
  const proc = yield* Proc;
  const result = yield* proc.run(runner.command, [...runner.prefix, "status", "--json"], { cwd: source, timeoutMs: 10_000 });
  if (result.code !== 0) return yield* input(`fleet-compute status exited ${result.code}`);
  return yield* Effect.try({
    try: () => Schema.decodeUnknownSync(FleetStatus)(JSON.parse(result.stdout)),
    catch: (error) => input(`fleet-compute status invalid JSON/schema: ${String(error)}`),
  });
});

const runGate = (source: string, gate: string, context: {
  readonly project: Project;
  readonly tree: string;
  readonly head: string;
  readonly branch: string;
  readonly receiptPath: string;
  readonly savedReceipt: string;
}) =>
  Effect.gen(function* () {
    const { project, tree, head, branch, receiptPath, savedReceipt } = context;
    const env = yield* MusterEnv;
    const proc = yield* Proc;
    const runner = yield* fleetRunner(source);
    if (runner) {
      const result = yield* proc.run(runner.command, [
        ...runner.prefix, "gate", "--project", project.slug,
        "--repo", basename(source), "--source", source, "--tree", tree,
        "--head", head, "--branch", branch, "--wait", "1200", "--receipt", receiptPath,
        "--", "sh", "-c", gate,
      ], { cwd: source, timeoutMs: GATE_TIMEOUT_MS }).pipe(
        Effect.mapError((error) => new GuardFailed({ guard: "gate-runner", message: error.message })),
      );
      if (!existsSync(receiptPath)) {
        if (result.code === 75) {
          const queue = yield* fleetStatus(source, runner).pipe(
            Effect.map((status) => busyQueue(status, project.slug, basename(source), env.now().getTime())),
            Effect.catch(() => Effect.succeed(null)),
          );
          return yield* new HeavyJobBusy({ holder: "fleet-compute", message: `fleet-compute gate admission busy (wait 1200 expired)${queue ? `; ${queue}` : ""}` });
        }
        return yield* new GuardFailed({ guard: "gate-runner", message: `gate runner exited ${result.code} without a receipt:\n${(result.stdout + result.stderr).trim().slice(-1500)}` });
      }
      // Keep failure and lost-run receipts too, not just successful landings.
      yield* Effect.try({
        try: () => copyFileSync(receiptPath, savedReceipt),
        catch: (error) => new GuardFailed({ guard: "gate-runner", message: `cannot save gate receipt: ${String(error)}` }),
      });
      const receipt = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(GateReceipt)(JSON.parse(readFileSync(receiptPath, "utf8"))),
        catch: (error) => new GuardFailed({ guard: "gate-runner", message: `invalid gate receipt: ${String(error)}` }),
      });
      if (receipt.tree !== tree) return yield* new GuardFailed({ guard: "gate-tree", message: `gate receipt tree ${receipt.tree} differs from merged tree ${tree}` });
      if (receipt.exit === null) return yield* new GuardFailed({ guard: "gate-runner", message: `gate run lost: ${receipt.lostReason ?? "unknown reason"}` });
      return { ...result, code: receipt.exit, receipt };
    }
    const held = tryAcquireHeavy({ home: env.home }, `muster gate: ${gate}`);
    if (!held.ok) {
      return yield* new HeavyJobBusy({ holder: held.reason, message: `heavy gate admission busy: ${held.reason}` });
    }
    const result = yield* proc.run("sh", ["-c", gate], { cwd: source, timeoutMs: GATE_TIMEOUT_MS }).pipe(Effect.ensuring(Effect.sync(held.release)));
    return { ...result, receipt: null };
  });

const riftMerge = (project: Project, lane: Lane | undefined, row: AgentRow, packet: Packet, params: PacketLandInput) =>
  Effect.gen(function* () {
    const proc = yield* Proc;
    if (!row.clone) return yield* input(`${row.name} has no clone branch; rift-merge lands only clone work`);
    const source = sourceOf(project, lane, row);
    const gitDir = (yield* git(source, "rev-parse", "--absolute-git-dir")).trim();
    if (existsSync(join(gitDir, "MERGE_HEAD"))) return yield* new GuardFailed({ guard: "merge", message: `source ${source} already has a merge in progress; leave it to its owner` });
    const dirtyOutput = yield* git(source, "status", "--porcelain=v1", "-z", "--untracked-files=no");
    // Both ends of a rename are dirty: a merge must not overwrite either.
    const dirtyFields = dirtyOutput.split("\0");
    const dirty = parsePorcelainZ(dirtyOutput);
    for (let i = 0; i < dirtyFields.length; i++) {
      if (/^[RC]|^.[RC]/.test(dirtyFields[i] ?? "")) dirty.push(dirtyFields[++i] ?? "");
    }
    const branch = row.clone.branch;
    if (row.machine !== "local") {
      const machine = yield* machineConfig(row.machine);
      yield* must("git", ["fetch", "-q", cloneUrl(machine, row.cwd), `${branch}:${branch}`], { cwd: source, timeoutMs: 120_000, env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2" } }).pipe(Effect.mapError(error => new ProcError({ ...error, message: `machine ${row.machine}: harvest failed: ${error.message}` })));
    } else if (existsSync(row.cwd)) yield* git(source, "fetch", "-q", row.cwd, `${branch}:${branch}`);
    const onBranch = (yield* proc.run("git", ["merge-base", "--is-ancestor", packet.id, branch], { cwd: source })).code === 0;
    if (!onBranch) return yield* new GuardFailed({ guard: "harvest", message: `${packet.id.slice(0, 12)} is not on ${branch} in ${source}` });
    const merged = (yield* proc.run("git", ["merge-base", "--is-ancestor", packet.id, "HEAD"], { cwd: source })).code === 0;
    if (merged) return { landedAs: (yield* git(source, "rev-parse", "HEAD")).trim(), note: "already on HEAD; nothing merged", gate: null };
    const base = (yield* git(source, "merge-base", "HEAD", branch)).trim();
    const incoming = (yield* git(source, "diff", "--name-only", "--no-renames", "-z", base, branch)).split("\0").filter(Boolean);
    const overlaps = dirty.filter((path) => !path.startsWith(".brain/data/muster/") && incoming.some((changed) =>
      path === changed || path.startsWith(`${changed}/`) || changed.startsWith(`${path}/`)));
    if (overlaps.length) return yield* new GuardFailed({ guard: "clean-source", message: `dirty tracked paths overlap the merge: ${overlaps.join(", ")}` });

    // A private index starts at HEAD, so unrelated user staging cannot enter
    // the merge commit. The real index is updated only for paths we brought in.
    const scratch = mkdtempSync(join(gitDir, "muster-land-"));
    const indexEnv = { GIT_INDEX_FILE: join(scratch, "index") };
    const isolatedGit = (...args: string[]) => must("git", args, { cwd: source, env: indexEnv });
    const abort = () => proc.run("git", ["merge", "--abort"], { cwd: source, env: indexEnv });
    // `merge --abort` refuses outright when the gate touched a merged file, leaving
    // MERGE_HEAD and every merged path. The clean-source guard proved each incoming
    // path matched HEAD before the merge, so restoring those paths loses no owner work.
    const incomingSet = new Set(incoming);
    const dirtyBefore = new Set(dirty);
    const leftovers = () => Effect.gen(function* () {
      const left = parsePorcelainZ(yield* git(source, "status", "--porcelain=v1", "-z")).filter(path => incomingSet.has(path) && !dirtyBefore.has(path));
      return { left, mergeHead: existsSync(join(gitDir, "MERGE_HEAD")) };
    });
    const abortVerified = (tree: string) => Effect.gen(function* () {
      yield* isolatedGit("read-tree", tree).pipe(Effect.ignore);
      yield* proc.run("git", ["update-index", "-q", "--refresh"], { cwd: source, env: indexEnv });
      const aborted = yield* abort();
      let state = yield* leftovers();
      if (state.left.length || state.mergeHead) {
        yield* proc.run("git", ["merge", "--quit"], { cwd: source, env: indexEnv });
        const inHead = new Set((yield* git(source, "--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...state.left)).split("\0").filter(Boolean));
        const restore = state.left.filter(path => inHead.has(path));
        if (restore.length) yield* proc.run("git", ["--literal-pathspecs", "checkout", "HEAD", "--", ...restore], { cwd: source, env: indexEnv });
        for (const path of state.left.filter(path => !inHead.has(path))) rmSync(join(source, path), { force: true });
        state = yield* leftovers();
      }
      if (!state.left.length && !state.mergeHead) return "merge aborted; source clean";
      const why = (aborted.stderr || aborted.stdout).trim().slice(-400);
      return `merge NOT fully aborted: ${state.mergeHead ? "MERGE_HEAD is still present; " : ""}${state.left.length} merged path(s) remain in ${source}: ${state.left.slice(0, 20).join(", ")}${state.left.length > 20 ? ", …" : ""}${why ? ` (merge --abort: ${why})` : ""}. Clean it before landing again`;
    });
    return yield* Effect.gen(function* () {
      yield* isolatedGit("read-tree", "HEAD");
      const merge = yield* proc.run("git", ["-c", "user.name=shitratgit[bot]", "-c", "user.email=286405550+shitratgit[bot]@users.noreply.github.com", "merge", "--no-ff", "--no-commit", branch], { cwd: source, env: indexEnv });
      if (merge.code !== 0) {
        yield* abort();
        return yield* new GuardFailed({ guard: "merge", message: `merge of ${branch} failed and was aborted: ${(merge.stderr || merge.stdout).trim().slice(-800)}` });
      }
      let receipt: GateReceipt | null = null;
      const receiptPath = join(scratch, "gate-receipt.json");
      const savedReceipt = `${packet.report}.gate-receipt.json`;
      if (params.gate) {
        const tree = (yield* isolatedGit("write-tree")).trim();
        const head = (yield* git(source, "rev-parse", "HEAD")).trim();
        const gate = yield* runGate(source, params.gate, { project, tree, head, branch, receiptPath, savedReceipt }).pipe(Effect.tapError(() => abortVerified(tree)));
        receipt = gate.receipt;
        if (gate.code !== 0) {
          const outcome = yield* abortVerified(tree);
          return yield* new GuardFailed({ guard: "gate", message: `gate failed (exit ${gate.code}); ${outcome}:\n${(gate.stdout + gate.stderr).trim().slice(-1500)}` });
        }
      }
      const message = params.message ?? `muster: land ${row.lane}/${row.name} ${packet.id.slice(0, 12)}`;
      let gateEvidence: PacketGate | null = null;
      if (receipt) {
        gateEvidence = { runId: receipt.runId, host: receipt.host, tree: receipt.tree, slot: receipt.slot, durationMs: receipt.durationMs, receipt: savedReceipt };
        const currentTree = (yield* isolatedGit("write-tree").pipe(Effect.tapError(abort))).trim();
        if (currentTree !== receipt.tree) {
          // Restore the merge index so abort can remove incoming worktree paths
          // even when the gate rewrote the private index to HEAD.
          yield* isolatedGit("read-tree", receipt.tree).pipe(Effect.tapError(abort));
          yield* isolatedGit("update-index", "--refresh").pipe(Effect.tapError(abort));
          yield* abort();
          return yield* new GuardFailed({ guard: "gate-tree", message: `private index tree ${currentTree} differs from gated tree ${receipt.tree}; merge aborted before commit` });
        }
      }
      yield* must("git", ["commit", "--no-edit", "-m", message], {
        cwd: source,
        env: { ...indexEnv, GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL, GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL },
      }).pipe(Effect.tapError(abort));
      if (receipt) {
        const committedTree = (yield* git(source, "rev-parse", "HEAD^{tree}")).trim();
        if (committedTree !== receipt.tree) return yield* new GuardFailed({ guard: "gate-tree", message: `committed HEAD tree ${committedTree} differs from gated tree ${receipt.tree}; commit left intact for owner (receipt: ${gateEvidence?.receipt})` });
      }
      if (incoming.length) yield* git(source, "--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--", ...incoming);
      return { landedAs: (yield* git(source, "rev-parse", "HEAD")).trim(), gate: gateEvidence, note: `merged ${branch} --no-ff as shitratgit[bot]; not pushed${receipt ? `; gate ran on ${receipt.host} at tree ${receipt.tree.slice(0, 12)} (run ${receipt.runId})` : ""}` };
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(scratch, { recursive: true }))));
  });

/** One terminal outcome per packet, including packets landed with a follow-up. */
const recordPacketOutcome = (project: Project, packet: Packet, outcome: LandOutcome, landedAs: string | null, evidence: string | undefined, now: string) =>
  Effect.gen(function* () {
    if (TERMINAL_PACKET_STATES.includes(packet.state)) return yield* input(`packet ${packet.id.slice(0, 12)} is already ${packet.state}`);
    const next: Packet = { ...packet, state: outcome, landedAs, ...(evidence ? { evidence } : {}), updatedAt: now };
    let delivered = project;
    if (outcome === "committed") {
      const lane = yield* findLane(project, packet.lane);
      // A new committed packet starts a new delivery cycle, even on a previously proven lane.
      const stage = yield* stepDelivery(lane.slug, "none", "landed");
      const detail = evidence ?? `committed packet ${packet.id}`;
      delivered = withLane(project, { ...lane, delivery: stage, deliveryAt: now, deliveryEvidence: detail,
        deliveryHistory: [...(lane.deliveryHistory ?? []), { stage, at: now, evidence: detail }], updatedAt: now });
    }
    return { project: withPacket(delivered, next), packet: next };
  });

export const packetLand = (dir: string, params: PacketLandInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const proc = yield* Proc;
    const project = yield* load(dir);
    yield* guardSideDesk(project, env.sessionId, "packet_land");
    const packet = yield* findPacket(project, params.id);
    if (TERMINAL_PACKET_STATES.includes(packet.state)) return yield* input(`packet ${packet.id.slice(0, 12)} is already ${packet.state}`);
    const row = yield* findRow(project, packet.agent);
    const lane = project.lanes.find((candidate) => candidate.slug === packet.lane);

    let landedAs: string | null = null;
    let note = "";
    let gate: PacketGate | null = null;
    const recording = packet.kind === "artifact" || (!row.clone && !params.landedAs);
    let evidence = params.evidence?.trim();
    if (params.attested && params.outcome !== "committed") return yield* input("attested is only supported for committed packets");
    if (recording && !evidence && !params.attested) return yield* input(`packet ${packet.id.slice(0, 12)} has no clone branch to merge; pass evidence (what you checked and where) to record its outcome`);
    if (params.outcome === "committed" && params.attested) {
      const targetRef = params.landedAs;
      if (!targetRef || !evidence) return yield* input("attested landing requires landedAs and non-empty evidence");
      const source = sourceOf(project, lane, row);
      const resolve = () => proc.run("git", ["rev-parse", "--verify", "--end-of-options", `${targetRef}^{commit}`], { cwd: source });
      let target = yield* resolve();
      if (target.code !== 0) {
        yield* proc.run("git", ["fetch", "-q", "--", "origin", targetRef], { cwd: source });
        target = yield* resolve();
      }
      if (target.code !== 0) return yield* new GuardFailed({ guard: "landed-as", message: `unknown landedAs commit ${params.landedAs} in ${source} (fetch from origin did not resolve it)` });
      landedAs = target.stdout.trim();
      const symbolic = yield* proc.run("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: source });
      const base = lane?.base?.replace(/^(?:(?:refs\/remotes\/)?origin\/|refs\/heads\/)/, "") ??
        (symbolic.code === 0 ? symbolic.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : "main");
      if (/^[a-f0-9]{40,64}$/.test(base) || (yield* proc.run("git", ["check-ref-format", `refs/heads/${base}`], { cwd: source })).code !== 0) return yield* input(`attested landing requires a base branch, not ${base}`);
      const hasOrigin = (yield* proc.run("git", ["remote", "get-url", "origin"], { cwd: source })).code === 0;
      if (hasOrigin) {
        const fetched = yield* proc.run("git", ["fetch", "--no-tags", "--", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], { cwd: source });
        if (fetched.code !== 0) return yield* new GuardFailed({ guard: "landed-as", message: `fetch origin/${base} failed; cannot attest against stale base refs` });
      }
      const baseRef = hasOrigin ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
      if ((yield* proc.run("git", ["merge-base", "--is-ancestor", landedAs, baseRef], { cwd: source })).code !== 0) return yield* new GuardFailed({ guard: "landed-as", message: `${landedAs} is not on base ${hasOrigin ? "origin/" : ""}${base}` });
      evidence = `owner-attested: landed inside ${landedAs}; ${evidence}`;
      note = "recorded an owner-attested landing";
    } else if (params.outcome === "committed") {
      if (packet.kind === "commit" && !params.landedAs) {
        const cloneExists = row.machine === "local" ? existsSync(row.cwd) && statSync(row.cwd).isDirectory() : yield* Effect.gen(function* () {
          const machine = yield* machineConfig(row.machine);
          return (yield* sshProc(row.machine, machine, proc, env.home).run("test", ["-d", row.cwd], { cwd: "/", timeoutMs: 30_000 })).code === 0;
        });
        if (!cloneExists) return yield* input(`clone gone; pass landedAs with the landing commit for ${packet.id.slice(0, 12)} (clone ${row.cwd})`);
      }
      if (packet.state !== "verified") return yield* new GuardFailed({ guard: "verified", message: `run packet_verify on ${packet.id.slice(0, 12)} before landing it` });
      if (recording) {
        note = "recorded without a merge";
      } else if (project.mode === "rift-merge" && !params.landedAs) {
        ({ landedAs, note, gate } = yield* riftMerge(project, lane, row, packet, params));
      } else {
        if (!params.landedAs) return yield* input(`mode ${project.mode} lands outside Muster; pass landedAs with the merge commit`);
        const source = sourceOf(project, lane, row);
        let contains = (yield* proc.run("git", ["merge-base", "--is-ancestor", packet.id, params.landedAs], { cwd: source })).code === 0;
        if (!contains) {
          const resolve = () => proc.run("git", ["rev-parse", "--verify", "--end-of-options", `${params.landedAs}^{commit}`], { cwd: source });
          let target = yield* resolve();
          if (target.code !== 0) {
            yield* proc.run("git", ["fetch", "-q", "--", "origin", params.landedAs], { cwd: source });
            target = yield* resolve();
          }
          if (target.code !== 0) return yield* new GuardFailed({ guard: "landed-as", message: `unknown landedAs commit ${params.landedAs} in ${source} (fetch from origin did not resolve it)` });
          landedAs = target.stdout.trim();
          if ((yield* proc.run("git", ["cat-file", "-e", `${packet.id}^{commit}`], { cwd: source })).code !== 0 && row.clone && existsSync(row.cwd)) {
            yield* git(source, "fetch", "-q", "--", row.cwd, packet.id);
          }
          contains = (yield* proc.run("git", ["merge-base", "--is-ancestor", packet.id, landedAs], { cwd: source })).code === 0;
          if (!contains) {
            const parent = yield* proc.run("git", ["rev-parse", "--verify", `${landedAs}^`], { cwd: source });
            if (parent.code !== 0) return yield* new GuardFailed({ guard: "landed-as", message: `${landedAs} has no parent for squash comparison` });
            const base = yield* proc.run("git", ["merge-base", packet.id, parent.stdout.trim()], { cwd: source });
            if (base.code !== 0) return yield* new GuardFailed({ guard: "landed-as", message: `${landedAs} shares no merge base with packet ${packet.id.slice(0, 12)} in ${source}` });
            const patchId = (from: string, to: string) => must("bash", ["-c", 'set -o pipefail; git diff --no-ext-diff --no-textconv --binary "$1" "$2" -- | git patch-id --stable', "muster-squash", from, to], { cwd: source });
            const packetPatch = (yield* patchId(base.stdout.trim(), packet.id)).trim().split(/\s+/)[0];
            const landingPatch = (yield* patchId(parent.stdout.trim(), landedAs)).trim().split(/\s+/)[0];
            if (packetPatch && packetPatch === landingPatch) {
              note = "recorded a squash landing (patch-id match)";
            } else {
              const paths = (yield* git(source, "diff", "--name-only", "--no-renames", "-z", base.stdout.trim(), packet.id, "--")).split("\0").filter(Boolean);
              // Literal pathspecs include both ends of renames and missing blobs (deletions).
              const differing = paths.length ? (yield* git(source, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", packet.id, landedAs, "--", ...paths)).split("\0").filter(Boolean) : [];
              if (differing.length) return yield* new GuardFailed({ guard: "landed-as", message: `${landedAs} does not match packet ${packet.id.slice(0, 12)}; differing paths: ${differing.slice(0, 20).map((path) => JSON.stringify(path)).join(", ")}${differing.length > 20 ? ` (and ${differing.length - 20} more)` : ""}` });
              note = "recorded a squash landing (paths identical at landedAs)";
            }
          }
        }
        landedAs ??= params.landedAs;
        if (contains) note = "recorded an external landing";
        else evidence = [evidence, note].filter(Boolean).join("\n");
      }
    }
    const event: AgentEvent | null = params.outcome === "rejected" ? { type: "REWORK" } : { type: "LAND" };
    const saved = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        const latest = yield* findPacket(current, packet.id);
        const recorded = yield* recordPacketOutcome(current, { ...latest, gate: gate ?? latest.gate, ...(params.attested ? { attested: true } : {}) }, params.outcome, landedAs, gate ? [evidence, note].filter(Boolean).join("\n") : evidence, iso(env));
        const agent = yield* findRow(current, packet.agent);
        const moves = agent.state === "reported" || agent.state === "verified" || (agent.state === "landed" && event.type === "REWORK");
        let updated = moves ? withRow(recorded.project, { ...agent, state: yield* stepAgent(agent.name, agent.state, event), updatedAt: iso(env) }) : recorded.project;
        if (params.attested && !moves) note += `; agent ${agent.name} left in ${agent.state} (no LAND transition)`;
        if (params.outcome === "committed") {
          let supersedes = latest.supersedes;
          const seen = new Set([latest.id]);
          while (supersedes) {
            if (seen.has(supersedes)) return yield* input("packet supersedes chain contains a cycle");
            seen.add(supersedes);
            const earlier = yield* findPacket(updated, supersedes);
            if (!TERMINAL_PACKET_STATES.includes(earlier.state)) {
              updated = (yield* recordPacketOutcome(updated, { ...earlier, ...(params.attested ? { attested: true } : {}) }, "committed", landedAs, params.attested ? `${evidence}; landed with ${latest.id}` : `landed with ${latest.id}`, iso(env))).project;
            }
            supersedes = earlier.supersedes;
          }
        }
        return [updated, recorded.packet] as const;
      }),
    );
    const tokens = yield* publishTokens(yield* load(dir));
    return { packet: saved, note, notes: [tokens] };
  });

// ---------- desk ----------

export interface DeskPostInput {
  readonly kind: DeskKind;
  readonly title: string;
  readonly body?: string | undefined;
  readonly refs?: readonly string[] | undefined;
  readonly resolves?: string | undefined;
  readonly from?: string | undefined;
}

export const deskPost = (dir: string, params: DeskPostInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const project = yield* load(dir);
    const path = queuePath(project.slug, env.home);
    const record = yield* Effect.try({
      try: () => deskRecord({ ...params, from: params.from ?? `🐑 ${project.slug} owner` }, env.createId().slice(0, 8), env.now()),
      catch: (error) => input(String(error instanceof Error ? error.message : error)),
    });
    if (record.resolves && !readDesk(path).some((item) => item.id === record.resolves)) {
      return yield* input(`no desk item ${record.resolves} to resolve`);
    }
    appendDesk(path, record);
    yield* nudgeSwitchboards(project.slug, record);
    const open = openDeskItems(readDesk(path));
    const tokens = yield* publishTokens(project);
    return { record, open: open.length, path, notes: [tokens] };
  });

// ---------- project_status ----------

/**
 * A space label is the project's name. Status written into it churns the
 * sidebar and hides the tokens, so in a space Muster owns the pass puts the
 * name back; the status belongs in `project_update` headline.
 */
const keepSpaceLabel = (project: Project, act: boolean) =>
  Effect.gen(function* () {
    if (project.sidebar !== "owned" || !project.spaceId || project.state === "archived") return null;
    const spaces = yield* workspaceList().pipe(Effect.catch(() => Effect.succeed([])));
    const space = spaces.find((candidate) => candidate.workspace_id === project.spaceId);
    if (!space || space.label === project.label) return null;
    if (!act) return `space label drifted to "${space.label}"; the name is "${project.label}" (act: false)`;
    return yield* workspaceRename(project.spaceId, project.label).pipe(
      Effect.as(`space label "${space.label}" put back to "${project.label}"; say status with project_update headline`),
      Effect.catch((error) => Effect.succeed(`space label drifted; rename failed: ${error.message}`)),
    );
  });

export interface AgentLine {
  readonly name: string;
  readonly role: Role;
  readonly lane: string;
  readonly state: AgentRow["state"];
  readonly pane: string | null;
  readonly silentMin: number | null;
  readonly cache: "warm" | "cold" | null;
  readonly cost: SessionCost | null;
  readonly intercom: "reachable" | "unreachable" | "unknown";
  /** The live session id; address intercom by this, never by the catalog name. */
  readonly sessionId?: string;
  readonly action: string | null;
  readonly identity?: string;
  readonly capability?: string;
  readonly recovery?: string;
}

export interface StatusInput {
  readonly act?: boolean | undefined;
  /** Explicit handover: adopt all non-closed rows without restarting their panes. */
  readonly takeover?: boolean | undefined;
}

export const projectStatus = (dir: string, params: StatusInput = {}) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const intercom = yield* Comms;
    const act = params.act !== false;
    const ingestion = act ? yield* ingestRemotePackets(dir) : { notes: [] as string[], failedMachines: new Set<string>() };
    if (act || params.takeover) yield* guardSideDesk(yield* load(dir), env.sessionId, "project_status act/takeover");
    const project = params.takeover
      ? yield* mutate(dir, (current) => Effect.gen(function* () {
          for (const row of current.agents) if (row.state !== "closed") yield* recordOwnerForward(row.owner, env.sessionId, current.slug, env);
          const next = { ...current, agents: current.agents.map((row) =>
            row.state === "closed" ? row : { ...row, owner: env.sessionId, updatedAt: iso(env) }) };
          return [next, next] as const;
        }))
      : yield* load(dir);
    const spaces = yield* workspaceList();
    const missingSpace = project.spaceId && !spaces.some(space => space.workspace_id === project.spaceId)
      ? `project ${project.slug}: workspace ${project.spaceId} is missing; space not rebuilt` : null;
    const recoveryNotes: string[] = missingSpace ? [missingSpace] : [];
    const panes = yield* paneList();
    const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
    const byTerminal = new Map(panes.map((pane) => [pane.terminal_id, pane]));
    if (!missingSpace) for (const lane of project.lanes) {
      const root = lane.root;
      if (!root || lane.state === "closed" || !project.agents.some(row => row.lane === lane.slug && row.owner === env.sessionId && row.state !== "closed")) continue;
      const pane = byId.get(root.paneId);
      if (!pane || pane.workspace_id !== project.spaceId || pane.tab_id !== lane.tabId || pane.terminal_id === root.terminalId) continue;
      // A reused pane id with an unrelated shell is not evidence of a restored root.
      if (pane.agent !== "pi" || pane.agent_session?.kind !== "path" || !project.agents.some(row =>
        row.lane === lane.slug && row.owner === env.sessionId && row.state !== "closed" && row.sessionFile === pane.agent_session?.value)) continue;
      const note = `rebound lane ${lane.slug} root → ${pane.pane_id} (same pane and tab; close authority released)`;
      recoveryNotes.push(`${note}${act ? "" : " (preview; act: false)"}`);
      if (act) yield* mutate(dir, current => Effect.gen(function* () {
        const latest = yield* findLane(current, lane.slug);
        if (!current.agents.some(row => row.lane === lane.slug && row.owner === env.sessionId && row.state !== "closed")) return yield* input("lane ownership changed during reconciliation; retry");
        if (latest.root?.terminalId !== root.terminalId || latest.root.paneId !== root.paneId || latest.tabId !== lane.tabId) return yield* input("lane root changed during reconciliation; retry");
        const next = { ...latest, root: { ...root, terminalId: pane.terminal_id, openedByMuster: false }, updatedAt: iso(env) };
        return [withLane(current, next), undefined] as const;
      }));
    }
    const live = yield* intercom.sessions();
    const now = env.now().getTime();
    const limits = silenceLimits(project.policy);
    const lines: AgentLine[] = [];
    let endSession: Parameters<typeof finishRestart>[1] | undefined;
    let stuck = 0;

    const remoteTimes = yield* remoteSessionTimes(project, ingestion.failedMachines, ingestion.notes);
    for (const row of project.agents) {
      if (row.state === "closed") continue;
      if (row.machine !== "local") {
        const unavailable: AgentLine = { name: row.name, role: row.role, lane: row.lane, state: row.state, pane: row.pane?.paneId ?? null, silentMin: null, cache: null, cost: null, intercom: "unknown", action: `machine ${row.machine}: remote status unavailable; row unchanged` };
        lines.push(ingestion.failedMachines.has(row.machine) ? unavailable : yield* remoteStatusRow(dir, project, row, act, remoteTimes).pipe(Effect.catch(error => Effect.sync(() => {
          ingestion.failedMachines.add(row.machine);
          ingestion.notes.push(`machine ${row.machine}: status skipped for ${row.name}: ${error.message}`);
          return unavailable;
        }))));
        continue;
      }
      if (missingSpace) {
        lines.push({ name: row.name, role: row.role, lane: row.lane, state: row.state, pane: row.pane?.paneId ?? null, silentMin: null, cache: null, cost: null, intercom: "unknown", action: null });
        continue;
      }
      let pane: PaneInfo | undefined;
      if (row.pane) {
        const direct = byId.get(row.pane.paneId);
        pane = direct && direct.terminal_id === row.pane.terminalId ? direct : byTerminal.get(row.pane.terminalId);
      }
      let action: string | null = null;
      let current = row;
      const idleLive = pane && pane.agent_status !== "working" && ["running", "silent", "nudged", "restarted"].includes(row.state);
      const issue = idleLive && pane ? modelOutputIssue(yield* paneRead(pane.pane_id, 20).pipe(Effect.orElseSucceed(() => ""))) : null;
      const modelError = issue?.severity === "error" ? issue.line : undefined;
      // A failed model launch requires an explicit restore, not automatic adoption.
      const failedModel = row.state === "failed" && row.events?.some((event) => event.type === "MODEL_ERROR");
      const rebinding = row.owner === env.sessionId ? yield* findRebinding(project, row, pane) : { kind: "none" } as const;
      const reAdoption = rebinding.kind === "none" && act && row.owner === env.sessionId && READOPT_STATES.includes(row.state) ? yield* findReadoption(project, row) : undefined;
      const adoptionCandidate = rebinding.kind !== "none" || reAdoption !== undefined || row.state === "interrupted" || (!failedModel && (row.state === "failed" || row.state === "launching"));
      if (rebinding.kind === "match") {
        if (act) current = yield* readoptRow(dir, row, rebinding.pane, rebinding.session, !READOPT_STATES.includes(row.state));
        pane = rebinding.pane;
        action = `${reboundNote(row, pane)}${act ? "" : " (preview; act: false)"}`;
      } else if (rebinding.kind === "refused") {
        action = rebinding.note;
      } else if (reAdoption) {
        current = yield* readoptRow(dir, row, reAdoption.pane, reAdoption.session);
        pane = reAdoption.pane;
        action = `re-adopted ${pane.pane_id}`;
      } else if (modelError) {
        action = `FAILED (model error: ${modelError})`;
        if (act && row.owner === env.sessionId) {
          current = yield* patchRow(dir, row.name, row.state, [{ type: "FAIL" }], {
            delivery: "unproven", events: [...(row.events ?? []), { type: "MODEL_ERROR", at: iso(env), detail: modelError }],
          });
        }
      } else if (adoptionCandidate && !READOPT_STATES.includes(row.state)) {
        // Never learn identity from an unrelated session: that would make it
        // match on the next pass. Read the bound terminal before adopting it.
        const mine = row.owner === env.sessionId;
        if (row.pane && mine) {
          pane = (yield* locatePane(row.pane)) ?? undefined;
          const sessionFile = pane?.agent_session?.kind === "path" ? pane.agent_session.value : null;
          const matches = sessionFile !== null && (row.sessionFile !== null
            ? sessionFile === row.sessionFile
            : sessionFile.endsWith(`_${row.sessionId}.jsonl`));
          if (pane?.agent === "pi" && matches && sessionFile) {
            if (act) {
              const sessionId = sessionIdFromFile(sessionFile) ?? row.sessionId;
              const selected = yield* sessionRestore(extensionsFor(project, row), sessionFile, project, row.role, (yield* loadRoster).roster);
              const restore = {
                cwd: row.cwd,
                argv: buildArgv({ kind: "restore", sessionId, sessionFile, parentSessionFile: null, profile: selected.profile, musterExtension: project.musterExtension }),
                env: agentEnv(project, row),
              };
              current = yield* patchRow(dir, row.name, row.state, [{ type: "ADOPT" }], {
                pane: { ...row.pane, paneId: pane.pane_id, tabId: pane.tab_id },
                sessionFile,
                sessionId,
                restore,
              });
              action = "adopted (live pi session matches)";
            } else {
              action = "adoptable (live pi session matches; act: false)";
            }
          }
        }
      } else if (act && row.owner === env.sessionId && row.pane && !pane) {
        if (PROCESS_STATES.includes(row.state)) {
          current = yield* patchRow(dir, row.name, row.state, [{ type: "PANE_GONE" }], { pane: null }).pipe(Effect.catch(() => Effect.succeed(row)));
          action = "pane gone: interrupted";
        } else {
          current = yield* patchRow(dir, row.name, row.state, [], { pane: null }).pipe(Effect.catch(() => Effect.succeed(row)));
        }
      } else if (act && row.owner === env.sessionId && pane && !pane.agent && PROCESS_STATES.includes(row.state) && row.state !== "restoring") {
        current = yield* patchRow(dir, row.name, row.state, [{ type: "PANE_GONE" }], { pane: { ...(row.pane as PaneBinding), paneId: pane.pane_id } }).pipe(
          Effect.catch(() => Effect.succeed(row)),
        );
        action = "agent exited to its shell: interrupted";
      } else if (act && row.owner === env.sessionId && row.pane && pane && pane.pane_id !== row.pane.paneId) {
        current = yield* patchRow(dir, row.name, row.state, [], { pane: { ...row.pane, paneId: pane.pane_id, tabId: pane.tab_id } }).pipe(
          Effect.catch(() => Effect.succeed(row)),
        );
        action = `rebound moved pane to ${pane.pane_id}`;
      }
      if (rebinding.kind === "none" && !reAdoption && !modelError && issue?.severity === "warning") action = `model warning: ${issue.line}`;
      const herdrFile = pane?.agent_session?.kind === "path" ? pane.agent_session.value : null;
      if (act && row.owner === env.sessionId && !adoptionCandidate && herdrFile && herdrFile !== current.sessionFile) {
        current = yield* patchRow(dir, row.name, current.state, [], {
          sessionFile: herdrFile,
          sessionId: sessionIdFromFile(herdrFile) ?? current.sessionId,
        }).pipe(Effect.catch(() => Effect.succeed(current)));
      }
      const file = current.sessionFile;
      const mtime = file ? sessionMtimeMs(file) : null;
      const silentFor = mtime === null ? null : now - mtime;
      let cost = file && existsSync(file) ? yield* Effect.promise(() => readSessionCost(file, CAPTURE_REFRESH_MARK)) : null;
      // Adoption only records evidence; do not nudge, restart, or refresh the
      // live agent in the same pass, even if its session file looks stale.
      const working = !modelError && !adoptionCandidate && ["running", "silent", "nudged", "restarted"].includes(current.state);

      // A bridge lane whose wake failed prompt capture stays dead until someone
      // types to it: timer and intercom wakes skip the hook that records a prompt.
      const capture = pane && working ? (cost?.captureStuck ?? null) : null;
      if (pane && capture) {
        const mine = current.owner === env.sessionId;
        if (capture.afterRefresh) {
          stuck += 1;
          action = "stuck: prompt capture failed again after a refresh; agent_close, then agent_launch action=restore";
        } else if (act && mine) {
          const proof = yield* promptWithProof(pane.pane_id, captureRefreshNote()).pipe(
            Effect.catch((error) => Effect.succeed<Proof>({ state: "unproven", submission: "uncertain", detail: error.message })),
          );
          action = `refreshed bridge prompt capture (${proof.state})`;
        } else {
          stuck += 1;
          action = `stuck on bridge prompt capture; refresh due (${mine ? "act: false" : `owner ${current.owner}`})`;
        }
      }

      if (silentFor !== null && pane && working && !capture) {
        const decision = silenceDecision(current.state, silentFor, limits);
        const mine = current.owner === env.sessionId;
        if (decision.action !== "none" && !(act && mine)) {
          action = `${decision.action} due (${mine ? "act: false" : `owner ${current.owner}`})`;
        } else if (decision.events.length > 0) {
          const paneId = pane.pane_id;
          if (decision.action === "nudge") {
            yield* paneSendKeys(paneId, ["Escape"]);
            yield* paneRun(paneId, nudgeNote(silentFor));
            action = `nudged after ${Math.floor(silentFor / 60_000)}m`;
          } else if (decision.action === "restart") {
            const result = yield* restartByFork(dir, project, current).pipe(Effect.result);
            if (result._tag === "Failure") action = `restart failed: ${result.failure.message}`;
            else { current = result.success.row; endSession = result.success.endSession; action = `restarted by fork after ${Math.floor(silentFor / 60_000)}m; first turn proven`; }
          }
          if (decision.action !== "restart") {
            current = yield* patchRow(dir, current.name, current.state, decision.events).pipe(Effect.catch(() => Effect.succeed(current)));
          }
        }
      }

      const latest = current.sessionFile;
      if (latest !== file) cost = latest && existsSync(latest) ? yield* Effect.promise(() => readSessionCost(latest, CAPTURE_REFRESH_MARK)) : null;
      lines.push({
        ...statusEvidence(current, pane),
        name: current.name,
        role: current.role,
        lane: current.lane,
        state: current.state,
        pane: current.pane?.paneId ?? null,
        silentMin: silentFor === null ? null : Math.floor(silentFor / 60_000),
        cache: silentFor === null ? null : silentFor < CACHE_TTL_MS ? "warm" : "cold",
        cost,
        intercom: live === undefined ? "unknown" : live.includes(current.sessionId) ? "reachable" : "unreachable",
        sessionId: current.sessionId,
        action,
      });
      if (endSession) break; // The replacement now owns the remaining rows.
    }

    const autolandNotes: string[] = [];
    if (act && !endSession) {
      const snapshot = yield* load(dir);
      const candidates = snapshot.packets.filter(packet => autolandEligible(packet) &&
        snapshot.agents.some(row => row.name === packet.agent && row.owner === env.sessionId) &&
        (!packet.autolandCheckedAt || now - Date.parse(packet.autolandCheckedAt) >= AUTOLAND_RECHECK_MS))
        .sort((a, b) => a.reportedAt.localeCompare(b.reportedAt)).slice(0, AUTOLAND_CAP);
      for (const packet of candidates) {
        const landing = yield* findLanding(snapshot, packet, { notes: autolandNotes });
        const recorded = yield* mutate(dir, current => Effect.gen(function* () {
          const latest = yield* findPacket(current, packet.id);
          const row = yield* findRow(current, latest.agent);
          if (!autolandEligible(latest) || row.owner !== env.sessionId ||
            (latest.autolandCheckedAt && now - Date.parse(latest.autolandCheckedAt) < AUTOLAND_RECHECK_MS)) return [current, false] as const;
          const checked = { ...latest, autolandCheckedAt: iso(env) };
          if (!landing) return [withPacket(current, checked), false] as const;
          const result = yield* recordPacketOutcome(current, checked, "no_changes", landing.sha, landingEvidence(landing, landing.base), iso(env));
          // Do not retire a live worker or a newer report from the same agent.
          const newer = current.packets.some(other => other.agent === row.name && other.id !== packet.id &&
            autolandEligible(other) && other.reportedAt >= latest.reportedAt);
          const updated = !newer && (row.state === "reported" || row.state === "verified")
            ? withRow(result.project, { ...row, state: yield* stepAgent(row.name, row.state, { type: "LAND" }), updatedAt: iso(env) })
            : result.project;
          return [updated, true] as const;
        }));
        if (recorded && landing) autolandNotes.push(`autoland: ${packet.id.slice(0, 8)} → ${landing.sha.slice(0, 8)}${landing.how === "squash" ? ` (PR #${landing.pr})` : ""}`);
      }
    }
    const final = yield* load(dir);
    const label = yield* keepSpaceLabel(final, act);
    const tokens = act && !missingSpace ? yield* publishTokens(final, { stuck }) : "sidebar: preview (unchanged)";
    const brain = act ? yield* writeBrain(final) : "preview (unchanged)";
    const desk = openDeskItems(readDesk(queuePath(final.slug, env.home)));
    const fleet = yield* Effect.gen(function* () {
      const runner = yield* fleetRunner(dir);
      if (!runner) return { line: null, note: "fleet-compute: runner missing" };
      const status = yield* fleetStatus(dir, runner);
      return { line: gatesLine(status, env.now().getTime()), note: null };
    }).pipe(Effect.catch((error) => Effect.succeed({ line: null, note: `fleet-compute: ${error.message}` })));
    const orphans = final.agents.filter(row => row.side && row.state !== "closed" && !final.agents.some(parent => parent.name === row.side?.parent && parent.role === "desk" && parent.state !== "closed"));
    return { ...(endSession ? { endSession } : {}), project: final, agents: lines, openDesk: desk, board: [board(final, lines, desk.length, env.now().getTime(), fleet.line), ...ingestion.notes, ...recoveryNotes].join("\n"), notes: [...ingestion.notes, ...recoveryNotes, tokens, `brain: ${brain}`, ...orphans.map(row => `orphan side desk ${row.name}: parent ${row.side?.parent} is closed or missing; the side desk stays open`), ...autolandNotes, ...(label ? [label] : []), ...(fleet.note ? [fleet.note] : [])] };
  });

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

const REVIEW_DUE_MS = 7 * 24 * 60 * 60 * 1000;

/** The weekly review is overdue when the last one, or the project's start, is over a week old. Pure. */
export function reviewDue(project: Project, nowMs: number): string | null {
  const last = project.reviews.at(-1)?.at ?? null;
  const since = Date.parse(last ?? project.createdAt);
  if (!Number.isFinite(since) || nowMs - since <= REVIEW_DUE_MS) return null;
  const days = Math.floor((nowMs - since) / (24 * 60 * 60 * 1000));
  return last ? `⚠ review overdue: last project_review ${days}d ago` : `⚠ review overdue: no project_review in ${days}d`;
}

export function board(project: Project, agents: readonly AgentLine[], openDesk: number, nowMs: number = Date.now(), gates: string | null = null): string {
  const lanes = project.lanes.filter((lane) => !lane.archived);
  const posture = deployPosture(project);
  const due = reviewDue(project, nowMs);
  const pending = project.packets.filter((packet) => !TERMINAL_PACKET_STATES.includes(packet.state));
  const rows = new Map(project.agents.map(row => [row.name, row]));
  const parents = agents.filter(agent => !rows.get(agent.name)?.side);
  const grouped = parents.flatMap(parent => [parent, ...agents.filter(agent => rows.get(agent.name)?.side?.parent === parent.name)]);
  const orphans = agents.filter(agent => {
    const side = rows.get(agent.name)?.side;
    return side && !parents.some(parent => parent.name === side.parent);
  });
  const out = [
    `🐑 ${project.label} [${project.state}, ${project.mode}] next: ${project.nextAction}`,
    deployPostureLine(project),
    flowLine(project, nowMs),
    `lanes: ${lanes.map((lane) => `${lane.slug}=${lane.state} [deploy ${laneDeployLevel(lane, posture.level)}]`).join(", ") || "none"}`,
    `packets waiting: ${pending.map((packet) => `${packet.id.slice(0, 10)} ${packet.agent} ${packet.state}`).join("; ") || "none"}`,
    `desk: ${openDesk} open for Joel`,
    ...(gates ? [gates] : []),
    ...(due ? [`${due}. Reconfirm the outcome; work drifting to another project's outcome goes to that project's desk.`] : []),
    "agents (cost = cacheRead×0.1 + cacheWrite×1.25 + input, input-token equivalents):",
    ...[...grouped, ...orphans].map(
      (agent) => {
        const row = rows.get(agent.name);
        const name = row?.side ? `  ${row.profile.label.split(" ")[0]} ${agent.name} ↳ ${row.side.parent}` : agent.name;
        return `- ${name} ${agent.role}/${agent.lane} ${agent.state} pane=${agent.pane ?? "-"} quiet=${agent.silentMin ?? "?"}m cache=${agent.cache ?? "?"} cost=${agent.cost ? `${k(agent.cost.cost)} (last ${k(agent.cost.lastTurnCost ?? 0)}, ctx ${k(agent.cost.contextTokens ?? 0)}, ${agent.cost.turns} turns)` : "?"} intercom=${agent.intercom}${agent.sessionId ? `@${agent.sessionId.slice(0, 8)}` : ""}${agent.action ? ` · ${agent.action}` : ""}${agent.identity ? ` · identity: ${agent.identity}` : ""}${agent.capability ? ` · capability: ${agent.capability}` : ""}${agent.recovery ? ` · recovery: ${agent.recovery}` : ""}`;
      },
    ),
  ];
  return out.join("\n");
}

// ---------- project_review ----------

export interface ReviewInput {
  /** Mark the reported retro complete only after its artifact is recorded. */
  readonly retro?: boolean | undefined;
  readonly note: string;
  readonly outcome?: string | undefined;
  readonly reviewTrigger?: string | undefined;
  readonly criticalPath?: readonly string[] | undefined;
  readonly nextAction?: string | undefined;
  readonly decision?: "continue" | "split" | "archive" | undefined;
}

/** JITPM weekly review proposal. Pure; the owner decides. */
export function proposeReview(project: Project): "continue" | "split" | "archive" {
  const work = project.lanes.filter((lane) => lane.kind === "work" && !lane.archived);
  const openWork = work.filter((lane) => lane.state === "open" || lane.state === "draining");
  const liveAgents = project.agents.filter((agent) => agent.state !== "closed" && agent.role === "worker");
  const openPackets = project.packets.filter((packet) => !TERMINAL_PACKET_STATES.includes(packet.state));
  if (work.length > 0 && openWork.length === 0 && liveAgents.length === 0 && openPackets.length === 0) return "archive";
  if (openWork.length >= 4 || project.criticalPath.length > 6) return "split";
  return "continue";
}

export const projectReview = (dir: string, params: ReviewInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const before = yield* load(dir);
    const tailDir = closedDir(dir);
    const tailFiles = yield* Effect.try({
      try: () => existsSync(tailDir) ? readdirSync(tailDir).sort() : [],
      catch: error => new StoreError({ path: tailDir, message: String(error) }),
    });
    const retroLanes = before.lanes.filter(lane => lane.kind === "work" && lane.state === "closed" && !lane.discarded &&
      (!before.lastRetroAt || Date.parse(lane.closedAt ?? lane.updatedAt) > Date.parse(before.lastRetroAt)))
      .map(lane => {
        const agents = before.agents.filter(agent => agent.lane === lane.slug);
        return {
          slug: lane.slug,
          sessionFiles: agents.filter(agent => agent.role === "worker").flatMap(agent => agent.sessionFile ? [agent.sessionFile] : []),
          closedTails: tailFiles.filter(file => agents.some(agent => file.startsWith(`${agent.name}-`) &&
            /^(?:restart-)?\d+\.txt$/.test(file.slice(agent.name.length + 1)))).map(file => join(tailDir, file)),
          reports: before.packets.filter(packet => packet.lane === lane.slug).map(packet => packet.report),
        };
      });
    const proposal = proposeReview(before);
    const decision = params.decision ?? "continue";
    const reviewed = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        let state = yield* stepProject(current.slug, current.state, { type: "REVIEW" });
        const lanes = current.lanes.map((lane) => (lane.state === "closed" && !lane.archived ? { ...lane, archived: true, closedAt: lane.closedAt ?? lane.updatedAt, updatedAt: iso(env) } : lane));
        const openLanes = lanes.filter((lane) => lane.state !== "closed").length;
        state =
          decision === "archive"
            ? yield* stepProject(current.slug, state, { type: "ARCHIVE", openLanes })
            : yield* stepProject(current.slug, state, { type: "REVIEWED" });
        const next: Project = {
          ...current,
          outcome: params.outcome?.trim() || current.outcome,
          reviewTrigger: params.reviewTrigger?.trim() || current.reviewTrigger,
          criticalPath: params.criticalPath ? [...params.criticalPath] : current.criticalPath,
          nextAction: params.nextAction?.trim() || current.nextAction,
          lanes,
          state,
          ...(params.retro ? { lastRetroAt: iso(env) } : {}),
          reviews: [...current.reviews, { at: iso(env), note: params.note, proposal, decision }],
        };
        return [next, next] as const;
      }),
    );
    const archivedLanes = reviewed.lanes.filter((lane) => lane.archived && !before.lanes.find((prior) => prior.slug === lane.slug)?.archived).map((lane) => lane.slug);
    const tokens = yield* publishTokens(reviewed);
    const brain = yield* writeBrain(reviewed);
    return { project: reviewed, proposal, decision, archivedLanes, retroLanes, notes: [tokens, `brain: ${brain}`, "retro: run references/retro.md; record its artifact before project_review retro: true"] };
  });

// ---------- project_update ----------

export interface UpdateInput {
  /** Board frontmatter type chosen to match the repo's Brain rules. */
  readonly boardType?: string | undefined;
  /** One line: what the space is doing now. null clears it back to the next action. */
  readonly headline?: string | null | undefined;
  readonly nextAction?: string | undefined;
  /** The project's name, and its space label when Muster owns the space. */
  readonly label?: string | undefined;
  /** Merged over the current policy; each role merges key by key. */
  readonly policy?: unknown;
}

export const projectUpdate = (dir: string, params: UpdateInput) =>
  Effect.gen(function* () {
    const patch = params.policy === undefined ? null : yield* decodeWith(decodePolicy, params.policy);
    const { roster, path } = yield* loadRoster;
    const before = yield* load(dir);
    yield* Effect.try({
      try: () => effectivePolicy(roster, patch ? mergePolicy(before.policy, patch) : before.policy, before.slug),
      catch: (error) => input(String(error instanceof Error ? error.message : error)),
    });
    const label = params.label?.trim();
    const project = yield* mutate(dir, (current) =>
      Effect.sync(() => {
        const headline = params.headline === undefined ? current.headline : params.headline?.trim() || null;
        const next: Project = {
          ...current,
          ...(label ? { label } : {}),
          ...(params.boardType !== undefined ? { boardType: params.boardType } : {}),
          ...(params.nextAction?.trim() ? { nextAction: params.nextAction.trim() } : {}),
          ...(headline !== undefined ? { headline } : {}),
          ...(patch ? { policy: mergePolicy(current.policy, patch) } : {}),
        };
        return [next, next] as const;
      }),
    );
    const notes: string[] = [];
    if (label) notes.push((yield* keepSpaceLabel(project, true)) ?? `space label is "${project.label}"`);
    notes.push(yield* publishTokens(project));
    notes.push(`brain: ${yield* writeBrain(project)}`);
    notes.push(`roster: ${path ?? "built-in defaults"}`);
    return { project, policy: effectivePolicy(roster, project.policy, project.slug), notes };
  });
