import { Effect, Schema, SchemaTransformation } from "effect";
import { modelAliases, resolveModel } from "./models.ts";
import { POST_NSID, MENTION_NSID } from "./owner-lexicon.ts";

/**
 * Muster's domain values. Every file Muster reads or writes decodes through
 * these schemas, so a hand-edited or foreign `project.json` fails at the
 * boundary instead of deep inside an operation.
 *
 * A row's lifecycle mode is one machine state (see `machines.ts`). Nothing
 * else in a row restates it: no `status` next to `state`, no booleans that
 * shadow a state.
 */

/** Local command telemetry, not an admission contract. Terminal variants cannot look live. */
const JobFacts = {
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/u)),
  host: Schema.String, repo: Schema.String, cwd: Schema.String, command: Schema.String,
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  startedAt: Schema.String,
  tmpdir: Schema.optionalKey(Schema.String),
  cpuPercent: Schema.Number, rssKB: Schema.Number, peakRssKB: Schema.Number,
  cpuSeconds: Schema.Number, sampledAt: Schema.NullOr(Schema.Number),
};
export const HeavyJob = Schema.Union([
  Schema.Struct({ ...JobFacts, state: Schema.Literal("running") }),
  Schema.Struct({ ...JobFacts, state: Schema.Literal("finished"), exit: Schema.Number, wallMs: Schema.Number, finishedAt: Schema.String }),
  Schema.Struct({ ...JobFacts, state: Schema.Literal("lost"), exit: Schema.Null, lost: Schema.Literal(true), wallMs: Schema.Number, finishedAt: Schema.String }),
]);
export type HeavyJob = typeof HeavyJob.Type;
export const decodeHeavyJob = Schema.decodeUnknownSync(HeavyJob);
export const HeavySampleCache = Schema.Struct({
  sampledAt: Schema.Number,
  jobs: Schema.Record(Schema.String, Schema.Struct({ cpuPercent: Schema.Number, rssKB: Schema.Number, peakRssKB: Schema.Number, cpuSeconds: Schema.Number })),
});
export const decodeHeavySampleCache = Schema.decodeUnknownSync(HeavySampleCache);

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
/** Private machine configuration, never a catalog or package artifact. */
export const NetworkCommsConfig = Schema.Struct({
  endpoint: Schema.String.check(Schema.isPattern(/^https?:\/\//u)),
  serviceDid: Schema.String.check(Schema.isPattern(/^did:[^#]+$/u)),
  provisionWrapper: Schema.String.check(Schema.isPattern(/^\//u)),
  didTemplate: Schema.String.check(Schema.isPattern(/^did:web:[^#]*\{agent\}[^#]*$/u)),
  secretsCommand: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\//u))),
});
export type NetworkCommsConfig = typeof NetworkCommsConfig.Type;
export const decodeNetworkCommsConfig = Schema.decodeUnknownSync(NetworkCommsConfig);
/** Private consumer snapshot borrowed by detached senders; never a lease acquisition. */
export const NetworkSendFence = Schema.Struct({
  did: Schema.String.check(Schema.isPattern(/^did:[^#]+$/u)),
  leaseId: Schema.String.check(Schema.isMinLength(1)),
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const decodeNetworkSendFence = Schema.decodeUnknownSync(NetworkSendFence);
const PublicCommsKey = Schema.Struct({ kty: Schema.Literal("EC"), crv: Schema.Literal("P-256"), x: Schema.String, y: Schema.String, d: Schema.optionalKey(Schema.Never) });
const CommsDocument = Schema.Struct({
  id: Schema.String,
  verificationMethod: Schema.Array(Schema.Struct({ id: Schema.String, controller: Schema.String, publicKeyJwk: PublicCommsKey })),
  authentication: Schema.Array(Schema.String),
  keyAgreement: Schema.Array(Schema.String),
});
export const CommsIdentityReference = Schema.Struct({
  did: Schema.String.check(Schema.isPattern(/^did:web:/u)),
  secret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]+$/u)),
  document: CommsDocument,
});
export type CommsIdentityReference = typeof CommsIdentityReference.Type;
export const decodeCommsIdentityReference = Schema.decodeUnknownSync(CommsIdentityReference);
export const decodeCommsIdentityCache = Schema.decodeUnknownSync(Schema.Record(AgentName, CommsIdentityReference));

export const OwnerKind = Schema.Literals(["fyi", "progress", "done", "question", "blocked", "action"]);
export type OwnerKind = typeof OwnerKind.Type;
const StrongRef = Schema.Struct({ uri: Schema.String, cid: Schema.String });
export const OwnerItem = Schema.Struct({
  $type: Schema.Literal(POST_NSID), uri: Schema.String, cid: Schema.String,
  author: SessionId, createdAt: Schema.String, text: Schema.String, kind: OwnerKind,
  signed: Schema.optionalKey(Schema.Unknown),
  /** Missing on legacy posts: those never follow a project-scoped forward. */
  project: Schema.optionalKey(Schema.String),
  /** Optional cached delivery metadata; older queues usually contain only the post. */
  delivery: Schema.optionalKey(Schema.Struct({
    status: Schema.Literals(["accepted", "queued", "delivered", "acked", "expired", "failed"]),
    detail: Schema.optionalKey(Schema.String),
  })),
  lane: Schema.optional(Schema.String), refs: Schema.optional(Schema.Array(Schema.String)),
  reply: Schema.optional(Schema.Struct({ root: StrongRef, parent: StrongRef })),
  facets: Schema.optional(Schema.Array(Schema.Struct({
    index: Schema.Struct({ byteStart: Schema.Number, byteEnd: Schema.Number }),
    features: Schema.Array(Schema.Struct({ $type: Schema.Literal(MENTION_NSID), did: SessionId })),
  }))),
});
export type OwnerItem = typeof OwnerItem.Type;
export const decodeNetworkPayload = Schema.decodeUnknownSync(Schema.Union([
  Schema.Struct({ type: Schema.Literal("owner"), recipient: SessionId, item: OwnerItem }),
  Schema.Struct({ type: Schema.Literal("message"), recipient: SessionId, author: SessionId, body: Schema.String }),
]));
export type NetworkPayload = ReturnType<typeof decodeNetworkPayload>;
export const decodeNetworkPeers = Schema.decodeUnknownSync(Schema.Record(SessionId, AgentName));
export const decodeNetworkCursors = Schema.decodeUnknownSync(Schema.Record(AgentName, Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))));
const decodeOwnerRecord = Schema.decodeUnknownSync(OwnerItem);
/** Normalize legacy receipt metadata on read; never rewrite the JSONL or its CID. */
export function decodeOwnerItem(input: unknown): OwnerItem {
  if (typeof input === "object" && input !== null && "delivery" in input &&
    typeof input.delivery === "object" && input.delivery !== null && "status" in input.delivery) {
    const old = input.delivery.status;
    const status = old === "sent" ? "delivered" : old === "rejected" || old === "blocked" || old === "unavailable" ? "failed" : old;
    return decodeOwnerRecord({ ...input, delivery: { ...input.delivery, status } });
  }
  return decodeOwnerRecord(input);
}
export const OwnerReader = Schema.Struct({ pid: Schema.Number, startedAt: Schema.String, heartbeatAt: Schema.String });
export const decodeOwnerReader = Schema.decodeUnknownSync(OwnerReader);
export const OwnerRouting = Schema.Struct({ via: Schema.Record(Schema.String, SessionId), mentioned: Schema.Array(Schema.String) });
export const decodeOwnerRouting = Schema.decodeUnknownSync(OwnerRouting);
const OwnerLine = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const OwnerForward = Schema.Struct({ to: SessionId, at: Schema.String, project: Schema.String, cursor: OwnerLine, heartbeatAt: Schema.optional(Schema.String) });
export const decodeOwnerForward = Schema.decodeUnknownSync(OwnerForward);
export const OwnerCursor = Schema.Struct({ cursor: OwnerLine, delivered: Schema.Array(Schema.String), sources: Schema.optional(Schema.Record(SessionId, OwnerLine)) });
export const decodeOwnerCursor = Schema.decodeUnknownSync(OwnerCursor);
export const decodeOwnerSession = Schema.decodeUnknownSync(SessionId);
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

const RemotePath = Schema.String.check(Schema.isPattern(/^\/[^\x00-\x1f\x7f]*$/));
export const MachineConfig = Schema.Struct({
  herdr: Schema.String,
  maxPanes: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  ssh: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/)),
  paths: Schema.Record(RemotePath, RemotePath),
  musterExtension: RemotePath,
  workerWorktree: RemotePath,
  env: Schema.Record(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)), Schema.String),
  wrap: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  socket: RemotePath.pipe(Schema.withDecodingDefaultKey(Effect.succeed("/home/joel/.config/herdr/herdr.sock"))),
  comms: Schema.optionalKey(Schema.Struct({ config: RemotePath })),
});
export type MachineConfig = typeof MachineConfig.Type;
export const decodeMachines = Schema.decodeUnknownSync(Schema.Record(AgentName, MachineConfig));

export const AgentLaunchRequest = Schema.Struct({
  action: Schema.Literals(["launch", "fork", "restore", "adopt", "restart"]),
  name: AgentName,
  machine: Schema.optional(Schema.String), role: Schema.optional(Role), lane: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String), cwd: Schema.optional(Schema.String), clone: Schema.optional(Schema.Boolean),
  hydrate: Schema.optional(Schema.Boolean),
  from: Schema.optional(Schema.String), side: Schema.optional(Schema.Boolean), at: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String), thinking: Schema.optional(Thinking),
  appendSystemPrompt: Schema.optional(Schema.Array(Schema.String)), skills: Schema.optional(Schema.Array(Schema.String)),
  noSkills: Schema.optional(Schema.Boolean), extensions: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)), compactAt: Schema.optional(Schema.NullOr(Schema.Number)),
  brief: Schema.optional(Schema.String), prompt: Schema.optional(Schema.String), pane: Schema.optional(Schema.String),
  slot: Schema.optional(Schema.Literals(["root", "split"])),
});
export const decodeAgentLaunchRequest = Schema.decodeUnknownSync(AgentLaunchRequest);
export const LaunchJobState = Schema.Literals(["queued", "running", "succeeded", "failed"]);
export type LaunchJobState = typeof LaunchJobState.Type;
export const LaunchJobId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/));
export const decodeLaunchJobId = Schema.decodeUnknownSync(LaunchJobId);
export const LaunchJob = Schema.Struct({
  id: LaunchJobId, project: Slug, name: AgentName, sessionId: SessionId,
  pid: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))), log: Path, startedAt: Iso, state: LaunchJobState,
  priorState: AgentState, owner: SessionId, request: AgentLaunchRequest,
  outcome: Schema.optionalKey(Schema.Literals(["action", "blocked"])),
});
export type LaunchJob = typeof LaunchJob.Type;
export const decodeLaunchJob = Schema.decodeUnknownSync(LaunchJob);

