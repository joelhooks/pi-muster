import { randomUUID } from "node:crypto";
import { deskWriteId, watchEntries, withDeskWrites } from "./relay-events.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrClient } from "@joelhooks/pi-bellwether/herdr-client";
import { Cause, Effect, Exit, Layer } from "effect";
import { Type } from "typebox";

import { registerCompaction } from "./compact.ts";
import { agentRewind, registerWorkerNavigation } from "./rewind.ts";
import { MAX_CADENCE_MINUTES } from "./domain.ts";
import { createComms } from "./comms.ts";
import {
  agentClose,
  agentLaunch,
  deskPost,
  laneClose,
  laneOpen,
  laneDeliver,
  packetLand,
  packetReport,
  packetVerify,
  projectOpen,
  projectMove,
  projectReview,
  projectStatus,
  projectUpdate,
} from "./ops.ts";
import { Herdr, Comms, MusterEnv, Proc, liveProc, createEmitPaneClose } from "./runtime.ts";
import { registerDeskFeed } from "./desk-feed-ext.ts";
import { registerOwnerFeed } from "./owner-feed-ext.ts";
import { ownerLine, ownerReceipt, ownerToolResult } from "./owner-view.ts";
import { capBody, deliverOwnerItem, findOwnerPost } from "./owner-queue.ts";
import { registerDeskReport } from "./desk-report-ext.ts";
import { registerDigest } from "./digest-ext.ts";
import { registerSwitchboard } from "./switchboard-ext.ts";
import { findSkills, skillIndex } from "./skills.ts";
import { createVersionSkew, withVersionSkew } from "./version-skew.ts";
import { squashed } from "./readable.ts";

const MUSTER_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_WORKER_WORKTREE = join(homedir(), "Code", "joelhooks", "dark-wizard", "scripts", "worker-worktree.sh");

type Services = Herdr | Proc | MusterEnv | Comms;

const text = (body: string, details: unknown) => ({ content: [{ type: "text" as const, text: body }], details });

function failure(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause) as { _tag?: string; message?: string } & Record<string, unknown>;
  const tag = typeof error?._tag === "string" ? error._tag : "Defect";
  const message = typeof error?.message === "string" ? error.message : String(error);
  const extra = Array.isArray(error?.failures) ? `\n${(error.failures as string[]).map((line) => `- ${line}`).join("\n")}` : "";
  return {
    content: [{ type: "text" as const, text: `${tag}: ${message}${extra}` }],
    details: { ok: false, error: JSON.parse(JSON.stringify({ ...error, _tag: tag, message })) as unknown },
    isError: true as const,
  };
}

const READABLE_HINT = "Rewrite in plain sentences with spaces between words; put code, paths and ids in backticks.";

function unreadable(fields: readonly (string | undefined)[]) {
  const samples = fields.flatMap(field => {
    if (field === undefined) return [];
    const result = squashed(field);
    return result.ok ? [] : result.samples;
  });
  if (!samples.length) return undefined;
  const message = `Squashed text: ${[...new Set(samples)].slice(0, 3).map(sample => JSON.stringify(sample)).join(", ")}. ${READABLE_HINT}`;
  return { ...text(message, { ok: false, samples: samples.slice(0, 3) }), isError: true as const };
}

