import { mkdirSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { Layer } from "effect";
import { Type } from "typebox";

import { paneGet, reportTokens } from "./herdr.ts";
import { deskAnswer, focusDesk, inboxText, loadSystem, loadSystemWith, registerSwitchboardSession, registryPath } from "./switchboard-ops.ts";
import { FlameAnimation, flameEnabled } from "./switchboard-flame.ts";
import { OPEN_HINT, SwitchboardOverlay, SwitchboardState, renderWidget } from "./switchboard-view.ts";
import type { Intent } from "./switchboard-view.ts";
import { QueueReader, fleetGroups, inbox, itemRef, latestPost, queueDir, queueEvents, recentPosts, switchboardTokens } from "./switchboard.ts";
import { TOKEN_SOURCE, TOKEN_TTL_MS } from "./tokens.ts";

const WIDGET = "muster-switchboard";
const TICK_MS = 1_000;
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
 * the shortcut, or `desk_inbox`, so every other session keeps a side-effect-free startup.
 */
/** Watch directories, not files: atomic replacements and brand-new queues both count. */
export function watchSwitchboard(home: string, changed: () => void): () => void {
  const watchers: FSWatcher[] = [];
  for (const dir of [queueDir(home), dirname(registryPath(home))]) {
    mkdirSync(dir, { recursive: true });
    try {
      const watcher = watch(dir, changed);
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch { /* The one-second poll is the floor if watching isn't supported. */ }
  }
  // On macOS fs.watch can miss the first create in a freshly watched directory.
  // Poll independently of events, including registry/topology-only changes.
  const poll = setInterval(changed, TICK_MS);
  return () => { clearInterval(poll); watchers.forEach((watcher) => watcher.close()); };
}

export function registerSwitchboard(pi: ExtensionAPI, deps: SwitchboardDeps) {
  const state = new SwitchboardState();
  let active = false;
  // Only requestRender is needed; a structural type avoids pi-tui version skew with the host.
  let tui: { requestRender(): void } | undefined;
  let widgetInvalidate: (() => void) | undefined;
  let stopInput: (() => void) | undefined;
  let animation: FlameAnimation | undefined;
  let overlayOpen = false;
  let stopWatch: (() => void) | undefined;
  let unregister: (() => void) | undefined;
  let overlayTui: { requestRender(): void } | undefined;
  let refreshing: Promise<void> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let lastTokens = "";
  let lastPublish = 0;
  let liveLayer: Layer.Layer<any> | undefined;
  let reader = new QueueReader();
  let topologyAt = 0;
  let registryStamp = "";
  let generation = 0;
  let loggedFailure = false;
  const failed = (error: unknown) => {
    if (loggedFailure) return;
    loggedFailure = true;
    console.error(`☎️ Switchboard refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  };
  const provideLive = <A>(program: Effect.Effect<A, unknown, any>) => {
    if (!liveLayer) throw new Error("Switchboard is not activated");
    return Effect.runPromise(program.pipe(Effect.provide(liveLayer)) as Effect.Effect<A>);
  };

  const provide = <A>(ctx: ExtensionContext, program: Effect.Effect<A, unknown, any>) =>
    Effect.runPromise(program.pipe(Effect.provide(deps.layer(ctx) as Layer.Layer<any>)) as Effect.Effect<A>);

  const publish = async () => {
    const paneId = deps.env.HERDR_PANE_ID;
    if (!paneId) return;
    const now = Date.now();
    const tokens = switchboardTokens({ groups: state.groups, fleet: state.fleet, latest: state.latest, now });
    const key = JSON.stringify(tokens);
    if (key === lastTokens && now - lastPublish < TOKEN_REFRESH_MS) return;
    lastTokens = key;
    lastPublish = now;
    // `progress` marks the space as managed, so Bellwether leaves `needs` to us.
    await provideLive(
      Effect.gen(function* () {
        const pane = yield* paneGet(paneId);
        if (!pane) return;
        yield* reportTokens(pane.workspace_id, TOKEN_SOURCE, tokens, now, TOKEN_TTL_MS);
      }),
    ).catch(failed);
  };

  const repaint = () => { widgetInvalidate?.(); tui?.requestRender(); overlayTui?.requestRender(); };
  const refresh = (): Promise<void> => {
    if (!active) return Promise.resolve();
    const home = deps.env.HOME ?? homedir();
    try {
      const now = Date.now();
      const bytes = reader.bytesRead;
      const queues = reader.read(queueDir(home));
      const queueChanged = reader.bytesRead !== bytes;
      if (queueChanged) animation?.wake();
      const previous = new Map(state.groups.map((group) => [group.project, group]));
      const openKey = () => state.groups.flatMap((g) => g.items.map((i) => `${g.project}#${i.id}`)).sort().join("\n");
      const beforeOpen = openKey();
      state.setSystem({
        groups: fleetGroups(inbox(queues, now), [...previous.keys(), ...Object.keys(queues)]).map((group) => ({
          ...group, outsideSpace: previous.get(group.project)?.outsideSpace, deadDesk: previous.get(group.project)?.deadDesk,
        })),
        posts: recentPosts(queues, now), events: queueEvents(queues, now), latest: latestPost(queues),
        fleet: state.fleet, unregistered: state.unregistered, now,
      });
      for (const { project, item } of reader.arrivals) if (!item.resolves) state.flame.land(project, now);
      const openChanged = beforeOpen !== openKey();
      if (openChanged) animation?.wake();
      // Fresh ages on the next host render, without animating a frozen widget.
      widgetInvalidate?.();
      if (queueChanged || openChanged || overlayOpen) repaint();
      // Queue/age rendering never waits for sockets or project metadata.
      let stamp = "missing";
      try { const stat = statSync(registryPath(home)); stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (refreshing) return refreshing;
      if (stamp === registryStamp && now - topologyAt < 30_000) return Promise.resolve();
      const epoch = generation;
      refreshing = provideLive(loadSystemWith(() => queues)).then((view) => {
        if (!active || epoch !== generation) return;
        const flags = new Map(view.groups.map((group) => [group.project, group]));
        // Keep queues that arrived while topology was loading.
        state.setSystem({ ...view, now: state.now, events: state.events, posts: state.posts, latest: state.latest,
          groups: fleetGroups(state.groups.filter((group) => group.items.length > 0), view.groups.map((group) => group.project)).map((group) => ({
            ...group, outsideSpace: flags.get(group.project)?.outsideSpace, deadDesk: flags.get(group.project)?.deadDesk,
          })),
        });
        topologyAt = Date.now(); registryStamp = stamp;
        repaint();
      }).catch(failed).finally(() => { if (epoch === generation) refreshing = undefined; });
      return refreshing;
    } catch (error) { failed(error); return Promise.resolve(); }
  };

  const schedule = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      void refresh();
      if (active) void publish().catch(failed);
    }, DEBOUNCE_MS);
  };

  const activate = async (ctx: ExtensionContext) => {
    if (active) return;
    // Resolve session-bound getters once. Background reads never touch a captured ctx.
    liveLayer = deps.layer(ctx) as Layer.Layer<any>;
    reader = new QueueReader();
    topologyAt = 0; registryStamp = ""; loggedFailure = false;
    active = true;
    const home = deps.env.HOME ?? homedir();
    stopWatch = watchSwitchboard(home, schedule);
    // An agent Muster launched (desk, hawk, boss, worker, judge) owns one project; it may browse
    // the fleet locally but never registers for every tenant's pages.
    if (deps.env.MUSTER_ROLE) ctx.ui.notify(`☎️ ${deps.env.MUSTER_ROLE} sessions browse the Switchboard but are not paged; only a non-project session registers`, "info");
    else unregister = registerSwitchboardSession(home, ctx.sessionManager.getSessionId());
    ctx.ui.setWidget(WIDGET, (widgetTui, theme) => {
      tui = widgetTui;
      animation?.dispose(); stopInput?.();
      const widgetAnimation = new FlameAnimation(() => { state.flame.frame += 1; repaint(); });
      animation = widgetAnimation;
      const removeInput = widgetTui.addInputListener?.((data) => { widgetAnimation.input(data); });
      stopInput = removeInput;
      let cache: { width: number; lines: string[] } | undefined;
      widgetInvalidate = () => { cache = undefined; };
      return {
        render: (width: number) => {
          animation?.show(active && !overlayOpen && flameEnabled(width, theme, deps.env) && state.groups.length > 0);
          if (!cache || cache.width !== width) cache = { width, lines: renderWidget(state, width, theme, deps.env, Date.now()) };
          return cache.lines;
        },
        invalidate: widgetInvalidate,
        dispose: () => { widgetAnimation.dispose(); removeInput?.(); },
      };
    });
    await refresh();
  };

  const deactivate = (ctx?: ExtensionContext) => {
    active = false;
    generation += 1;
    refreshing = undefined;
    liveLayer = undefined;
    animation?.dispose(); animation = undefined;
    stopInput?.(); stopInput = undefined;
    widgetInvalidate = undefined;
    stopWatch?.();
    stopWatch = undefined;
    unregister?.();
    unregister = undefined;
    if (pending) clearTimeout(pending);
    pending = undefined;
    ctx?.ui.setWidget(WIDGET, undefined);
    tui = undefined;
    overlayTui = undefined;
  };

  const answer = async (ctx: ExtensionContext, item: Extract<Intent, { item: unknown }>["item"], text: string, kind: "done" | "fyi" = "done") => {
    try {
      const result = await provide(ctx, deskAnswer({ project: item.project, id: item.id, answer: text, kind }));
      const nudged = result.nudged.length ? `; desk nudged (${result.nudged.join(", ")})` : "; no Muster desk to nudge, it reads the queue on its next turn";
      ctx.ui.notify(`☎️ answered ${itemRef(item)}${nudged}`, "info");
    } catch (error) {
      ctx.ui.notify(`☎️ answer failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
    await refresh();
  };

  /** Browse until Joel closes the overlay or hands an item to the agent. */
  const browse = async (ctx: ExtensionContext) => {
    await activate(ctx);
    for (;;) {
      overlayOpen = true;
      animation?.show(false);
      const intent = await ctx.ui.custom<Intent>(
        (screen, theme, _keys, done) => {
          overlayTui = screen;
          return new SwitchboardOverlay(state, theme, () => Math.max(12, Math.floor((process.stdout.rows ?? 30) * 0.8)), done, () => screen.requestRender());
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "80%" } },
      ).finally(() => {
        overlayTui = undefined;
        overlayOpen = false;
        repaint();
      });
      if (!intent || intent.type === "close") return;
      if (intent.type === "desk") {
        try {
          const result = await provide(ctx, focusDesk(intent.project, intent.item ? itemRef(intent.item) : undefined));
          if (!result.live) ctx.ui.notify("no live desk; a answers from here", "info");
          else return;
        } catch (error) {
          ctx.ui.notify(`☎️ desk focus failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        continue;
      }
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
    const wasActive = active;
    deactivate();
    if (wasActive || pi.getFlag("switchboard") === true || deps.env.MUSTER_SWITCHBOARD === "1") await activate(ctx);
  });
  pi.on("session_shutdown", () => deactivate());
  pi.on("before_agent_start", async () => {
    if (active) await refresh();
  });
  pi.on("agent_end", () => {
    if (active) void refresh();
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
      "The live fleet: open desk items ranked blocked, approvals, decisions; quiet registered projects; and unregistered Herdr spaces. Read-only unless subscribe is true, which makes this session the Switchboard and pages it on every project's queue change. Project desks never subscribe. Each item has a [project#id] reference for desk_answer.",
    promptSnippet: "desk_inbox: every project's open items for Joel, ranked",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ description: "Only this project's queue" })),
      subscribe: Type.Optional(Type.Boolean({ description: "Run this session as the Switchboard: watch every queue and receive a nudge on each change. Default false." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      // A read never subscribes: a project desk that peeked once was paged for every tenant's queue.
      if (params.subscribe === true) await activate(ctx);
      return deps.run(ctx, signal, loadSystem, (view) =>
        inboxText(params.project ? view.groups.filter((group: { project: string }) => group.project === params.project) : view.groups, params.project ? [] : view.unregistered),
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
      if (active) void refresh();
      return result;
    },
  });
}