export const AgentRow = Schema.Struct({
  machine: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("local"))),
  intercomAddress: Schema.optionalKey(Schema.String),
  events: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.String, at: Iso, detail: Schema.String }))),
  name: AgentName,
  role: Role,
  /** Design-only desk, sharing its parent's lane; absent in older catalogs. */
  side: Schema.NullOr(Schema.Struct({ parent: AgentName })).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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
  // Null when the host doesn't say which slot it took (Flagg wraps muster-heavy).
  slot: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
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
  /** Owner vouched for this landing instead of proving packet equivalence. Absent in old catalogs. */
  attested: Schema.optionalKey(Schema.Boolean),
  /** Missing in old files means never checked. */
  autolandCheckedAt: Schema.optionalKey(Iso),
  gate: Schema.NullOr(PacketGate).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Earlier packet whose commit this follow-up includes. */
  supersedes: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** What the owner checked and where, when the packet was recorded without a merge. */
  evidence: Schema.optionalKey(Schema.String),
  reportedAt: Iso,
  updatedAt: Iso,
});
export type Packet = typeof Packet.Type;

/** Append-only correction sidecar; not part of the versioned catalog. */
const LandingOutcome = Schema.Literals(["committed", "rejected", "no_changes"]);
export const PacketCorrection = Schema.Struct({
  packetId: Schema.String,
  at: Iso,
  by: Schema.String,
  from: Schema.Struct({
    state: LandingOutcome,
    outcome: LandingOutcome,
    landedAs: Schema.NullOr(Schema.String),
    evidence: Schema.NullOr(Schema.String),
  }),
  reason: Schema.String.check(Schema.isMinLength(1)),
});
export const decodePacketCorrection = Schema.decodeUnknownSync(PacketCorrection);
export const RemotePacket = Schema.Struct({ project: Slug, machine: Schema.String, packet: Packet, reportText: Schema.String });
export const decodeRemotePacket = Schema.decodeUnknownSync(RemotePacket);
export const decodeAgentRow = Schema.decodeUnknownSync(AgentRow);

