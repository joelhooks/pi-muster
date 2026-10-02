import { Effect, Schema } from "effect";

/**
 * Muster's domain values. Every file Muster reads or writes decodes through
 * these schemas, so a hand-edited or foreign `project.json` fails at the
 * boundary instead of deep inside an operation.
 *
 * A row's lifecycle mode is one machine state (see `machines.ts`). Nothing
 * else in a row restates it: no `status` next to `state`, no booleans that
 * shadow a state.
 */

export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SESSION_ID_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** Longest wake interval that keeps the provider's prompt cache warm (TTL about one hour). */
export const MAX_CADENCE_MINUTES = 55;

export const AgentName = Schema.String.check(
  Schema.isPattern(NAME_RE, { message: "agent name must match [a-z][a-z0-9_-]{0,31}" }),
);
export const Slug = Schema.String.check(
  Schema.isPattern(SLUG_RE, { message: "slug must be kebab-case [a-z0-9-], at most 64 chars" }),
);
export const SessionId = Schema.String.check(
  Schema.isPattern(SESSION_ID_RE, { message: "invalid Pi session id" }),
);
const Iso = Schema.String;
const Path = Schema.String;

export const Role = Schema.Literals(["desk", "hawk", "boss", "worker", "judge"]);
export type Role = typeof Role.Type;

export const Mode = Schema.Literals(["herdr-workflow", "rift-merge", "pr-merge"]);
export type Mode = typeof Mode.Type;

export const Thinking = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type Thinking = typeof Thinking.Type;

export const AgentState = Schema.Literals([
  "planned",
  "launching",
  "running",
  "silent",
  "nudged",
  "restarted",
  "reported",
  "verified",
  "landed",
  "closed",
  "interrupted",
  "restoring",
  "failed",
]);
export type AgentState = typeof AgentState.Type;

export const LaneState = Schema.Literals(["proposed", "open", "draining", "closed"]);
export type LaneState = typeof LaneState.Type;

export const ProjectState = Schema.Literals(["setup", "active", "reviewing", "archived"]);
export type ProjectState = typeof ProjectState.Type;

export const PacketState = Schema.Literals(["reported", "verified", "committed", "rejected", "no_changes"]);
export type PacketState = typeof PacketState.Type;
export const TERMINAL_PACKET_STATES: readonly PacketState[] = ["committed", "rejected", "no_changes"];

/** Everything needed to start the same Pi process again. Fixed at launch; changing it means a restore. */
export const LaunchProfile = Schema.Struct({
  label: Schema.String,
  model: Schema.String,
  thinking: Schema.NullOr(Thinking),
  appendSystemPrompt: Schema.Array(Path),
  noSkills: Schema.Boolean,
  skills: Schema.Array(Path),
  extensions: Schema.Array(Path),
  env: Schema.Record(Schema.String, Schema.String),
  compactAt: Schema.NullOr(Schema.Number.check(Schema.isInt())),
});
export type LaunchProfile = typeof LaunchProfile.Type;

/** A pane Muster opened. Pane ids move; the terminal id proves it is still the same pane. */
export const PaneBinding = Schema.Struct({
  paneId: Schema.String,
  terminalId: Schema.String,
  tabId: Schema.String,
  openedByMuster: Schema.Boolean,
});
export type PaneBinding = typeof PaneBinding.Type;

export const Delivery = Schema.Literals(["none", "proven", "unproven"]);
export type Delivery = typeof Delivery.Type;

export const RestoreCommand = Schema.Struct({
  cwd: Path,
  argv: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
});
export type RestoreCommand = typeof RestoreCommand.Type;

export const AgentRow = Schema.Struct({
  name: AgentName,
  role: Role,
  lane: Slug,
  cwd: Path,
  /** Set when Muster allocated `cwd` as a rift clone; close removes it through worker-worktree.sh. */
  clone: Schema.NullOr(Schema.Struct({
    source: Path,
    branch: Schema.String,
    /** Proven starting commit; null only for rows from older catalogs. */
    base: Schema.NullOr(Schema.Struct({ ref: Schema.String, sha: Schema.String }))
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  })),
  profile: LaunchProfile,
  sessionId: SessionId,
  sessionFile: Schema.NullOr(Path),
  parentSessionFile: Schema.NullOr(Path),
  pane: Schema.NullOr(PaneBinding),
  owner: Schema.String,
  brief: Schema.NullOr(Path),
  state: AgentState,
  delivery: Delivery,
  restarts: Schema.Number,
  restore: Schema.NullOr(RestoreCommand),
  createdAt: Iso,
  updatedAt: Iso,
});
export type AgentRow = typeof AgentRow.Type;