export default function muster(host: ExtensionAPI) {
  const pi = withDeskWrites(withVersionSkew(host, createVersionSkew({ root: MUSTER_ROOT })));
  const env = process.env;
  const role = env.MUSTER_ROLE;
  const worker = role === "worker";
  const comms = new Map<string, ReturnType<typeof createComms>>();

  registerCompaction(pi, env);

  const layer = (ctx: ExtensionContext) =>
    Layer.mergeAll(
      Layer.succeed(Herdr)(createHerdrClient()),
      Layer.succeed(Proc)(liveProc),
      Layer.succeed(MusterEnv)({
        home: homedir(),
        now: () => new Date(),
        sessionId: ctx.sessionManager.getSessionId(),
        paneId: env.HERDR_PANE_ID,
        musterRoot: MUSTER_ROOT,
        workerWorktree: env.MUSTER_WORKER_WORKTREE ?? DEFAULT_WORKER_WORKTREE,
        createId: () => deskWriteId(randomUUID()),
        sleep: (ms) => Effect.sleep(ms),
        emitPaneClose: createEmitPaneClose(pi.events),
      }),
      Layer.succeed(Comms)((() => {
        const dir = resolve(env.MUSTER_PROJECT ?? ctx.cwd);
        let service = comms.get(dir);
        if (!service) {
          service = createComms({ events: pi.events, createId: randomUUID, home: homedir(), projectDir: dir, adapterEnv: () => env.MUSTER_COMMS });
          comms.set(dir, service);
        }
        return service;
      })()),
    );

  const run = async <A>(ctx: ExtensionContext, signal: AbortSignal | undefined, program: Effect.Effect<A, unknown, Services>, render: (value: A) => string) => {
    const exit = await watchEntries.run(ctx.sessionManager.getBranch(), () => Effect.runPromiseExit(program.pipe(Effect.provide(layer(ctx))), signal ? { signal } : undefined));
    if (Exit.isSuccess(exit)) return text(render(exit.value), JSON.parse(JSON.stringify(exit.value)) as unknown);
    return failure(exit.cause);
  };

  const projectDir = (ctx: ExtensionContext, project: string | undefined) => resolve(project ?? env.MUSTER_PROJECT ?? ctx.cwd);
  const ProjectParam = Type.Optional(Type.String({ description: "Project dir (absolute). Default: MUSTER_PROJECT, then cwd." }));

  pi.on("tool_call", event => {
    if (!env.MUSTER_AGENT || !env.MUSTER_PROJECT || !env.MUSTER_ROLE || event.toolName !== "intercom") return;
    if (!["send", "ask", "reply"].includes(String(event.input.action)) || typeof event.input.message !== "string") return;
    const error = unreadable([event.input.message]);
    if (error) return { block: true, reason: error.content[0]!.text };
  });

  pi.on("session_shutdown", () => {
    for (const service of comms.values()) service.dispose();
    comms.clear();
  });

  registerOwnerFeed(pi, env);

  if ((worker || role === "boss") && env.MUSTER_OWNER) {
    pi.registerTool({
      name: "owner_note", label: "Muster owner note",
      description: "Post FYI, progress or done silently to your owner's queue. question and blocked mention and wake the owner. Use replyTo to thread a post. packet_report stays the single finish report.",
      renderCall: (args, theme) => ownerLine(`🐦 owner note · ${args.kind} "${args.title}"`, theme),
      renderResult(result, options, theme) {
        if (options.isPartial) return ownerLine("🐦 posting owner note…", theme);
        return ownerToolResult(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), options.expanded, theme);
      },
      parameters: Type.Object({ kind: StringEnum(["fyi", "progress", "done", "question", "blocked"] as const), title: Type.String(), body: Type.Optional(Type.String()), refs: Type.Optional(Type.Array(Type.String())), replyTo: Type.Optional(Type.String()) }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const error = unreadable([params.title, params.body]);
        if (error) return error;
        const session = ctx.sessionManager.getSessionId();
        if (params.replyTo) findOwnerPost(session, params.replyTo);
        return run(ctx, signal, deliverOwnerItem({ owner: env.MUSTER_OWNER!, agent: env.MUSTER_AGENT, home: homedir(), session, project: env.MUSTER_PROJECT ?? "", item: { ...params, author: session, lane: env.MUSTER_LANE }, send: (to, message) => Effect.flatMap(Comms, service => service.send(to, message)) }), result => `${result.pendingPull ? "🐦 Queued for the Flagg owner to pull; not delivered." : ownerReceipt({ kind: params.kind, title: params.title, ...result })}\nuri: ${result.uri ?? "not queued"} · owner: ${result.owner} (${result.resolution}) · delivery: ${result.delivery.status}${result.delivery.detail ? ` · ${result.delivery.detail}` : ""}`);
      },
    });
  }
  pi.registerTool({
    name: "owner_reply", label: "Muster owner reply",
    description: "Reply to a post in your own owner queue. Threads root and parent, mentions the author and writes to their queue; wakes them when idle. No path to Joel's desk queue.",
    renderCall: (args, theme) => ownerLine(`🐦 owner reply · "${args.text.split("\n")[0]}"`, theme),
    renderResult(result, options, theme) {
      if (options.isPartial) return ownerLine("🐦 posting owner reply…", theme);
      return ownerToolResult(result.content.filter(c => c.type === "text").map(c => c.text).join("\n"), options.expanded, theme);
    },
    parameters: Type.Object({ uri: Type.String(), text: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const error = unreadable([params.text]);
      if (error) return error;
      const session = ctx.sessionManager.getSessionId();
      const parent = findOwnerPost(session, params.uri);
      const body = capBody(params.text);
      return run(ctx, signal, deliverOwnerItem({ owner: parent.author, home: homedir(), session, project: env.MUSTER_PROJECT ?? "", item: { author: session, lane: env.MUSTER_LANE, kind: "fyi", title: body.split("\n")[0] ?? "Reply", body, text: body, replyTo: parent.uri, mention: parent.author }, send: (to, message) => Effect.flatMap(Comms, service => service.send(to, message)) }), result => `${ownerReceipt({ kind: "reply", title: body.split("\n")[0] ?? "Reply", ...result })}\nuri: ${result.uri ?? "not queued"} · reply to: ${parent.uri} · recipient: ${parent.author} · delivery: ${result.delivery.status}${result.delivery.detail ? ` · ${result.delivery.detail}` : ""}`);
    },
  });

  if (env.MUSTER_AGENT && env.MUSTER_PROJECT && env.MUSTER_OWNER) {
    const agent = env.MUSTER_AGENT;
    const project = env.MUSTER_PROJECT;
    const owner = env.MUSTER_OWNER;
    pi.registerTool({
      name: "packet_report",
      label: "Muster packet report",
      description:
        "Report your one finished packet to your owner: a commit (or an artifact file) plus the checks you ran. Writes the report file, records the packet, and queues an action mentioning your owner (intercom fallback for old or unavailable readers). Call it once, after committing. It is your only report channel.",
      promptSnippet: "packet_report: report your committed result and checks to your owner, once",
      parameters: Type.Object({
        commit: Type.Optional(Type.String({ description: "Commit id or ref in your checkout" })),
        artifact: Type.Optional(Type.String({ description: "Absolute path of an artifact file, instead of a commit" })),
        summary: Type.String({ description: "What the packet does, in a few plain sentences" }),
        checks: Type.Array(
          Type.Object({
            name: Type.String(),
            outcome: StringEnum(["pass", "fail", "skip"] as const),
            detail: Type.Optional(Type.String()),
          }),
          { description: "Each check you ran and its outcome" },
        ),
        deploy: Type.Optional(Type.String({ description: "How this goes live, including flag state and rollback" })),
        proof: Type.Optional(Type.String({ description: "Live check the owner should run" })),
        signals: Type.Optional(Type.Object({ working: Type.String(), failing: Type.String(), where: Type.String() })),
        body: Type.Optional(Type.String({ description: "Extra notes: open questions with a recommendation, risks" })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const error = unreadable([params.summary, params.body, params.deploy, params.proof, params.signals?.working, params.signals?.failing, params.signals?.where, ...params.checks.flatMap(check => [check.name, check.detail])]);
        if (error) return error;
        return run(
          ctx,
          signal,
          packetReport({ dir: project, agent, owner, cwd: ctx.cwd, ...params }),
          (result) =>
            `Packet ${result.packet.id.slice(0, 12)} reported (${result.packet.state}). Report: ${result.packet.report}. Owner notified: ${result.delivery.status}${result.delivery.detail ? ` (${result.delivery.detail})` : ""}.`,
        );
      },
    });
  }

  pi.registerTool({
    name: "skill_find",
    label: "Find skills",
    description: "Search every installed skill by task words; read the SKILL.md of any match before using it.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Integer({ default: 5, minimum: 1, maximum: 10 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const matches = findSkills({ skills: skillIndex({ cwd: ctx.cwd }), ...params });
      return text(matches.length ? matches.map((skill) => `${skill.name}: ${skill.description}\n${skill.path}`).join("\n\n") : "No matching skills.", { matches });
    },
  });

  registerWorkerNavigation(pi, worker);

  if (worker) return;

  pi.registerTool({
    name: "thinking_set",
    label: "Muster thinking level",
    description:
      "Set this session's own thinking level from its next model call. A standing Hawk drops to low when the line stops and sets it back at resume; any owner can lower it for quiet watch duty. The model may clamp the level.",
    parameters: Type.Object({ level: StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const) }),
    async execute(_id, params) {
      const before = pi.getThinkingLevel();
      pi.setThinkingLevel(params.level);
      const after = pi.getThinkingLevel();
      return text(
        `Thinking ${before} → ${after}${after === params.level ? "" : ` (this model clamps ${params.level} to ${after})`}, from the next model call.`,
        { before, after },
      );
    },
  });

  registerDeskFeed(pi, env);
  registerSwitchboard(pi, { env, layer, run });
  registerDeskReport(pi, { run });
  registerDigest(pi, env);

  pi.registerTool({
    name: "project_open",
    label: "Muster project open",
    description:
      "Set up or adopt a Muster project: outcome, review trigger, critical path, next action, landing mode, and its Herdr space (space = project). Writes <project>/.brain/data/muster/project.json and a Brain board, and publishes the progress, agents, and needs tokens. desk: true opens the 💬 desk lane. cadenceMinutes records the owner pass interval and returns the exact pi-until repeat call to arm it; nothing starts on its own.",
    promptSnippet: "project_open: set up or adopt a Muster project space",
    promptGuidelines: [
      "After project_open returns a cadence call, arm it with until action=repeat using exactly those arguments. Muster owns no clock.",
    ],
    parameters: Type.Object({
      project: ProjectParam,
      slug: Type.Optional(Type.String({ description: "kebab-case project id; required for a new project" })),
      boardType: Type.Optional(Type.String({ description: "Brain board frontmatter type; defaults to project. Set it to a type allowed by this repo." })),
      label: Type.Optional(Type.String({ description: "Space label in plain words" })),
      outcome: Type.Optional(Type.String()),
      reviewTrigger: Type.Optional(Type.String()),
      criticalPath: Type.Optional(Type.Array(Type.String())),
      nextAction: Type.Optional(Type.String()),
      mode: Type.Optional(StringEnum(["rift-merge", "pr-merge", "herdr-workflow"] as const)),
      space: Type.Optional(Type.String({ description: "Adopt this Herdr workspace id" })),
      createSpace: Type.Optional(Type.Boolean({ description: "Create a new workspace when none is bound" })),
      desk: Type.Optional(Type.Boolean({ description: "Open the 💬 desk lane" })),
      sidebar: Type.Optional(Type.Boolean({ description: "Publish progress/agents/needs tokens in an adopted space; a created space always does. Off by default so a shared space keeps its owner's sidebar." })),
      cadenceMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_CADENCE_MINUTES })),
      ephemeral: Type.Optional(Type.Boolean({ description: "Allow state under a temp dir for a throwaway run" })),
      musterExtension: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      deskExtension: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, ...rest } = params;
      return run(ctx, signal, projectOpen({ ...rest, dir: projectDir(ctx, project) }), (result) =>
        [
          `${result.adopted ? "Adopted" : "Created"} project ${result.project.slug} [${result.project.state}] in space ${result.project.spaceId ?? "(none)"}.`,
          ...result.notes,
          result.cadence ? `Arm the owner pass now: ${result.cadence.tool} ${JSON.stringify(result.cadence.args)}` : "No cadence recorded.",
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "project_move",
    label: "Muster project move",
    description: "Move Muster state and its Brain board to a private absolute dir. Preserve code repos and worktrees; do not restart agents. Restore live agents and replace the desk cadence afterwards.",
    parameters: Type.Object({ project: ProjectParam, to: Type.String({ description: "New private absolute project dir" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, projectMove(projectDir(ctx, params.project), params.to), (result) => [
        `Moved ${result.project.slug} to ${result.project.dir}: ${result.copiedFiles} files copied.`,
        ...result.rewrittenPaths.map((path) => `${path.from} → ${path.to}`),
        `Lanes given explicit old repo: ${result.lanesGivenRepo.join(", ") || "(none)"}.`,
        ...result.agentsToRestore,
        ...result.notes,
      ].join("\n"));
    },
  });

  pi.registerTool({
    name: "lane_open",
    label: "Muster lane open",
    description:
      "Open a lane just in time: one Herdr tab with a durable label (an emoji plus the lane), recorded with its goal and write scope. open: false records it as proposed without a tab. Reopens a draining or closed lane.",
    promptSnippet: "lane_open: open a lane tab when the critical path needs it",
    parameters: Type.Object({
      project: ProjectParam,
      slug: Type.String({ description: "kebab-case lane id" }),
      label: Type.String({ description: "Tab label: an emoji plus the lane in plain words" }),
      goal: Type.String(),
      kind: Type.Optional(StringEnum(["work", "role"] as const)),
      writeScope: Type.Optional(Type.Array(Type.String())),
      repo: Type.Optional(Type.String({ description: "Source repo for this lane's clones and landings; default the project dir" })),
      base: Type.Optional(Type.String({ description: "Ref or sha worker clones start from; default the repo default branch" })),
      generated: Type.Optional(Type.Array(Type.String({ description: "Path prefix a clone may leave dirty" }))),
      rank: Type.Optional(Type.Integer({ description: "Backlog order, lower first; open: false with rank re-ranks proposed work without other changes" })),
      open: Type.Optional(Type.Boolean()),
      override: Type.Optional(Type.String({ description: "Joel's words authorizing WIP above the limit; saved on the lane" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, ...rest } = params;
      return run(ctx, signal, laneOpen(projectDir(ctx, project), rest), (result) =>
        `Lane ${result.lane.slug} is ${result.lane.state}${result.lane.tabId ? ` in tab ${result.lane.tabId}, root pane ${result.lane.root?.paneId}` : ""}.${result.note ? ` ${result.note}.` : ""}${result.created ? `\nProject outcome: ${result.outcome}\nIf this lane serves another project's outcome, close it and send the ask to that project's desk.` : ""}`,
      );
    },
  });

  pi.registerTool({
    name: "lane_deliver",
    label: "Muster lane delivery",
    description: "Record deployed, proven or waived delivery with plain-word evidence. Stages only move forward; closing a tab does not finish delivery.",
    parameters: Type.Object({ project: ProjectParam, slug: Type.String(), stage: StringEnum(["deployed", "proven", "waived"] as const), evidence: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, ...rest } = params;
      const error = unreadable([params.evidence]);
      if (error) return error;
      return run(ctx, signal, laneDeliver(projectDir(ctx, project), rest), lane => `Lane ${lane.slug}: ${lane.delivery} at ${lane.deliveryAt}. Evidence: ${lane.deliveryEvidence}`);
    },
  });

  pi.registerTool({
    name: "lane_close",
    label: "Muster lane close",
    description:
      "Close a lane when every agent row is closed and every packet is terminal. Otherwise the lane drains (no new launches) and the result lists what is pending. Closes only the tab's root pane that Muster opened.",
    parameters: Type.Object({ project: ProjectParam, slug: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, laneClose(projectDir(ctx, params.project), params.slug), (result) =>
        result.closed
          ? `Lane ${result.lane.slug} closed. ${result.paneNote ?? ""}`
          : `Lane ${result.lane.slug} is ${result.lane.state}; pending:\n${result.pending.map((line) => `- ${line}`).join("\n")}`,
      );
    },
  });

  pi.registerTool({
    name: "agent_launch",
    label: "Muster agent launch",
    description:
      "Add and start, fork, or restore a Pi agent from its catalog row, in its lane's tab. Role defaults come from the fleet roster and the project policy (project_update shows both); model may name a roster alternate, which brings its own settings. Builds the full launch profile (--session-id, --name, --model id:thinking, --append-system-prompt, -ns plus --skill, --compact-at, --approve; never tool allowlists), sets MUSTER_* env, checks the pane cwd, reads the real session id from Herdr, renames the pane, and delivers the work prompt with proof of life. clone: true allocates a rift clone through worker-worktree.sh. Boss and role agents take the lane's root pane; workers split into the right column. fork with side: true splits from the desk parent in its tab, for design work only. adopt with side: true, from and lane re-points a running desk already moved into the parent's tab without touching the pane.",
    promptSnippet: "agent_launch: launch, fork, or restore a lane agent with its full profile",
    parameters: Type.Object({
      project: ProjectParam,
      action: StringEnum(["launch", "fork", "restore", "adopt"] as const),
      machine: Type.Optional(Type.String({ description: "Saved Muster machine; default local. Fork and restore reuse the row machine." })),
      name: Type.String({ description: "Catalog and Herdr agent name, [a-z][a-z0-9_-]{0,31}" }),
      role: Type.Optional(StringEnum(["desk", "hawk", "boss", "worker", "judge"] as const)),
      lane: Type.Optional(Type.String()),
      label: Type.Optional(Type.String({ description: "Pane and session name: an emoji plus the role" })),
      cwd: Type.Optional(Type.String()),
      clone: Type.Optional(Type.Boolean({ description: "Allocate a rift clone of the lane repo as cwd" })),
      from: Type.Optional(Type.String({ description: "fork/adopt: the parent row" })),
      side: Type.Optional(Type.Boolean({ description: "fork: split a design-only side desk from its desk parent in the same tab. adopt: re-point an existing running desk to its side parent and lane after checking the live pane tab; never touches the pane." })),
      at: Type.Optional(Type.String({ description: "fork: context label or entry id in the parent session; omitted forks the full session" })),
      model: Type.Optional(Type.String({ description: "an alias (opus, sol) or provider/model" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
      appendSystemPrompt: Type.Optional(Type.Array(Type.String())),
      skills: Type.Optional(Type.Array(Type.String())),
      noSkills: Type.Optional(Type.Boolean()),
      extensions: Type.Optional(Type.Array(Type.String())),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      compactAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      brief: Type.Optional(Type.String({ description: "Absolute brief path; the default work prompt points at it" })),
      prompt: Type.Optional(Type.String({ description: "Work prompt to deliver after start" })),
      pane: Type.Optional(Type.String({ description: "Use this existing pane; Muster will not close a pane it did not open" })),
      slot: Type.Optional(StringEnum(["root", "split"] as const)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, ...rest } = params;
      return run(ctx, signal, agentLaunch(projectDir(ctx, project), rest), (result) =>
        [
          `${result.row.name} ${result.row.state} in pane ${result.row.pane?.paneId} (${result.row.pane?.openedByMuster ? "opened by Muster" : "caller's pane"}), readiness ${result.readiness}.`,
          `session ${result.row.sessionId}${result.sessionIdMatched === false ? " (differs from the minted id; Herdr's is recorded)" : ""}: ${result.row.sessionFile ?? "file not found yet"}`,
          result.proof ? `delivery: ${result.proof.state}${result.proof.state === "unproven" ? ` — ${result.proof.detail}` : ` via ${result.proof.via}`}` : "no work prompt sent",
          ...(result.row.clone ? [`clone base: ${result.row.clone.base ? `${result.row.clone.base.ref} ${result.row.clone.base.sha}` : "unproven (old catalog)"}`] : []),
          `argv: pi ${result.argv.join(" ")}`,
          ...result.notes,
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "agent_rewind", label: "Muster agent rewind",
    description: "Rewind an owned worker to a label or entry id with a branch summary. Interrupts working agents, waits for idle, submits once and verifies fresh session-file evidence. Send the corrected instruction afterwards.",
    parameters: Type.Object({ project: ProjectParam, name: Type.String(), to: Type.String(), note: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, agentRewind(projectDir(ctx, params.project), params), result =>
        `Rewound ${result.name} to ${result.entryId} (${result.evidence}).${result.note ? ` Steering note: ${result.note}` : ""} Send the corrected instruction as usual.`);
    },
  });

  pi.registerTool({
    name: "agent_close",
    label: "Muster agent close",
    description:
      "Close one agent: save its pane's last 40 lines, close the pane only if Muster opened it (matched by terminal id, never by name), remove its rift clone through worker-worktree.sh (force only after packet_verify passed), and mark the row closed with its full restore command. On an already closed row it retries only the clone removal.",
    parameters: Type.Object({
      project: ProjectParam,
      name: Type.String(),
      force: Type.Optional(Type.Boolean({ description: "Trash unharvested clone work; needs a verified packet" })),
      takeover: Type.Optional(Type.Boolean({ description: "Act on a row another owner session launched" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, ...rest } = params;
      return run(ctx, signal, agentClose(projectDir(ctx, project), rest), (result) =>
        [
          `${result.row.name} closed.`,
          ...result.notes,
          result.cloneError ? `clone kept: ${result.cloneError}` : "",
          `restore (${result.row.machine}): cd ${result.restore.cwd} && ${result.row.machine === "local" ? "pi " : ""}${result.restore.argv.join(" ")}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "packet_verify",
    label: "Muster packet verify",
    description:
      "Verify a reported packet from evidence, not the report's claim: the commit exists in the clone, sits on the lane branch, and shares history with the expected repo; every dirty path in the clone is byte-identical to the source or a named generated file; the report file exists. An artifact packet checks its sha256.",
    parameters: Type.Object({ project: ProjectParam, id: Type.String({ description: "Packet id or a unique prefix of at least 7 chars" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, packetVerify(projectDir(ctx, params.project), params.id), (result) =>
        [`Packet ${result.packet.id.slice(0, 12)} verified.`, ...result.checks.map((check) => `- ${check.outcome} ${check.name}${check.detail ? `: ${check.detail}` : ""}`)].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "packet_land",
    label: "Muster packet land",
    description:
      "Record a packet's outcome: committed, rejected, or no_changes. In rift-merge mode, committed fetches the worker branch into a clean source checkout and merges it --no-ff as shitratgit[bot], running the optional gate under the machine-wide heavy-job lock between merge and commit (a failed gate aborts the merge). Other modes pass landedAs, the merge commit made elsewhere. An artifact packet, or any packet without a clone branch, is recorded without a merge and requires evidence (what you checked and where). Never pushes. project_status records packets that already landed outside Muster (on the base branch or in a merged PR) automatically.",
    parameters: Type.Object({
      project: ProjectParam,
      id: Type.String(),
      outcome: StringEnum(["committed", "rejected", "no_changes"] as const),
      gate: Type.Optional(Type.String({ description: "Shell command run in the source checkout before the merge commit" })),
      landedAs: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String({ description: "Required for artifact or clone-less packets: what the owner checked and where" })),
      message: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, ...rest } = params;
      return run(ctx, signal, packetLand(projectDir(ctx, project), rest), (result) =>
        [`Packet ${result.packet.id.slice(0, 12)} ${result.packet.state}${result.packet.landedAs ? ` as ${result.packet.landedAs}` : ""}. ${result.note}`, ...result.notes].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "desk_post",
    label: "Muster desk post",
    description:
      "Leave one item for Joel in the project's desk queue (decision, approval, blocked, done, fyi). Nothing is pushed to the desk pane; the desk shows it on Joel's next turn. resolves closes an earlier open item. Recomputes the needs token.",
    parameters: Type.Object({
      project: ProjectParam,
      kind: StringEnum(["decision", "approval", "blocked", "done", "fyi"] as const),
      title: Type.String(),
      body: Type.Optional(Type.String()),
      refs: Type.Optional(Type.Array(Type.String())),
      resolves: Type.Optional(Type.String({ description: "Id of an earlier item this one closes" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const error = unreadable([params.title, params.body]);
      if (error) return error;
      const { project, ...rest } = params;
      return run(ctx, signal, deskPost(projectDir(ctx, project), rest), (result) =>
        [`Posted desk item ${result.record.id} [${result.record.kind}]. ${result.open} open for Joel.`, ...result.notes].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "project_status",
    label: "Muster project status",
    description:
      "One owner pass: reconcile catalog rows against Herdr panes (a gone pane interrupts its row; a moved pane is rebound by terminal id), type one refresh into a bridge lane stuck on prompt capture, run the silence check on session-file age at the project's policy limits (only on rows this session owns), put back a drifted space label, report each agent's cache cost, refresh the tokens and Brain board, and return a compact board. act: false observes only.",
    promptSnippet: "project_status: reconcile, silence check, cache cost, and the board",
    parameters: Type.Object({
      project: ProjectParam,
      act: Type.Optional(Type.Boolean()),
      takeover: Type.Optional(Type.Boolean({ description: "Adopt all non-closed catalog rows into this owner session without restarting or closing their panes. Explicit handover; works with act: false." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return run(ctx, signal, projectStatus(projectDir(ctx, params.project), { act: params.act, takeover: params.takeover }), (result) => [result.board, ...result.notes].join("\n"));
    },
  });

  const RolePolicyParam = Type.Optional(
    Type.Object({
      model: Type.Optional(Type.String({ description: "an alias (opus, sol) or provider/model" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
      compactAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { description: "null turns compaction off" })),
      noSkills: Type.Optional(Type.Boolean()),
      skills: Type.Optional(Type.Array(Type.String({ description: "Skill name or absolute path" }))),
    }),
  );

  pi.registerTool({
    name: "project_update",
    label: "Muster project update",
    description:
      "Shape the project to the job. headline is the sidebar's one line on what the space is doing (null falls back to the next action); change it when the story changes, not every pass. label renames the project and its owned space. policy merges over the defaults: silence limits in minutes (restartAfterMin null never restarts) and per-role model, thinking, compactAt, noSkills, skills for later launches. Returns the policy in force.",
    promptSnippet: "project_update: sidebar headline, next action, and the project's timeouts and role defaults",
    parameters: Type.Object({
      project: ProjectParam,
      headline: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      boardType: Type.Optional(Type.String({ description: "Brain board frontmatter type allowed by this repo; rewrites the board." })),
      nextAction: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      policy: Type.Optional(
        Type.Object({
          comms: Type.Optional(StringEnum(["intercom", "network"] as const)),
          wipLimit: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
          flowStallMin: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          landWaitMin: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          nudgeAfterMin: Type.Optional(Type.Number()),
          restartAfterMin: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          roles: Type.Optional(
            Type.Object({ desk: RolePolicyParam, hawk: RolePolicyParam, boss: RolePolicyParam, worker: RolePolicyParam, judge: RolePolicyParam }),
          ),
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, ...rest } = params;
      return run(ctx, signal, projectUpdate(projectDir(ctx, project), rest), (result) =>
        [`${result.project.label}: now "${result.project.headline ?? result.project.nextAction}"`, `policy: ${JSON.stringify(result.policy)}`, ...result.notes].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "project_review",
    label: "Muster project review",
    description:
      "The JITPM weekly review: reconfirm or update the outcome, review trigger, critical path, and next action; archive closed lanes; and get a proposal (continue, split, or archive). The project archives only when decision is archive and no lane is open.",
    parameters: Type.Object({
      project: ProjectParam,
      note: Type.String({ description: "What the review found, in a sentence or two" }),
      outcome: Type.Optional(Type.String()),
      reviewTrigger: Type.Optional(Type.String()),
      criticalPath: Type.Optional(Type.Array(Type.String())),
      nextAction: Type.Optional(Type.String()),
      decision: Type.Optional(StringEnum(["continue", "split", "archive"] as const)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, ...rest } = params;
      return run(ctx, signal, projectReview(projectDir(ctx, project), rest), (result) =>
        [
          `Reviewed ${result.project.slug}: proposal ${result.proposal}, decision ${result.decision}, now ${result.project.state}.`,
          result.archivedLanes.length ? `archived lanes: ${result.archivedLanes.join(", ")}` : "no lanes archived",
          ...result.notes,
        ].join("\n"),
      );
    },
  });
}