/** Read-only projection of Pi's append-only session journal, not a catalog field. */
export const decodeFirstTurnEntry = Schema.decodeUnknownSync(Schema.Struct({
  type: Schema.String,
  message: Schema.optionalKey(Schema.Struct({
    role: Schema.String,
    content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }))])),
    stopReason: Schema.optionalKey(Schema.String),
    errorMessage: Schema.optionalKey(Schema.String),
  })),
}));
export const decodeSessionSlice = Schema.decodeUnknownSync(Schema.Struct({ size: Schema.Number, text: Schema.String }));
export const decodeSessionEntryCount = Schema.decodeUnknownSync(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

export const LaneDelivery = Schema.Literals(["none", "landed", "deployed", "proven", "waived"]);
export type LaneDelivery = typeof LaneDelivery.Type;

export const DeployLevel = Schema.Literals([0, 1, 2, 3]);
export type DeployLevel = typeof DeployLevel.Type;
export const decodeDeployLevel = Schema.decodeUnknownSync(DeployLevel);
export const DEPLOY_RULE_CAPS = {
  "customer-facing": 1, money: 1, "outbound-sends": 1,
  irreversible: 0, "shared-infra": 2, "slow-rollback": 1,
} as const;
export const DeployRule = Schema.Literals(["customer-facing", "money", "outbound-sends", "irreversible", "shared-infra", "slow-rollback"]);
export const decodeDeployRule = Schema.decodeUnknownSync(DeployRule);
export const DEPLOY_NAMES = ["locked", "prove", "ship-and-watch", "jfdi"] as const;
export const DEPLOY_SECTION = "## Deploy posture\nLevel: 1 (prove)\nLive proof frees the slot.";

/** A malformed section never loosens the policy fallback. */
export function decodeDeploySection(text: unknown): { level?: DeployLevel; issue?: string; missing: boolean } {
  const vision = Schema.decodeUnknownSync(Schema.String)(text);
  const section = /^## Deploy posture[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(vision);
  if (!section) return /^## Deploy posture[ \t]*$/m.test(vision)
    ? { missing: false, issue: "malformed Deploy posture: missing Level line" } : { missing: true };
  const first = section[1]?.trim().split(/\r?\n/)[0] ?? "";
  const match = /^Level: ([0-3])(?: \((locked|prove|ship-and-watch|jfdi)\))?$/.exec(first);
  if (!match) return { missing: false, issue: "malformed Deploy posture: expected Level: <0-3> (<name>)" };
  const level = decodeDeployLevel(Number(match[1]));
  if (match[2] && match[2] !== DEPLOY_NAMES[level]) return { missing: false, issue: "malformed Deploy posture: level and name differ" };
  return { level, missing: false };
}

export const Lane = Schema.Struct({
  slug: Slug,
  kind: Schema.Literals(["work", "role", "retro"]),
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
  /** Stable retro cursor; older catalogs fall back to updatedAt. */
  closedAt: Schema.optionalKey(Iso),
  /** Explicitly dropped from the proposed backlog, not finished work. */
  discarded: Schema.optionalKey(Schema.Boolean),
  deployLevel: Schema.optionalKey(DeployLevel),
  deployRule: Schema.optionalKey(DeployRule),
  delivery: Schema.optionalKey(LaneDelivery),
  deliveryAt: Schema.optionalKey(Iso),
  deliveryEvidence: Schema.optionalKey(Schema.String),
  deliveryHistory: Schema.optionalKey(Schema.Array(Schema.Struct({ stage: LaneDelivery, at: Iso, evidence: Schema.String }))),
  override: Schema.optionalKey(Schema.String),
  rank: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  /** Successful opening time, distinct from time spent in the proposed backlog. */
  openedAt: Schema.optionalKey(Iso),
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
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type RolePolicy = typeof RolePolicy.Type;

/**
 * A project's tuning. Muster ships defaults that fit most work; the owner
 * shapes them to the job with `project_update` instead of reading rules.
 */
export const Policy = Schema.Struct({
  deployLevel: Schema.optionalKey(DeployLevel),
  wipLimit: Schema.optionalKey(Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)))),
  flowStallMin: Schema.optionalKey(Minutes),
  landWaitMin: Schema.optionalKey(Minutes),
  comms: Schema.Literals(["intercom", "network"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("intercom" as const))),
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
/** Policy patches omit comms; persisted policies decode it to intercom. */
export type Policy = Partial<Pick<typeof Policy.Type, "comms">> & Omit<typeof Policy.Type, "comms">;

const ProjectFields = Schema.Struct({
  version: Schema.Literal(1),
  /** Writer capability, separate from file format; newer catalogs remain readable. */
  writerSchemaVersion: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
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
  lastRetroAt: Schema.optionalKey(Iso),
  createdAt: Iso,
  updatedAt: Iso,
});
// done-live shipped in 81f5baf; earlier committed work predates the live-proof rule.
const DONE_LIVE_CUTOFF = Date.parse("2026-10-05T04:14:03Z");

export const Project = ProjectFields.pipe(Schema.decode(SchemaTransformation.transform({
  decode: (project): typeof ProjectFields.Type => ({ ...project, lanes: project.lanes.map(lane => {
    if (lane.delivery !== undefined) return lane;
    const committed = project.packets.filter(packet => packet.lane === lane.slug && packet.state === "committed");
    const at = committed.map(packet => packet.updatedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    if (!at) return { ...lane, delivery: "none" as const };
    const delivery = Date.parse(at) < DONE_LIVE_CUTOFF ? "proven" as const : "landed" as const;
    const evidence = delivery === "proven" ? "before done-live" : "delivery record missing (written by an older Muster); not proven";
    return { ...lane, delivery, deliveryAt: at, deliveryEvidence: evidence, deliveryHistory: [{ stage: delivery, at, evidence }] };
  }) }),
  encode: (project) => project,
})));
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
  readonly skills?: readonly string[];
}

export const ROLE_DEFAULTS: Readonly<Record<Role, RoleDefaults>> = {
  desk: { model: "claude-bridge/claude-opus-5-5", thinking: "high", compactAt: 450_000, noSkills: false },
  hawk: { model: "claude-bridge/claude-opus-5-5", thinking: "high", compactAt: 450_000, noSkills: false },
  boss: { model: "claude-bridge/claude-opus-5-5", thinking: "high", compactAt: 400_000, noSkills: false },
  worker: { model: "openai-codex/gpt-6.1-sol", thinking: "medium", compactAt: 200_000, noSkills: true },
  judge: { model: "claude-bridge/claude-opus-5-5", thinking: "high", compactAt: 350_000, noSkills: false },
};

/** A model a role may run instead of its default, with the jobs it suits. */
export const Alternate = Schema.Struct({
  model: Schema.String,
  thinking: Schema.optionalKey(Thinking),
  compactAt: Schema.optionalKey(Schema.NullOr(Schema.Number.check(Schema.isInt()))),
  noSkills: Schema.optionalKey(Schema.Boolean),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
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
  aliases: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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

/** Only the settings field used by skill discovery; other Pi settings stay Pi's. */
export const SkillSettings = Schema.Struct({ skills: Schema.optionalKey(Schema.Array(Schema.String)) });
export const decodeSkillSettings = Schema.decodeUnknownSync(SkillSettings);

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
export function roleDefaults(roster: Roster | undefined, policy: Policy | undefined, role: Role, model?: string, slug?: string): RoleDefaults {
  const { alternates = [], ...fleet } = roster?.roles?.[role] ?? {};
  const project = policy?.roles?.[role] ?? {};
  // Role exceptions are opt-in: only an explicit launch choice can use one, never a policy or fleet default.
  const resolved = resolveModel(model ?? project.model ?? fleet.model ?? ROLE_DEFAULTS[role].model, roster, slug, model === undefined ? undefined : role);
  const chosen = resolved.model;
  const { useFor: _use, avoidFor: _avoid, source: _source, ...alternate } = alternates.find((candidate) => { try { return resolveModel(candidate.model, roster, slug, role).model === chosen; } catch { return false; } }) ?? { useFor: [] };
  return { ...ROLE_DEFAULTS[role], ...fleet, ...alternate, ...project, model: chosen, ...(resolved.thinking ? { thinking: resolved.thinking } : {}),
    skills: [...new Set([...(fleet.skills ?? []), ...("skills" in alternate ? alternate.skills ?? [] : []), ...(project.skills ?? [])])],
  };
}

/** Shallow per-role merge: a later patch overrides only the keys it names. */
export function mergePolicy(base: Policy | undefined, patch: Policy): typeof Policy.Type {
  const roles: Record<string, RolePolicy> = { ...(base?.roles ?? {}) };
  for (const [role, value] of Object.entries(patch.roles ?? {})) roles[role] = { ...(roles[role] ?? {}), ...value };
  return {
    ...(base ?? {}),
    comms: patch.comms ?? base?.comms ?? "intercom",
    ...(patch.deployLevel !== undefined ? { deployLevel: patch.deployLevel } : {}),
    ...(patch.wipLimit !== undefined ? { wipLimit: patch.wipLimit } : {}),
    ...(patch.flowStallMin !== undefined ? { flowStallMin: patch.flowStallMin } : {}),
    ...(patch.landWaitMin !== undefined ? { landWaitMin: patch.landWaitMin } : {}),
    ...(patch.nudgeAfterMin !== undefined ? { nudgeAfterMin: patch.nudgeAfterMin } : {}),
    ...(patch.restartAfterMin !== undefined ? { restartAfterMin: patch.restartAfterMin } : {}),
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
  };
}

/** The policy in force, every default spelled out, so an owner sees what it is tuning. */
export function effectivePolicy(roster: Roster | undefined, policy: Policy | undefined, project?: string) {
  const limits = silenceLimits(policy);
  const roles = Object.fromEntries(
    Role.literals.map((role) => {
      const alternates = (roster?.roles?.[role]?.alternates ?? []).map(({ model, useFor, avoidFor, skills }) => ({ model, useFor, ...(avoidFor ? { avoidFor } : {}), ...(skills ? { skills } : {}) }));
      return [role, { ...roleDefaults(roster, policy, role, undefined, project), ...(alternates.length ? { alternates } : {}) }];
    }),
  );
  return { deployLevel: policy?.deployLevel ?? 1, wipLimit: policy?.wipLimit === undefined ? 3 : policy.wipLimit, flowStallMin: policy?.flowStallMin ?? 120, landWaitMin: policy?.landWaitMin ?? 30, comms: policy?.comms ?? "intercom", aliases: modelAliases(roster), nudgeAfterMin: limits.nudgeMs / 60_000, restartAfterMin: limits.restartMs === null ? null : limits.restartMs / 60_000, roles };
}

export const decodePolicy = Schema.decodeUnknownSync(Schema.Struct({ ...Policy.fields, comms: Schema.optionalKey(Schema.Literals(["intercom", "network"])) }));
export const decodeProject = Schema.decodeUnknownSync(Project);
export const decodeDeskItem = Schema.decodeUnknownSync(DeskItem);
export const decodeAgentName = Schema.decodeUnknownSync(AgentName);
export const decodeSlug = Schema.decodeUnknownSync(Slug);

const TEMP_ROOTS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", "/Volumes/gate-tmp/"];

/** `/tmp` dies on reboot; a pilot project lost every handoff and runner there. */
export function isTempPath(path: string): boolean {
  const withSlash = path.endsWith("/") ? path : `${path}/`;
  return TEMP_ROOTS.some((root) => withSlash.startsWith(root));
}