export const CheckOutcome = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(["pass", "fail", "skip"]),
  detail: Schema.optionalKey(Schema.String),
});
export type CheckOutcome = typeof CheckOutcome.Type;

const GateFields = {
  runId: Schema.String,
  host: Schema.String,
  tree: Schema.String,
  slot: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  durationMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
};

/** Fleet-compute's receipt boundary; extra runner fields remain in the saved file. */
export const GateReceipt = Schema.Struct({
  ...GateFields,
  exit: Schema.NullOr(Schema.Number.check(Schema.isInt())),
  lostReason: Schema.optionalKey(Schema.String),
});
export type GateReceipt = typeof GateReceipt.Type;
export const PacketGate = Schema.Struct({ ...GateFields, receipt: Path });
export type PacketGate = typeof PacketGate.Type;

export const Packet = Schema.Struct({
  /** Full commit id or sha256 of the artifact. The packet's name. */
  id: Schema.String,
  kind: Schema.Literals(["commit", "artifact"]),
  lane: Slug,
  agent: AgentName,
  artifact: Schema.NullOr(Path),
  report: Path,
  checks: Schema.Array(CheckOutcome),
  state: PacketState,
  verification: Schema.NullOr(Schema.Struct({ at: Iso, checks: Schema.Array(CheckOutcome) })),
  landedAs: Schema.NullOr(Schema.String),
  gate: Schema.NullOr(PacketGate).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Earlier packet whose commit this follow-up includes. */
  supersedes: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** What the owner checked and where, when the packet was recorded without a merge. */
  evidence: Schema.optionalKey(Schema.String),
  reportedAt: Iso,
  updatedAt: Iso,
});
export type Packet = typeof Packet.Type;

export const Lane = Schema.Struct({
  slug: Slug,
  kind: Schema.Literals(["work", "role"]),
  label: Schema.String,
  goal: Schema.String,
  writeScope: Schema.Array(Schema.String),
  /** Source repo for this lane's clones and landings. Null means the project dir. */
  repo: Schema.NullOr(Path),
  /** Ref or sha worker clones start from; null uses the script's default branch. */
  base: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Path prefixes a clone may leave dirty without matching the source. */
  generated: Schema.Array(Schema.String),
  tabId: Schema.NullOr(Schema.String),
  root: Schema.NullOr(PaneBinding),
  state: LaneState,
  archived: Schema.Boolean,
  createdAt: Iso,
  updatedAt: Iso,
});
export type Lane = typeof Lane.Type;

export const Review = Schema.Struct({
  at: Iso,
  note: Schema.String,
  proposal: Schema.Literals(["continue", "split", "archive"]),
  decision: Schema.Literals(["continue", "split", "archive"]),
});

const Minutes = Schema.Number.check(Schema.isGreaterThan(0));

/** One role's launch defaults, partially overridden. Unset keys keep the built-in default. */
export const RolePolicy = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Thinking),
  compactAt: Schema.optionalKey(Schema.NullOr(Schema.Number.check(Schema.isInt()))),
  noSkills: Schema.optionalKey(Schema.Boolean),
});
export type RolePolicy = typeof RolePolicy.Type;

/**
 * A project's tuning. Muster ships defaults that fit most work; the owner
 * shapes them to the job with `project_update` instead of reading rules.
 */
export const Policy = Schema.Struct({
  /** Quiet minutes before the owner pass sends `esc` and a note. */
  nudgeAfterMin: Schema.optionalKey(Minutes),
  /** Quiet minutes before `/new` plus a re-prompt; null never restarts on its own. */
  restartAfterMin: Schema.optionalKey(Schema.NullOr(Minutes)),
  roles: Schema.optionalKey(
    Schema.Struct({
      desk: Schema.optionalKey(RolePolicy),
      hawk: Schema.optionalKey(RolePolicy),
      boss: Schema.optionalKey(RolePolicy),
      worker: Schema.optionalKey(RolePolicy),
      judge: Schema.optionalKey(RolePolicy),
    }),
  ),
});
export type Policy = typeof Policy.Type;

