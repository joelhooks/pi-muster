import { existsSync, mkdirSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { Layer } from "effect";
import { Type } from "typebox";

import { paneGet, reportTokens } from "./herdr.ts";
import { deskAnswer, inboxText, loadInbox, loadSystem } from "./switchboard-ops.ts";
import { OPEN_HINT, SwitchboardOverlay, SwitchboardState, renderWidget } from "./switchboard-view.ts";
import type { Intent } from "./switchboard-view.ts";
import { itemRef, queueDir, switchboardNeeds } from "./switchboard.ts";
import { TOKEN_SOURCE, TOKEN_TTL_MS } from "./tokens.ts";

const WIDGET = "muster-switchboard";
const TICK_MS = 60_000;
const DEBOUNCE_MS = 200;
/** Republish before the token lease lapses even when nothing changed. */
const TOKEN_REFRESH_MS = 10 * 60_000;

// The extension's own runner and layer; typed loosely here so this module does not restate Muster's service set.
// biome-ignore lint: any is the honest type for a borrowed runner
type Run = (ctx: ExtensionContext, signal: AbortSignal | undefined, program: Effect.Effect<any, unknown, any>, render: (value: any) => string) => Promise<any>;

export interface SwitchboardDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly layer: (ctx: ExtensionContext) => Layer.Layer<any, any, any>;
  readonly run: Run;
}

/**
 * Switchboard ☎️: the inbox over every project desk. Nothing starts until a
 * session opts in with `--switchboard`, `MUSTER_SWITCHBOARD=1`, `/switchboard`,
 * or the shortcut, so every other session keeps a side-effect-free startup.
 */
