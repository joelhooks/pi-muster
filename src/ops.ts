import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Effect } from "effect";

import {
  agentEnv,
  buildArgv,
  extensionsFor,
  mintSessionId,
  profileFor,
  sessionDirFor,
  sessionIdFromFile,
  shellPrelude,
} from "./argv.ts";
import type { LaunchKind, ProfileInput } from "./argv.ts";
import { appendDesk, deskRecord, queuePath, readDesk } from "./desk.ts";
import type { AgentRow, CheckOutcome, DeskKind, Lane, LaunchProfile, Mode, Packet, PaneBinding, Policy, Project, Role, Thinking } from "./domain.ts";
import { MAX_CADENCE_MINUTES, TERMINAL_PACKET_STATES, decodeAgentName, decodePolicy, decodeSlug, effectivePolicy, isTempPath, mergePolicy, roleDefaults, silenceLimits } from "./domain.ts";
import { GuardFailed, HeavyJobBusy, HerdrFailure, IllegalTransition, InputError, NotFound, PacketCheckFailed, ProcError } from "./errors.ts";
import { describeHolder, heavyLockPath, tryAcquire } from "./heavy-lock.ts";
import {
  agentStart,
  paneClose,
  paneGet,
  paneList,
  paneRead,
  paneRename,
  paneRun,
  paneSendKeys,
  paneSplit,
  promptWithProof,
  reportTokens,
  tabCreate,
  workspaceCreate,
  workspaceList,
  workspaceRename,
} from "./herdr.ts";
import type { PaneInfo, Proof } from "./herdr.ts";
import type { AgentEvent } from "./machines.ts";
import { PROCESS_STATES, stepAgent, stepLane, stepProject } from "./machines.ts";
import { failures, parsePorcelainZ, sha256File, sourceOf, verifyPacket } from "./packet.ts";
import { BOT_EMAIL, BOT_NAME, Intercom, MusterEnv, Proc, git, must } from "./runtime.ts";
import { CACHE_TTL_MS, readSessionCost, sessionMtimeMs } from "./session-file.ts";
import type { SessionCost } from "./session-file.ts";
import { nudgeSwitchboards } from "./switchboard-ops.ts";
import { CAPTURE_REFRESH_MARK, captureRefreshNote, nudgeNote, silenceDecision } from "./silence.ts";
import { loadRoster } from "./roster.ts";
import { registerProject } from "./switchboard-ops.ts";
import { closedDir, create, exists, load, mutate, reportsDir } from "./store.ts";
import { TOKEN_SOURCE, TOKEN_TTL_MS, deriveTokens, openDeskItems } from "./tokens.ts";
import type { LiveCounts } from "./tokens.ts";

const MAX_WORKERS_PER_TAB = 4;
const GATE_TIMEOUT_MS = 45 * 60_000;
const CLOSE_READ_LINES = 40;
const SHELL_RETRY_STEP_MS = 250;
const SHELL_RETRY_BUDGET_MS = 15_000;

// ---------- small pure helpers ----------

const iso = (env: { now: () => Date }) => env.now().toISOString();

const input = (message: string) => new InputError({ message });

export function findRow(project: Project, name: string) {
  const row = project.agents.find((agent) => agent.name === name);
  return row ? Effect.succeed(row) : Effect.fail(new NotFound({ kind: "agent", id: name, message: `no agent row named ${name}` }));
}

export function findLane(project: Project, slug: string) {
  const lane = project.lanes.find((candidate) => candidate.slug === slug);
  return lane ? Effect.succeed(lane) : Effect.fail(new NotFound({ kind: "lane", id: slug, message: `no lane named ${slug}` }));
}