export const Project = Schema.Struct({
  version: Schema.Literal(1),
  slug: Slug,
  label: Schema.String,
  dir: Path,
  outcome: Schema.String,
  reviewTrigger: Schema.String,
  /** Board frontmatter type chosen to match the repo's Brain rules. */
  boardType: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("project"))),
  criticalPath: Schema.Array(Schema.String),
  nextAction: Schema.String,
  /** What the space is doing now, for the sidebar. Falls back to `nextAction`. */
  headline: Schema.optionalKey(Schema.NullOr(Schema.String)),
  policy: Schema.optionalKey(Policy),
  mode: Mode,
  spaceId: Schema.NullOr(Schema.String),
  /**
   * Herdr merges workspace tokens from every source, last writer wins. A
   * project publishes `progress`, `agents`, and `needs` only when it owns its
   * space, so adopting a shared space never overwrites another owner's sidebar.
   */
  sidebar: Schema.Literals(["owned", "off"]),
  /** Muster refuses state under a temp dir unless the project says it is throwaway. */
  ephemeral: Schema.Boolean,
  /** Extension path agents load for packet_report and compaction; null when Muster is installed in settings. */
  musterExtension: Schema.NullOr(Path),
  deskExtension: Schema.NullOr(Path),
  cadenceMinutes: Schema.NullOr(Schema.Number),
  state: ProjectState,
  lanes: Schema.Array(Lane),
  agents: Schema.Array(AgentRow),
  packets: Schema.Array(Packet),
  reviews: Schema.Array(Review),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Project = typeof Project.Type;

export const DeskKind = Schema.Literals(["decision", "approval", "blocked", "done", "fyi"]);
export type DeskKind = typeof DeskKind.Type;

/**
 * One line of the desk queue (dark-wizard `herdr/desk/queue.mjs` format). The
 * desk extension ignores fields it does not know, so `resolves` rides along
 * and closes an earlier decision, approval, or blocked item.
 */
export const DeskItem = Schema.Struct({
  id: Schema.String,
  ts: Iso,
  from: Schema.String,
  kind: DeskKind,
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  refs: Schema.optionalKey(Schema.Array(Schema.String)),
  resolves: Schema.optionalKey(Schema.String),
});
export type DeskItem = typeof DeskItem.Type;

export interface RoleDefaults {
  readonly model: string;
  readonly thinking: Thinking;
  /**
   * Compaction threshold as a cost policy. Every turn re-reads the whole
   * prefix from cache at 0.1x input price, so a lane that runs many turns pays
   * roughly `compactAt × 0.1` per turn; compaction trades one cold rebuild
   * (cacheWrite at 1.25x) for cheaper reads on every later turn.
   */
  readonly compactAt: number | null;
  readonly noSkills: boolean;
}