export function registerSwitchboard(pi: ExtensionAPI, deps: SwitchboardDeps) {
  const state = new SwitchboardState();
  let active = false;
  // Only requestRender is needed; a structural type avoids pi-tui version skew with the host.
  let tui: { requestRender(): void } | undefined;
  let watcher: FSWatcher | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastNeeds: string | null | undefined;
  let lastPublish = 0;
  let current: ExtensionContext | undefined;

  const provide = <A>(ctx: ExtensionContext, program: Effect.Effect<A, unknown, any>) =>
    Effect.runPromise(program.pipe(Effect.provide(deps.layer(ctx) as Layer.Layer<any>)) as Effect.Effect<A>);

  const publish = async (ctx: ExtensionContext) => {
    const paneId = deps.env.HERDR_PANE_ID;
    if (!paneId) return;
    const needs = switchboardNeeds(state.groups);
    const now = Date.now();
    if (needs === lastNeeds && now - lastPublish < TOKEN_REFRESH_MS) return;
    lastNeeds = needs;
    lastPublish = now;
    // `progress` marks the space as managed, so Bellwether leaves `needs` to us.
    await provide(
      ctx,
      Effect.gen(function* () {
        const pane = yield* paneGet(paneId);
        if (!pane) return;
        yield* reportTokens(pane.workspace_id, TOKEN_SOURCE, { progress: "☎️ switchboard", now: null, agents: null, needs }, now, TOKEN_TTL_MS);
      }),
    ).catch(() => undefined);
  };

  const refresh = async (ctx: ExtensionContext) => {
    const view = await provide(ctx, loadSystem).catch(() => null);
    if (!view) return;
    state.setSystem(view);
    tui?.requestRender();
    await publish(ctx);
  };

  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      if (current) void refresh(current);
    }, DEBOUNCE_MS);
  };

  const activate = async (ctx: ExtensionContext) => {
    current = ctx;
    if (active) return;
    active = true;
    const dir = queueDir(homedir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    watcher = watch(dir, () => schedule());
    tick = setInterval(() => schedule(), TICK_MS);
    ctx.ui.setWidget(WIDGET, (widgetTui, theme) => {
      tui = widgetTui;
      return { render: (width: number) => renderWidget(state, width, theme), invalidate: () => {} };
    });
    await refresh(ctx);
  };

  const deactivate = (ctx?: ExtensionContext) => {
    active = false;
    watcher?.close();
    watcher = undefined;
    if (tick) clearInterval(tick);
    if (pending) clearTimeout(pending);
    tick = undefined;
    pending = undefined;
    ctx?.ui.setWidget(WIDGET, undefined);
    tui = undefined;
  };

  const answer = async (ctx: ExtensionContext, item: Extract<Intent, { item: unknown }>["item"], text: string, kind: "done" | "fyi" = "done") => {
    try {
      const result = await provide(ctx, deskAnswer({ project: item.project, id: item.id, answer: text, kind }));
      const nudged = result.nudged.length ? `; desk nudged (${result.nudged.join(", ")})` : "; no Muster desk to nudge, it reads the queue on its next turn";
      ctx.ui.notify(`☎️ answered ${itemRef(item)}${nudged}`, "info");
    } catch (error) {
      ctx.ui.notify(`☎️ answer failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    await refresh(ctx);
  };

  /** Browse until Joel closes the overlay or hands an item to the agent. */
  const browse = async (ctx: ExtensionContext) => {
    await activate(ctx);
    for (;;) {
      const intent = await ctx.ui.custom<Intent>(
        (overlayTui, theme, _keys, done) =>
          new SwitchboardOverlay(state, theme, () => Math.max(12, Math.floor((process.stdout.rows ?? 30) * 0.8)), done, () => overlayTui.requestRender()),
        { overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "80%" } },
      );
      if (!intent || intent.type === "close") return;
      if (intent.type === "discuss") {
        const draft = ctx.ui.getEditorText().trim();
        ctx.ui.setEditorText(`${draft ? `${draft} ` : ""}${itemRef(intent.item)} `);
        return;
      }
      if (intent.type === "answer") {
        const text = await ctx.ui.input(`Answer ${itemRef(intent.item)}: ${intent.item.title}`, "your answer; it resolves the item");
        if (text?.trim()) await answer(ctx, intent.item, text);
      } else if (intent.type === "done") {
        const ok = await ctx.ui.confirm("Mark done?", `${itemRef(intent.item)} ${intent.item.title}`);
        if (ok) await answer(ctx, intent.item, "done");
      }
    }
  };

  pi.registerFlag("switchboard", { description: "Run this session as the Switchboard: a live inbox over every project desk.", type: "boolean" });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("switchboard") === true || deps.env.MUSTER_SWITCHBOARD === "1") await activate(ctx);
  });
  pi.on("session_shutdown", () => deactivate());
  pi.on("agent_end", (_event, ctx) => {
    if (active) void refresh(ctx);
  });

  pi.registerCommand("switchboard", {
    description: "☎️ Switchboard: `/switchboard` browses every project's open items; `on` and `off` show or hide the live inbox.",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "off") {
        deactivate(ctx);
        ctx.ui.notify("☎️ Switchboard off", "info");
      } else if (arg === "on") {
        await activate(ctx);
      } else {
        await browse(ctx);
      }
    },
  });

  pi.registerShortcut(OPEN_HINT, { description: "Open the Switchboard inbox", handler: async (ctx) => browse(ctx) });

  pi.registerTool({
    name: "desk_inbox",
    label: "Switchboard inbox",
    description:
      "Every open item waiting on Joel across all project desk queues, blocked first, then approvals, then decisions, oldest first. Each item has a [project#id] reference for desk_answer.",
    promptSnippet: "desk_inbox: every project's open items for Joel, ranked",
    parameters: Type.Object({ project: Type.Optional(Type.String({ description: "Only this project's queue" })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return deps.run(ctx, signal, loadInbox, (groups) =>
        inboxText(params.project ? groups.filter((group: { project: string }) => group.project === params.project) : groups),
      );
    },
  });

  pi.registerTool({
    name: "desk_answer",
    label: "Switchboard answer",
    description:
      "Answer one open item for Joel: writes a resolving line into that project's own desk queue and nudges the project's Muster desk over intercom when there is one. Use Joel's words; do not decide for him.",
    parameters: Type.Object({
      project: Type.String(),
      id: Type.String({ description: "Item id, the part after # in [project#id]" }),
      answer: Type.String({ description: "Joel's answer, as he gave it" }),
      kind: Type.Optional(StringEnum(["done", "fyi"] as const)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await deps.run(ctx, signal, deskAnswer(params), (value) =>
        `Answered ${itemRef({ project: params.project, id: value.item.id })} (${value.remaining} left in ${params.project}). ${value.nudged.length ? `Nudged: ${value.nudged.join(", ")}` : "No Muster desk to nudge; the queue carries it."}`,
      );
      if (current && active) void refresh(current);
      return result;
    },
  });
}