export function findPacket(project: Project, id: string) {
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
        `| ${agent.name} | ${agent.role} | ${agent.lane} | ${agent.state} | ${agent.restore ? `\`cd ${esc(agent.restore.cwd)} && pi ${esc(agent.restore.argv.join(" "))}\`` : "-"} |`,
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
    if (params.desk && !project.lanes.some((lane) => lane.slug === "desk" && lane.state !== "closed")) {
      const desk = yield* laneOpen(dir, { slug: "desk", kind: "role", label: "💬 desk", goal: "Joel's gateway: answers from evidence and turns feedback into dispatches" });
      notes.push(`desk tab ${desk.lane.tabId}${createdRoot ? " (first tab)" : " (appended; an adopted space keeps its tab order)"}`);
      if (createdRoot) yield* paneClose(createdRoot).pipe(Effect.catch(() => Effect.void));
    }
    const final = yield* load(dir);
    yield* registerProject(final);
    notes.push(yield* publishTokens(final));
    notes.push(`brain: ${yield* writeBrain(final)}`);
    return { project: final, adopted, cadence: cadenceCall(final), notes };
  });

// ---------- lanes ----------

export interface LaneOpenInput {
  readonly slug: string;
  readonly label: string;
  readonly goal: string;
  readonly kind?: "work" | "role" | undefined;
  readonly writeScope?: readonly string[] | undefined;
  readonly repo?: string | undefined;
  readonly generated?: readonly string[] | undefined;
  /** False records the lane as proposed without a tab. */
  readonly open?: boolean | undefined;
}

export const laneOpen = (dir: string, params: LaneOpenInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const slug = yield* decodeWith(decodeSlug, params.slug);
    const project = yield* load(dir);
    if (params.repo) yield* requireAbsolute("repo", params.repo);
    const existing = project.lanes.find((lane) => lane.slug === slug);
    const wantOpen = params.open !== false;
    if (existing?.state === "open" && existing.root) {
      const live = yield* locatePane(existing.root);
      if (live && live.pane_id === existing.root.paneId && live.tab_id === existing.tabId) {
        return { lane: existing, created: false, note: null };
      }
    }
    if (wantOpen && !project.spaceId) return yield* input("the project has no space; run project_open with space or createSpace first");

    const base: Lane = existing ?? {
      slug,
      kind: params.kind ?? "work",
      label: params.label,
      goal: params.goal,
      writeScope: [...(params.writeScope ?? [])],
      repo: params.repo ?? null,
      generated: [...(params.generated ?? [])],
      tabId: null,
      root: null,
      state: "proposed",
      archived: false,
      createdAt: iso(env),
      updatedAt: iso(env),
    };
    if (!wantOpen) {
      const lane = yield* mutate(dir, (current) => Effect.succeed([withLane(current, base), base] as const));
      return { lane, created: !existing };
    }
    const event = base.state === "open" ? null : base.state === "proposed" ? ({ type: "OPEN" } as const) : ({ type: "REOPEN" } as const);
    if (event) yield* stepLane(slug, base.state, event);
    let tabId = base.tabId;
    let root = base.root;
    const liveRoot = root ? yield* locatePane(root) : null;
    let note: string | null = null;
    if (!liveRoot) {
      const tab = yield* tabCreate(project.spaceId as string, base.repo ?? project.dir, base.label);
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
        const state = event ? yield* stepLane(slug, latest.state, event) : latest.state;
        const next: Lane = {
          ...latest,
          label: params.label || latest.label,
          goal: params.goal || latest.goal,
          writeScope: params.writeScope ? [...params.writeScope] : latest.writeScope,
          generated: params.generated ? [...params.generated] : latest.generated,
          repo: params.repo ?? latest.repo,
          tabId,
          root,
          state,
          updatedAt: iso(env),
        };
        return [withLane(current, next), next] as const;
      }),
    );
    yield* publishTokens(yield* load(dir));
    return { lane, created: !existing, note };
  });

const laneCounts = (project: Project, slug: string) => ({
  liveAgents: project.agents.filter((agent) => agent.lane === slug && agent.state !== "closed"),
  openPackets: project.packets.filter((packet) => packet.lane === slug && !TERMINAL_PACKET_STATES.includes(packet.state)),
});

/** Close a pane only when it is still the terminal Muster opened. Never by name. */
const closeOwnedPane = (binding: PaneBinding | null) =>
  Effect.gen(function* () {
    if (!binding) return "no pane";
    if (!binding.openedByMuster) return `left ${binding.paneId} open: Muster did not open it`;
    const located = yield* locatePane(binding);
    if (!located) return `pane ${binding.paneId} already gone`;
    yield* paneClose(located.pane_id);
    return `closed ${located.pane_id}`;
  });

/** Pane ids change on moves; the terminal id does not. */
const locatePane = (binding: PaneBinding) =>
  Effect.gen(function* () {
    const direct = yield* paneGet(binding.paneId);
    if (direct && direct.terminal_id === binding.terminalId) return direct;
    const all = yield* paneList();
    return all.find((pane) => pane.terminal_id === binding.terminalId) ?? null;
  });

export const laneClose = (dir: string, slug: string) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const project = yield* load(dir);
    const lane = yield* findLane(project, slug);
    const { liveAgents, openPackets } = laneCounts(project, slug);
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
      return {
        lane: drained,
        closed: false,
        pending: [
          ...liveAgents.map((agent) => `agent ${agent.name} is ${agent.state}`),
          ...openPackets.map((packet) => `packet ${packet.id.slice(0, 12)} is ${packet.state}`),
        ],
      };
    }
    yield* stepLane(slug, lane.state, { type: "CLOSE", liveAgents: 0, openPackets: 0 });
    const paneNote = lane.root ? yield* closeOwnedPane(lane.root) : "no root pane";
    const closed = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        const latest = yield* findLane(current, slug);
        const counts = laneCounts(current, slug);
        const state = yield* stepLane(slug, latest.state, {
          type: "CLOSE",
          liveAgents: counts.liveAgents.length,
          openPackets: counts.openPackets.length,
        });
        const next: Lane = { ...latest, state, root: null, updatedAt: iso(env) };
        return [withLane(current, next), next] as const;
      }),
    );
    yield* publishTokens(yield* load(dir));
    return { lane: closed, closed: true, pending: [] as string[], paneNote };
  });

// ---------- agents ----------

export interface AgentLaunchInput {
  readonly action: LaunchKind;
  readonly name: string;
  readonly role?: Role | undefined;
  readonly lane?: string | undefined;
  readonly label?: string | undefined;
  readonly cwd?: string | undefined;
  readonly clone?: boolean | undefined;
  readonly from?: string | undefined;
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

const cloneFor = (source: string, name: string) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const slug = name.replace(/_/g, "-");
    const out = yield* must(env.workerWorktree, ["create", source, slug], { cwd: source, timeoutMs: 300_000 });
    const path = /^worktree:\s+(.+)$/m.exec(out)?.[1]?.trim();
    const branch = /^branch:\s+(.+)$/m.exec(out)?.[1]?.trim();
    if (!path || !branch) return yield* input(`worker-worktree.sh create printed no worktree/branch:\n${out}`);
    return { path, branch };
  });

const waitForCwd = (paneId: string, cwd: string) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    let seen: string | undefined;
    for (let i = 0; i < 40; i++) {
      const pane = yield* paneGet(paneId);
      seen = pane?.foreground_cwd ?? pane?.cwd;
      if (pane && (pane.foreground_cwd === cwd || pane.cwd === cwd)) return;
      yield* env.sleep(250);
    }
    return yield* new GuardFailed({ guard: "pane-cwd", message: `pane ${paneId} cwd is ${seen ?? "unknown"}, expected ${cwd}` });
  });

/** The session file Herdr reports for the Pi in this pane; the new id after `/new` or a restore. */
const waitForSession = (paneId: string, previous: string | null) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    for (let i = 0; i < 40; i++) {
      const pane = yield* paneGet(paneId);
      const value = pane?.agent_session?.kind === "path" ? pane.agent_session.value : null;
      if (value && value !== previous) return value;
      yield* env.sleep(250);
    }
    return null;
  });

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
  const holder = project.agents.find((other) => other.name !== row.name && blocksPane(other) && sharesPane(binding, other.pane));
  return holder ? input(`pane ${binding.paneId} already bound to ${holder.name} (${holder.state}); choose another pane`) : Effect.void;
};

const pickPane = (project: Project, lane: Lane, row: AgentRow, params: AgentLaunchInput) =>
  Effect.gen(function* () {
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

/** The default first prompt fits the role: only workers and bosses have a packet to report. */
export const workPrompt = (row: AgentRow, prompt: string | undefined) => {
  if (prompt !== undefined) return prompt;
  if (!row.brief) return undefined;
  switch (row.role) {
    case "desk":
      return `Read your brief at ${row.brief}. You are this project's desk: Joel talks to you here. Say hello in one line, then wait for him.`;
    case "hawk":
    case "judge":
      return `Read your brief at ${row.brief} and take up the role it describes. Report only through the channels it names.`;
    default:
      return `Read your brief at ${row.brief} and do the work it describes. When your result is committed, call packet_report once with the commit and your checks.`;
  }
};