export const ROLE_DEFAULTS: Readonly<Record<Role, RoleDefaults>> = {
  desk: { model: "claude-bridge/claude-opus-5-5", thinking: "high", compactAt: 450_000, noSkills: false },
  hawk: { model: "claude-bridge/claude-opus-5-5", thinking: "high", compactAt: 450_000, noSkills: false },
  boss: { model: "claude-bridge/claude-opus-5-5", thinking: "high", compactAt: 400_000, noSkills: false },
  worker: { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium", compactAt: 300_000, noSkills: true },
  judge: { model: "claude-bridge/claude-fable-5-1", thinking: "high", compactAt: 350_000, noSkills: false },
};

/** A model a role may run instead of its default, with the jobs it suits. */
export const Alternate = Schema.Struct({
  model: Schema.String,
  thinking: Schema.optionalKey(Thinking),
  compactAt: Schema.optionalKey(Schema.NullOr(Schema.Number.check(Schema.isInt()))),
  noSkills: Schema.optionalKey(Schema.Boolean),
  useFor: Schema.Array(Schema.String),
  avoidFor: Schema.optionalKey(Schema.Array(Schema.String)),
  source: Schema.optionalKey(Schema.String),
});
export type Alternate = typeof Alternate.Type;

export const RosterRole = Schema.Struct({ ...RolePolicy.fields, alternates: Schema.optionalKey(Schema.Array(Alternate)) });
export type RosterRole = typeof RosterRole.Type;

/**
 * The fleet's role-to-model table (`~/.config/muster/roster.json`, or
 * `MUSTER_ROSTER`). Data, not code: change it once and every machine that
 * reads it launches differently on the next call.
 */
export const Roster = Schema.Struct({
  version: Schema.Literal(1),
  roles: Schema.Struct({
    desk: Schema.optionalKey(RosterRole),
    hawk: Schema.optionalKey(RosterRole),
    boss: Schema.optionalKey(RosterRole),
    worker: Schema.optionalKey(RosterRole),
    judge: Schema.optionalKey(RosterRole),
  }),
});
export type Roster = typeof Roster.Type;
export const decodeRoster = Schema.decodeUnknownSync(Roster);

export const DEFAULT_NUDGE_AFTER_MIN = 30;
export const DEFAULT_RESTART_AFTER_MIN = 60;

export interface SilenceLimits {
  readonly nudgeMs: number;
  /** null: never restart on silence alone. */
  readonly restartMs: number | null;
}

export function silenceLimits(policy: Policy | undefined): SilenceLimits {
  const nudge = policy?.nudgeAfterMin ?? DEFAULT_NUDGE_AFTER_MIN;
  const restart = policy?.restartAfterMin === undefined ? DEFAULT_RESTART_AFTER_MIN : policy.restartAfterMin;
  return { nudgeMs: nudge * 60_000, restartMs: restart === null ? null : Math.max(restart, nudge) * 60_000 };
}

/**
 * Built-in defaults, then the roster's role, then the alternate matching the
 * chosen model, then the project's policy. `model` is an explicit launch
 * choice; picking an alternate brings its settings (a smaller window's
 * compact-at, say) with it.
 */
export function roleDefaults(roster: Roster | undefined, policy: Policy | undefined, role: Role, model?: string): RoleDefaults {
  const { alternates = [], ...fleet } = roster?.roles?.[role] ?? {};
  const project = policy?.roles?.[role] ?? {};
  const chosen = model ?? project.model ?? fleet.model ?? ROLE_DEFAULTS[role].model;
  const { useFor: _use, avoidFor: _avoid, source: _source, ...alternate } = alternates.find((candidate) => candidate.model === chosen) ?? { useFor: [] };
  return { ...ROLE_DEFAULTS[role], ...fleet, ...alternate, ...project, model: chosen } as RoleDefaults;
}

/** Shallow per-role merge: a later patch overrides only the keys it names. */
export function mergePolicy(base: Policy | undefined, patch: Policy): Policy {
  const roles: Record<string, RolePolicy> = { ...(base?.roles ?? {}) };
  for (const [role, value] of Object.entries(patch.roles ?? {})) roles[role] = { ...(roles[role] ?? {}), ...value };
  return {
    ...(base ?? {}),
    ...(patch.nudgeAfterMin !== undefined ? { nudgeAfterMin: patch.nudgeAfterMin } : {}),
    ...(patch.restartAfterMin !== undefined ? { restartAfterMin: patch.restartAfterMin } : {}),
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
  };
}

/** The policy in force, every default spelled out, so an owner sees what it is tuning. */
export function effectivePolicy(roster: Roster | undefined, policy: Policy | undefined) {
  const limits = silenceLimits(policy);
  const roles = Object.fromEntries(
    Role.literals.map((role) => {
      const alternates = (roster?.roles?.[role]?.alternates ?? []).map(({ model, useFor, avoidFor }) => ({ model, useFor, ...(avoidFor ? { avoidFor } : {}) }));
      return [role, { ...roleDefaults(roster, policy, role), ...(alternates.length ? { alternates } : {}) }];
    }),
  );
  return { nudgeAfterMin: limits.nudgeMs / 60_000, restartAfterMin: limits.restartMs === null ? null : limits.restartMs / 60_000, roles };
}

export const decodePolicy = Schema.decodeUnknownSync(Policy);
export const decodeProject = Schema.decodeUnknownSync(Project);
export const decodeDeskItem = Schema.decodeUnknownSync(DeskItem);
export const decodeAgentName = Schema.decodeUnknownSync(AgentName);
export const decodeSlug = Schema.decodeUnknownSync(Slug);

const TEMP_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

/** `/tmp` dies on reboot; a pilot project lost every handoff and runner there. */
export function isTempPath(path: string): boolean {
  const withSlash = path.endsWith("/") ? path : `${path}/`;
  return TEMP_ROOTS.some((root) => withSlash.startsWith(root));
}