export const agentLaunch = (dir: string, params: AgentLaunchInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const name = yield* decodeWith(decodeAgentName, params.name);
    const project = yield* load(dir);
    const existing = project.agents.find((agent) => agent.name === name);

    let row: AgentRow;
    if (params.action === "restore") {
      if (!existing) return yield* new NotFound({ kind: "agent", id: name, message: `no row ${name} to restore` });
      const cwd = params.cwd ? yield* requireAbsolute("cwd", params.cwd) : existing.cwd;
      if (!existsSync(cwd)) {
        return yield* new GuardFailed({ guard: "cwd", message: `${cwd} is gone (a removed clone?). Pass cwd for a fresh clone, or fork from this row.` });
      }
      const sessionFile = existing.sessionFile ?? findSessionFile(existing.cwd, existing.sessionId, env.home);
      if (!sessionFile) return yield* new GuardFailed({ guard: "session", message: `row ${name} has no session file to restore; use launch` });
      row = { ...existing, cwd, sessionFile, owner: env.sessionId, state: yield* stepAgent(name, existing.state, { type: "RESTORE" }) };
    } else {
      const relaunchable = existing?.state === "planned" || existing?.state === "failed" || (existing?.state === "interrupted" && !existing.sessionFile);
      if (existing && !relaunchable) {
        return yield* input(`row ${name} is ${existing.state}; restore it, or pick a new name`);
      }
      const parent = params.action === "fork" ? yield* findRow(project, params.from ?? "") : null;
      if (params.action === "fork" && !parent?.sessionFile) return yield* input(`fork needs --from a row with a session file`);
      const role = params.role ?? parent?.role ?? existing?.role;
      const laneSlug = params.lane ?? parent?.lane ?? existing?.lane;
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
        const allocated = yield* cloneFor(source, name);
        cwd = allocated.path;
        clone = { source, branch: allocated.branch };
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
      const profile: LaunchProfile = profileFor(role, {
        ...inherited,
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
        ...(params.appendSystemPrompt !== undefined ? { appendSystemPrompt: params.appendSystemPrompt } : {}),
        ...(params.skills !== undefined ? { skills: params.skills } : {}),
        ...(params.noSkills !== undefined ? { noSkills: params.noSkills } : {}),
        ...(params.extensions !== undefined ? { extensions: params.extensions } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
        ...(params.compactAt !== undefined ? { compactAt: params.compactAt } : {}),
      }, roleDefaults((yield* loadRoster).roster, project.policy, role, params.model));
      const now = iso(env);
      row = {
        name,
        role,
        lane: laneSlug,
        cwd,
        clone,
        profile,
        sessionId: existing?.sessionId ?? mintSessionId(name, env.now()),
        sessionFile: null,
        parentSessionFile: parent?.sessionFile ?? null,
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

    const kind: LaunchKind = params.action;
    const launchProfile = extensionsFor(project, row);
    const argv = buildArgv({
      kind,
      sessionId: row.sessionId,
      sessionFile: row.sessionFile,
      parentSessionFile: row.parentSessionFile,
      profile: launchProfile,
      musterExtension: project.musterExtension,
    });
    const agentEnvironment = agentEnv(project, row);
    yield* mutate(dir, (current) => Effect.succeed([withRow(current, row), row] as const));

    const lane = yield* findLane(project, row.lane);
    const failLaunch = () => patchRow(dir, row.name, row.state, [{ type: "LAUNCH_FAILED" }]).pipe(Effect.catch(() => Effect.void));
    const picked = yield* pickPane(project, lane, row, params).pipe(Effect.tapError(failLaunch));
    // Claim and release stale bindings together, before sending anything to the shell.
    const binding = yield* mutate(dir, (current) => Effect.gen(function* () {
      yield* guardPaneBinding(current, row, picked);
      const stale = current.agents.filter((other) => other.name !== row.name && sharesPane(picked, other.pane));
      const binding = { ...picked, openedByMuster: picked.openedByMuster || current.agents.some((other) => sharesPane(picked, other.pane) && other.pane?.openedByMuster) };
      const agents = current.agents.map((other) => other.name === row.name
        ? { ...other, pane: binding, updatedAt: iso(env) }
        : stale.includes(other) ? { ...other, pane: null, updatedAt: iso(env) } : other);
      return [{ ...current, agents }, binding] as const;
    })).pipe(Effect.tapError(failLaunch));
    const launched = yield* Effect.gen(function* () {
      yield* paneRun(binding.paneId, shellPrelude(row.cwd, agentEnvironment));
      yield* waitForCwd(binding.paneId, row.cwd);
      // Cwd can be right while zsh's prompt hooks still own the foreground job.
      // Retry only the rejected start, not the prelude that caused the race.
      const start = (attempt: number): ReturnType<typeof agentStart> =>
        agentStart(row.name, binding.paneId, argv).pipe(
          Effect.catch((error) => {
            if (error.code !== "agent_pane_busy") return Effect.fail(error);
            if (attempt < SHELL_RETRY_BUDGET_MS / SHELL_RETRY_STEP_MS) {
              return env.sleep(SHELL_RETRY_STEP_MS).pipe(Effect.flatMap(() => start(attempt + 1)));
            }
            return Effect.fail(new HerdrFailure({
              operation: error.operation,
              code: error.code,
              message: `agent-start available-shell wait exhausted after ${SHELL_RETRY_BUDGET_MS} ms of retries for pane ${binding.paneId}: ${error.message}`,
            }));
          }),
        );
      const agent = yield* start(0);
      const sessionFile = (yield* waitForSession(binding.paneId, null)) ?? findSessionFile(row.cwd, row.sessionId, env.home);
      if (!sessionFile) {
        const tail = yield* paneRead(binding.paneId, 12).pipe(Effect.catch(() => Effect.succeed("(pane unreadable)")));
        return yield* new GuardFailed({
          guard: "launch",
          message: `Herdr started ${row.name} but no Pi session appeared in ${binding.paneId}. Pane tail (UNTRUSTED):\n${tail.trim().slice(-1500)}`,
        });
      }
      yield* paneRename(binding.paneId, row.profile.label).pipe(Effect.catch(() => Effect.void));
      return { binding, agent, sessionFile };
    }).pipe(Effect.tapError(failLaunch));

    const actualId = launched.sessionFile ? sessionIdFromFile(launched.sessionFile) : null;
    const restore = {
      cwd: row.cwd,
      argv: buildArgv({
        kind: "restore",
        sessionId: actualId ?? row.sessionId,
        sessionFile: launched.sessionFile,
        parentSessionFile: null,
        profile: launchProfile,
        musterExtension: project.musterExtension,
      }),
      env: agentEnvironment,
    };
    let running = yield* patchRow(dir, row.name, row.state, [{ type: "STARTED" }], {
      pane: launched.binding,
      sessionFile: launched.sessionFile,
      sessionId: actualId ?? row.sessionId,
      restore,
    });

    const text = workPrompt(running, params.prompt);
    let proof: Proof | null = null;
    if (text) {
      proof = yield* promptWithProof(launched.binding.paneId, text).pipe(
        Effect.catch((error) =>
          Effect.succeed<Proof>({ state: "unproven", submission: "uncertain", detail: `${error.operation}: ${error.message}. Read the pane before resending.` }),
        ),
      );
      running = yield* patchRow(dir, row.name, "running", [], { delivery: proof.state === "proven" ? "proven" : "unproven" });
    }
    const tokens = yield* publishTokens(yield* load(dir));
    return {
      row: running,
      argv,
      readiness: launched.agent.interactive_ready === true ? "proven" : "unknown",
      proof,
      sessionIdMatched: actualId === null ? null : actualId === row.sessionId,
      notes: [tokens],
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
    const row = yield* findRow(project, params.name);
    yield* requireOwner(row, env.sessionId, params.takeover);
    const verified = project.packets.some((packet) => packet.agent === row.name && packet.verification !== null);
    if (params.force && !verified) {
      return yield* new GuardFailed({ guard: "force-after-verify", message: `--force removes unharvested work; ${row.name} has no packet that passed packet_verify` });
    }
    const notes: string[] = [];
    if (row.state !== "closed") {
      yield* stepAgent(row.name, row.state, { type: "CLOSE" });
      if (row.pane) {
        const binding = row.pane;
        const holder = project.agents.find((other) => other.name !== row.name && other.state !== "closed" && sharesPane(binding, other.pane));
        const located = holder ? null : yield* locatePane(row.pane);
        if (holder) {
          notes.push(`pane ${row.pane.paneId} kept: ${holder.name} is bound to it`);
        } else if (located) {
          const tail = yield* paneRead(located.pane_id, CLOSE_READ_LINES).pipe(Effect.catch(() => Effect.succeed("")));
          const saved = join(closedDir(dir), `${row.name}-${env.now().getTime()}.txt`);
          mkdirSync(dirname(saved), { recursive: true });
          writeFileSync(saved, tail);
          notes.push(`last ${CLOSE_READ_LINES} lines saved to ${saved}`);
          notes.push(yield* closeOwnedPane(row.pane));
        } else {
          notes.push(`pane ${row.pane.paneId} already gone`);
        }
      }
    }
    const sessionFile = row.sessionFile ?? findSessionFile(row.cwd, row.sessionId, env.home);
    const profile = extensionsFor(project, row);
    const restore = {
      cwd: row.cwd,
      argv: buildArgv({ kind: "restore", sessionId: row.sessionId, sessionFile, parentSessionFile: null, profile, musterExtension: project.musterExtension }),
      env: agentEnv(project, row),
    };
    const closed = row.state === "closed" ? row : yield* patchRow(dir, row.name, row.state, [{ type: "CLOSE" }], { pane: null, sessionFile, restore });

    let cloneError: string | null = null;
    if (row.clone && existsSync(row.cwd)) {
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
  readonly body?: string | undefined;
}

export function reportMarkdown(row: AgentRow, packet: Pick<Packet, "id" | "kind" | "artifact" | "checks">, summary: string, body: string | undefined): string {
  return [
    `# Packet ${packet.id.slice(0, 12)} from ${row.name}`,
    "",
    `- Lane: ${row.lane}`,
    `- Kind: ${packet.kind}`,
    `- Id: \`${packet.id}\`${packet.kind === "artifact" ? ` (sha256 of \`${packet.artifact}\`)` : ` (commit on ${row.clone?.branch ?? "the clone's branch"} in \`${row.cwd}\`)`}`,
    "",
    "## Summary",
    "",
    summary.trim(),
    "",
    "## Checks",
    "",
    "| Check | Outcome | Detail |",
    "| --- | --- | --- |",
    ...packet.checks.map((check) => `| ${check.name} | ${check.outcome} | ${(check.detail ?? "").replace(/\|/g, "\\|")} |`),
    "",
    ...(body?.trim() ? ["## Notes", "", body.trim(), ""] : []),
  ].join("\n");
}

export const packetReport = (params: PacketReportInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const intercom = yield* Intercom;
    const proc = yield* Proc;
    if (!params.commit === !params.artifact) return yield* input("packet_report needs exactly one of commit or artifact");
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
      if (!ancestor) return yield* input(`earlier packet ${earlier.id.slice(0, 12)} needs an outcome first; land or reject it before reporting a non-ancestor follow-up`);
    }
    const report = join(reportsDir(params.dir), row.lane, `${row.name}-${id.slice(0, 12)}.md`);
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
          reportedAt: prior?.reportedAt ?? now,
          updatedAt: now,
        };
        const livePane = latest.state === "reported" || latest.state === "verified" || latest.state === "landed"
          ? latest.pane ? yield* locatePane(latest.pane) : null
          : null;
        const state = yield* stepAgent(latest.name, latest.state, { type: "REPORT", paneLive: !!livePane?.agent });
        const next: AgentRow = { ...latest, state, updatedAt: now };
        mkdirSync(dirname(report), { recursive: true });
        writeFileSync(report, reportMarkdown(latest, draft, params.summary, params.body));
        return [withPacket(withRow(current, next), packet), { packet, owner: latest.owner }] as const;
      }),
    );
    const message = `🐑 packet ${id.slice(0, 12)} from ${row.name} (${row.lane}): ${(params.summary.trim().split("\n")[0] ?? "").slice(0, 200).replace(/[.\s]+$/, "")}. Report: ${report}`;
    const delivery = yield* intercom.send(saved.owner, message);
    return { packet: saved.packet, delivery };
  });

export const packetVerify = (dir: string, id: string) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const project = yield* load(dir);
    const packet = yield* findPacket(project, id);
    const row = yield* findRow(project, packet.agent);
    const lane = project.lanes.find((candidate) => candidate.slug === packet.lane);
    const checks = yield* verifyPacket(project, lane, row, packet);
    const failed = failures(checks);
    if (failed.length > 0) {
      return yield* new PacketCheckFailed({
        packet: packet.id,
        failures: failed.map((check) => `${check.name}: ${check.detail ?? "failed"}`),
        message: `packet ${packet.id.slice(0, 12)} failed ${failed.length} check(s)`,
      });
    }
    const verified = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        const latest = yield* findPacket(current, packet.id);
        if (TERMINAL_PACKET_STATES.includes(latest.state)) return yield* input(`packet ${packet.id.slice(0, 12)} is already ${latest.state}`);
        const next: Packet = { ...latest, state: "verified", verification: { at: iso(env), checks }, updatedAt: iso(env) };
        const agent = yield* findRow(current, packet.agent);
        const withAgent =
          agent.state === "reported"
            ? withRow(current, { ...agent, state: yield* stepAgent(agent.name, agent.state, { type: "VERIFY" }), updatedAt: iso(env) })
            : current;
        return [withPacket(withAgent, next), next] as const;
      }),
    );
    return { packet: verified, checks };
  });

export type LandOutcome = "committed" | "rejected" | "no_changes";

export interface PacketLandInput {
  readonly id: string;
  readonly outcome: LandOutcome;
  readonly gate?: string | undefined;
  readonly landedAs?: string | undefined;
  readonly evidence?: string | undefined;
  readonly message?: string | undefined;
}

const runGate = (source: string, gate: string) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const proc = yield* Proc;
    const lock = heavyLockPath(env.home);
    const held = tryAcquire(lock, `muster gate: ${gate}`);
    if (!held.ok) {
      return yield* new HeavyJobBusy({ holder: describeHolder(held.holder), message: `one full gate at a time on this machine; busy: ${describeHolder(held.holder)}` });
    }
    return yield* proc.run("sh", ["-c", gate], { cwd: source, timeoutMs: GATE_TIMEOUT_MS }).pipe(Effect.ensuring(Effect.sync(held.release)));
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
    if (existsSync(row.cwd)) yield* git(source, "fetch", "-q", row.cwd, `${branch}:${branch}`);
    const onBranch = (yield* proc.run("git", ["merge-base", "--is-ancestor", packet.id, branch], { cwd: source })).code === 0;
    if (!onBranch) return yield* new GuardFailed({ guard: "harvest", message: `${packet.id.slice(0, 12)} is not on ${branch} in ${source}` });
    const merged = (yield* proc.run("git", ["merge-base", "--is-ancestor", packet.id, "HEAD"], { cwd: source })).code === 0;
    if (merged) return { landedAs: (yield* git(source, "rev-parse", "HEAD")).trim(), note: "already on HEAD; nothing merged" };
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
    return yield* Effect.gen(function* () {
      yield* isolatedGit("read-tree", "HEAD");
      const merge = yield* proc.run("git", ["-c", "user.name=shitratgit[bot]", "-c", "user.email=286405550+shitratgit[bot]@users.noreply.github.com", "merge", "--no-ff", "--no-commit", branch], { cwd: source, env: indexEnv });
      if (merge.code !== 0) {
        yield* abort();
        return yield* new GuardFailed({ guard: "merge", message: `merge of ${branch} failed and was aborted: ${(merge.stderr || merge.stdout).trim().slice(-800)}` });
      }
      if (params.gate) {
        const gate = yield* runGate(source, params.gate).pipe(Effect.tapError(abort));
        if (gate.code !== 0) {
          yield* abort();
          return yield* new GuardFailed({ guard: "gate", message: `gate failed (exit ${gate.code}); merge aborted:\n${(gate.stdout + gate.stderr).trim().slice(-1500)}` });
        }
      }
      const message = params.message ?? `muster: land ${row.lane}/${row.name} ${packet.id.slice(0, 12)}`;
      yield* must("git", ["commit", "--no-edit", "-m", message], {
        cwd: source,
        env: { ...indexEnv, GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL, GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL },
      }).pipe(Effect.tapError(abort));
      if (incoming.length) yield* git(source, "--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--", ...incoming);
      return { landedAs: (yield* git(source, "rev-parse", "HEAD")).trim(), note: `merged ${branch} --no-ff as shitratgit[bot]; not pushed` };
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(scratch, { recursive: true }))));
  });

/** One terminal outcome per packet, including packets landed with a follow-up. */
const recordPacketOutcome = (project: Project, packet: Packet, outcome: LandOutcome, landedAs: string | null, evidence: string | undefined, now: string) =>
  Effect.gen(function* () {
    if (TERMINAL_PACKET_STATES.includes(packet.state)) return yield* input(`packet ${packet.id.slice(0, 12)} is already ${packet.state}`);
    const next: Packet = { ...packet, state: outcome, landedAs, ...(evidence ? { evidence } : {}), updatedAt: now };
    return { project: withPacket(project, next), packet: next };
  });

export const packetLand = (dir: string, params: PacketLandInput) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const proc = yield* Proc;
    const project = yield* load(dir);
    const packet = yield* findPacket(project, params.id);
    if (TERMINAL_PACKET_STATES.includes(packet.state)) return yield* input(`packet ${packet.id.slice(0, 12)} is already ${packet.state}`);
    const row = yield* findRow(project, packet.agent);
    const lane = project.lanes.find((candidate) => candidate.slug === packet.lane);

    let landedAs: string | null = null;
    let note = "";
    const recording = packet.kind === "artifact" || (!row.clone && !params.landedAs);
    let evidence = params.evidence?.trim();
    if (recording && !evidence) return yield* input(`packet ${packet.id.slice(0, 12)} has no clone branch to merge; pass evidence (what you checked and where) to record its outcome`);
    if (params.outcome === "committed") {
      if (packet.state !== "verified") return yield* new GuardFailed({ guard: "verified", message: `run packet_verify on ${packet.id.slice(0, 12)} before landing it` });
      if (recording) {
        note = "recorded without a merge";
      } else if (project.mode === "rift-merge" && !params.landedAs) {
        ({ landedAs, note } = yield* riftMerge(project, lane, row, packet, params));
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
        const recorded = yield* recordPacketOutcome(current, latest, params.outcome, landedAs, evidence, iso(env));
        const agent = yield* findRow(current, packet.agent);
        const moves = agent.state === "reported" || agent.state === "verified" || (agent.state === "landed" && event.type === "REWORK");
        let updated = moves ? withRow(recorded.project, { ...agent, state: yield* stepAgent(agent.name, agent.state, event), updatedAt: iso(env) }) : recorded.project;
        if (params.outcome === "committed") {
          let supersedes = latest.supersedes;
          const seen = new Set([latest.id]);
          while (supersedes) {
            if (seen.has(supersedes)) return yield* input("packet supersedes chain contains a cycle");
            seen.add(supersedes);
            const earlier = yield* findPacket(updated, supersedes);
            if (!TERMINAL_PACKET_STATES.includes(earlier.state)) {
              updated = (yield* recordPacketOutcome(updated, earlier, "committed", landedAs, `landed with ${latest.id}`, iso(env))).project;
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
  readonly action: string | null;
}

export interface StatusInput {
  readonly act?: boolean | undefined;
  /** Explicit handover: adopt all non-closed rows without restarting their panes. */
  readonly takeover?: boolean | undefined;
}

export const projectStatus = (dir: string, params: StatusInput = {}) =>
  Effect.gen(function* () {
    const env = yield* MusterEnv;
    const intercom = yield* Intercom;
    const act = params.act !== false;
    const project = params.takeover
      ? yield* mutate(dir, (current) => {
          const next = { ...current, agents: current.agents.map((row) =>
            row.state === "closed" ? row : { ...row, owner: env.sessionId, updatedAt: iso(env) }) };
          return Effect.succeed([next, next] as const);
        })
      : yield* load(dir);
    const panes = yield* paneList();
    const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
    const byTerminal = new Map(panes.map((pane) => [pane.terminal_id, pane]));
    const live = yield* intercom.sessions();
    const now = env.now().getTime();
    const limits = silenceLimits(project.policy);
    const lines: AgentLine[] = [];
    let stuck = 0;

    for (const row of project.agents) {
      if (row.state === "closed" || row.state === "planned") continue;
      let pane: PaneInfo | undefined;
      if (row.pane) {
        const direct = byId.get(row.pane.paneId);
        pane = direct && direct.terminal_id === row.pane.terminalId ? direct : byTerminal.get(row.pane.terminalId);
      }
      let action: string | null = null;
      let current = row;
      const adoptionCandidate = row.state === "failed" || row.state === "launching";
      if (adoptionCandidate) {
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
              const restore = {
                cwd: row.cwd,
                argv: buildArgv({ kind: "restore", sessionId, sessionFile, parentSessionFile: null, profile: extensionsFor(project, row), musterExtension: project.musterExtension }),
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
      } else if (row.pane && !pane) {
        if (PROCESS_STATES.includes(row.state)) {
          current = yield* patchRow(dir, row.name, row.state, [{ type: "PANE_GONE" }], { pane: null }).pipe(Effect.catch(() => Effect.succeed(row)));
          action = "pane gone: interrupted";
        } else {
          current = yield* patchRow(dir, row.name, row.state, [], { pane: null }).pipe(Effect.catch(() => Effect.succeed(row)));
        }
      } else if (pane && !pane.agent && PROCESS_STATES.includes(row.state) && row.state !== "restoring") {
        current = yield* patchRow(dir, row.name, row.state, [{ type: "PANE_GONE" }], { pane: { ...(row.pane as PaneBinding), paneId: pane.pane_id } }).pipe(
          Effect.catch(() => Effect.succeed(row)),
        );
        action = "agent exited to its shell: interrupted";
      } else if (row.pane && pane && pane.pane_id !== row.pane.paneId) {
        current = yield* patchRow(dir, row.name, row.state, [], { pane: { ...row.pane, paneId: pane.pane_id, tabId: pane.tab_id } }).pipe(
          Effect.catch(() => Effect.succeed(row)),
        );
        action = `rebound moved pane to ${pane.pane_id}`;
      }
      const herdrFile = pane?.agent_session?.kind === "path" ? pane.agent_session.value : null;
      if (!adoptionCandidate && herdrFile && herdrFile !== current.sessionFile) {
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
      const working = !adoptionCandidate && ["running", "silent", "nudged", "restarted"].includes(current.state);

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
            const tail = yield* paneRead(paneId, CLOSE_READ_LINES).pipe(Effect.catch(() => Effect.succeed("")));
            const saved = join(closedDir(dir), `${current.name}-restart-${now}.txt`);
            mkdirSync(dirname(saved), { recursive: true });
            writeFileSync(saved, tail);
            yield* paneSendKeys(paneId, ["Escape"]);
            yield* paneRun(paneId, "/new");
            const fresh = yield* waitForSession(paneId, current.sessionFile);
            const text = workPrompt(current, undefined);
            const proof = text
              ? yield* promptWithProof(paneId, text).pipe(
                  Effect.catch((error) => Effect.succeed<Proof>({ state: "unproven", submission: "uncertain", detail: error.message })),
                )
              : null;
            action = `restarted with /new after ${Math.floor(silentFor / 60_000)}m; ${proof ? `re-prompt ${proof.state}` : "no brief to re-prompt"}; tail saved to ${saved}`;
            current = yield* patchRow(dir, current.name, current.state, decision.events, {
              restarts: current.restarts + 1,
              ...(fresh ? { sessionFile: fresh, sessionId: sessionIdFromFile(fresh) ?? current.sessionId } : {}),
              delivery: proof?.state === "proven" ? "proven" : "unproven",
            }).pipe(Effect.catch(() => Effect.succeed(current)));
          }
          if (decision.action !== "restart") {
            current = yield* patchRow(dir, current.name, current.state, decision.events).pipe(Effect.catch(() => Effect.succeed(current)));
          }
        }
      }

      const latest = current.sessionFile;
      if (latest !== file) cost = latest && existsSync(latest) ? yield* Effect.promise(() => readSessionCost(latest, CAPTURE_REFRESH_MARK)) : null;
      lines.push({
        name: current.name,
        role: current.role,
        lane: current.lane,
        state: current.state,
        pane: current.pane?.paneId ?? null,
        silentMin: silentFor === null ? null : Math.floor(silentFor / 60_000),
        cache: silentFor === null ? null : silentFor < CACHE_TTL_MS ? "warm" : "cold",
        cost,
        intercom: live === undefined ? "unknown" : live.includes(current.sessionId) ? "reachable" : "unreachable",
        action,
      });
    }

    const final = yield* load(dir);
    const label = yield* keepSpaceLabel(final, act);
    const tokens = yield* publishTokens(final, { stuck });
    const brain = yield* writeBrain(final);
    const desk = openDeskItems(readDesk(queuePath(final.slug, env.home)));
    return { project: final, agents: lines, openDesk: desk, board: board(final, lines, desk.length), notes: [tokens, `brain: ${brain}`, ...(label ? [label] : [])] };
  });

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

export function board(project: Project, agents: readonly AgentLine[], openDesk: number): string {
  const lanes = project.lanes.filter((lane) => !lane.archived);
  const pending = project.packets.filter((packet) => !TERMINAL_PACKET_STATES.includes(packet.state));
  const out = [
    `🐑 ${project.label} [${project.state}, ${project.mode}] next: ${project.nextAction}`,
    `lanes: ${lanes.map((lane) => `${lane.slug}=${lane.state}`).join(", ") || "none"}`,
    `packets waiting: ${pending.map((packet) => `${packet.id.slice(0, 10)} ${packet.agent} ${packet.state}`).join("; ") || "none"}`,
    `desk: ${openDesk} open for Joel`,
    "agents (cost = cacheRead×0.1 + cacheWrite×1.25 + input, input-token equivalents):",
    ...agents.map(
      (agent) =>
        `- ${agent.name} ${agent.role}/${agent.lane} ${agent.state} pane=${agent.pane ?? "-"} quiet=${agent.silentMin ?? "?"}m cache=${agent.cache ?? "?"} cost=${agent.cost ? `${k(agent.cost.cost)} (last ${k(agent.cost.lastTurnCost ?? 0)}, ctx ${k(agent.cost.contextTokens ?? 0)}, ${agent.cost.turns} turns)` : "?"} intercom=${agent.intercom}${agent.action ? ` · ${agent.action}` : ""}`,
    ),
  ];
  return out.join("\n");
}

// ---------- project_review ----------

export interface ReviewInput {
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
    const proposal = proposeReview(before);
    const decision = params.decision ?? "continue";
    const reviewed = yield* mutate(dir, (current) =>
      Effect.gen(function* () {
        let state = yield* stepProject(current.slug, current.state, { type: "REVIEW" });
        const lanes = current.lanes.map((lane) => (lane.state === "closed" && !lane.archived ? { ...lane, archived: true, updatedAt: iso(env) } : lane));
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
          reviews: [...current.reviews, { at: iso(env), note: params.note, proposal, decision }],
        };
        return [next, next] as const;
      }),
    );
    const archivedLanes = reviewed.lanes.filter((lane) => lane.archived && !before.lanes.find((prior) => prior.slug === lane.slug)?.archived).map((lane) => lane.slug);
    const tokens = yield* publishTokens(reviewed);
    const brain = yield* writeBrain(reviewed);
    return { project: reviewed, proposal, decision, archivedLanes, notes: [tokens, `brain: ${brain}`] };
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
    const { roster, path } = yield* loadRoster;
    notes.push(`roster: ${path ?? "built-in defaults"}`);
    return { project, policy: effectivePolicy(roster, project.policy), notes };
  });
