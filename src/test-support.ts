import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";
import { HerdrApiError } from "@joelhooks/pi-bellwether/herdr-client";
import type { HerdrClient, HerdrRequest } from "@joelhooks/pi-bellwether/herdr-client";

import { sessionDirFor } from "./argv.ts";
import type { ProcShape } from "./runtime.ts";
import { IntercomComms } from "./comms.ts";
import { readRegistry } from "./registry.ts";
import { load, projectPath } from "./store.ts";
import { decodeProject } from "./domain.ts";
import { CommsError, Herdr, Comms, MusterEnv, Proc, liveProc, noEmitPaneClose } from "./runtime.ts";
import type { EmitPaneClose } from "./runtime.ts";

export interface FakePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  label?: string;
  agent?: string;
  agent_session?: { source: string; agent: string; kind: string; value: string };
}

/** An in-memory Herdr: enough topology, shell cwd, and agent sessions for Muster's operations. */
export class FakeHerdr {
  panes = new Map<string, FakePane>();
  tabs = new Map<string, { tab_id: string; workspace_id: string; label: string }>();
  workspaces = new Map<string, { workspace_id: string; label: string }>();
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  tokens = new Map<string, Record<string, string | null>>();
  promptWorking = true;
  startSessions = true;
  startErrors: string[] = [];
  promptFails = false;
  firstTurn: "clean" | "error" | "paste" | "missing" | "mismatch" = "clean";
  firstTurnError = "broken model route";
  typedPrompts: string[] = [];
  readinessPending = 0;
  paneTail = "last lines";
  /** Reject this many agent.prompt calls with agent_not_ready, as Herdr does before it registers a fresh agent name. */
  promptNotReady = 0;
  private seq = 0;

  constructor(readonly home: string) {
    this.workspaces.set("w1", { workspace_id: "w1", label: "fake" });
  }

  private next(prefix: string) {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  addPane(workspace: string, tab: string, cwd: string): FakePane {
    const pane: FakePane = { pane_id: this.next("p"), terminal_id: this.next("term-"), workspace_id: workspace, tab_id: tab, cwd };
    this.panes.set(pane.pane_id, pane);
    return pane;
  }

  private paneInfo(pane: FakePane) {
    // Tests can inject late session evidence; an observed Pi journal exists on disk.
    const file = pane.agent_session?.kind === "path" ? pane.agent_session.value : null;
    if (file && file.startsWith(`${dirname(this.home)}/`) && !existsSync(file)) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ type: "session", id: "injected-session", cwd: pane.cwd })}\n`);
    }
    return {
      pane_id: pane.pane_id,
      terminal_id: pane.terminal_id,
      workspace_id: pane.workspace_id,
      tab_id: pane.tab_id,
      focused: false,
      cwd: pane.cwd,
      foreground_cwd: pane.cwd,
      agent_status: pane.agent ? ("idle" as const) : ("unknown" as const),
      revision: 1,
      ...(pane.label ? { label: pane.label } : {}),
      ...(pane.agent ? { agent: pane.agent } : {}),
      ...(pane.agent_session ? { agent_session: pane.agent_session } : {}),
    };
  }

  private agentInfo(pane: FakePane, status: "idle" | "working") {
    return { ...this.paneInfo(pane), name: pane.agent ?? "agent", agent_status: status, interactive_ready: true };
  }

  private startSession(pane: FakePane, sessionId: string, file?: string) {
    const path = file ?? join(sessionDirFor(pane.cwd, this.home), `2026-09-29T00-00-00-000Z_${sessionId}.jsonl`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: "session", id: sessionId, cwd: pane.cwd })}\n`);
    pane.agent_session = { source: "pi", agent: "pi", kind: "path", value: path };
  }

  private pane(operation: string, id: unknown) {
    const pane = this.panes.get(String(id));
    if (!pane) throw new HerdrApiError({ operation, code: "pane_not_found", message: `pane ${String(id)} not found` });
    return pane;
  }

  handle(method: string, params: Record<string, unknown>): unknown {
    this.calls.push({ method, params });
    switch (method) {
      case "workspace.list":
        return { type: "workspace_list", workspaces: [...this.workspaces.values()] };
      case "workspace.create": {
        const id = this.next("w");
        this.workspaces.set(id, { workspace_id: id, label: String(params.label) });
        const tab = this.next("t");
        this.tabs.set(tab, { tab_id: tab, workspace_id: id, label: "1" });
        const root = this.addPane(id, tab, String(params.cwd));
        return { type: "workspace_created", workspace: { workspace_id: id }, tab: { tab_id: tab }, root_pane: this.paneInfo(root) };
      }
      case "tab.create": {
        const tab = this.next("t");
        const ws = String(params.workspace_id);
        this.tabs.set(tab, { tab_id: tab, workspace_id: ws, label: String(params.label) });
        const root = this.addPane(ws, tab, String(params.cwd));
        return { type: "tab_created", tab: { tab_id: tab, workspace_id: ws, label: params.label }, root_pane: this.paneInfo(root) };
      }
      case "pane.get":
        return { type: "pane_info", pane: this.paneInfo(this.pane(method, params.pane_id)) };
      case "pane.list":
        return {
          type: "pane_list",
          panes: [...this.panes.values()].filter((pane) => !params.workspace_id || pane.workspace_id === params.workspace_id).map((pane) => this.paneInfo(pane)),
        };
      case "pane.split": {
        const from = this.pane(method, params.target_pane_id);
        return { type: "pane_info", pane: this.paneInfo(this.addPane(from.workspace_id, from.tab_id, String(params.cwd))) };
      }
      case "pane.rename": {
        const pane = this.pane(method, params.pane_id);
        pane.label = String(params.label);
        return { type: "pane_info", pane: this.paneInfo(pane) };
      }
      case "pane.send_input": {
        const pane = this.pane(method, params.pane_id);
        const text = String(params.text);
        const cd = /^cd '([^']*)'/.exec(text);
        if (cd?.[1]) pane.cwd = cd[1];
        const receipt = />~\/\.pi\/agent\/(m-[a-zA-Z0-9-]+\.pi)/.exec(text)?.[1];
        if (receipt) {
          mkdirSync(join(this.home, ".pi/agent"), { recursive: true });
          writeFileSync(join(this.home, ".pi/agent", receipt), "/fake/bin/pi\n1.0.3\n", { mode: 0o600 });
        }
        if (text === "/new" && pane.agent) this.startSession(pane, `fresh-${this.next("s")}`);
        return { type: "ok" };
      }
      case "pane.send_keys":
      case "pane.send_text":
        this.pane(method, params.pane_id);
        return { type: "ok" };
      case "pane.read":
        return { type: "pane_read", read: { pane_id: params.pane_id, text: this.paneTail, truncated: false } };
      case "pane.close": {
        const pane = this.pane(method, params.pane_id);
        this.panes.delete(pane.pane_id);
        return { type: "ok" };
      }
      case "agent.start": {
        const code = this.startErrors.shift();
        if (code) throw new HerdrApiError({ operation: method, code, message: "start rejected" });
        const pane = this.pane(method, params.pane_id);
        pane.agent = String(params.name);
        const args = params.args as string[];
        const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
        const file = at("--session");
        const id = at("--session-id") ?? (file ? /_([^_]+)\.jsonl$/.exec(file)?.[1] : undefined) ?? "unknown";
        if (this.startSessions) this.startSession(pane, id, file);
        return { type: "agent_started", agent: this.agentInfo(pane, "idle"), argv: args };
      }
      case "agent.get": {
        const pane = this.pane(method, params.target);
        const pending = this.readinessPending > 0;
        if (pending) this.readinessPending -= 1;
        return { type: "agent_info", agent: { ...this.agentInfo(pane, "idle"), agent: "pi", launch_pending: pending, interactive_ready: !pending } };
      }
      case "agent.prompt":
        if (this.promptFails) throw new HerdrApiError({ operation: method, code: "agent_not_found", message: "agent gone" });
        if (this.promptNotReady > 0) {
          this.promptNotReady -= 1;
          throw new HerdrApiError({ operation: method, code: "agent_not_ready", message: `agent ${String(params.target)} is not an active named agent` });
        }
        this.typedPrompts.push(String(params.text));
        {
          const file = this.pane(method, params.target).agent_session?.value;
          if (file) {
            const text = this.firstTurn === "paste" ? "[paste #1 1303 chars]" : this.firstTurn === "mismatch" ? "status only" : String(params.text);
            appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`);
            if (this.firstTurn !== "missing") appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: this.firstTurn === "error" ? "error" : "stop", ...(this.firstTurn === "error" ? { errorMessage: this.firstTurnError } : {}) } })}\n`);
          }
        }
        return { type: "agent_prompted", agent: this.agentInfo(this.pane(method, params.target), this.promptWorking ? "working" : "idle") };
      case "agent.wait":
        return { type: "agent_info", agent: this.agentInfo(this.pane(method, params.target), this.promptWorking ? "working" : "idle") };
      case "workspace.rename": {
        const space = this.workspaces.get(String(params.workspace_id));
        if (!space) throw new HerdrApiError({ operation: method, code: "workspace_not_found", message: "no workspace" });
        space.label = String(params.label);
        return { type: "workspace_info", workspace: { ...space, number: 1, focused: false, pane_count: 0, tab_count: 0, active_tab_id: "t", agent_status: "idle" } };
      }
      case "workspace.report_metadata":
        this.tokens.set(String(params.workspace_id), params.tokens as Record<string, string | null>);
        return { type: "ok" };
      default:
        throw new HerdrApiError({ operation: method, code: "unsupported", message: `fake herdr does not know ${method}` });
    }
  }

  client(): HerdrClient {
    return {
      socketPath: () => "/fake.sock",
      request: <M extends HerdrRequest["method"]>(request: HerdrRequest<M>) =>
        Effect.suspend(() => {
          try {
            return Effect.succeed(this.handle(request.method, { ...(request.params ?? {}) }) as never);
          } catch (error) {
            return Effect.fail(error as HerdrApiError);
          }
        }),
    };
  }
}

export interface Harness {
  readonly root: string;
  readonly home: string;
  readonly herdr: FakeHerdr;
  readonly sent: Array<{ to: string; message: string }>;
  readonly layer: Layer.Layer<Herdr | Proc | MusterEnv | Comms>;
  readonly workerWorktree: string;
  proc: ProcShape;
  emitPaneClose: EmitPaneClose;
  now: Date;
  startupLoad: { load: number; cpus: number };
  sleep: (ms: number) => void;
  sessionId: string;
  live: string[] | undefined;
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

export function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(dir, "add", "README.md");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A stand-in for worker-worktree.sh: a plain git clone on worker/<slug>, and a guarded remove. */
function fakeWorkerWorktree(root: string): string {
  const script = join(root, "worker-worktree.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  create)
    target="${root}/clones/$3"
    git clone -q "$2" "$target"
    base="default branch"
    if [ "\${4:-}" = "--base" ]; then
      base="$5"
      sha=$(git -C "$2" rev-parse "$base^{commit}")
    else
      sha=$(git -C "$target" rev-parse HEAD)
    fi
    git -C "$target" checkout -q -b "worker/$3" "$sha"
    echo "worktree: $target"
    echo "branch:   worker/$3"
    echo "base: $base $sha"
    ;;
  remove)
    if [ "$2" = "--force" ]; then rm -rf "$3"; echo "trashed: $3"; exit 0; fi
    if [ -n "$(git -C "$2" status --porcelain)" ]; then echo "refusing: uncommitted work in $2" >&2; exit 1; fi
    rm -rf "$2"; echo "trashed: $2"
    ;;
esac
`,
  );
  chmodSync(script, 0o755);
  return script;
}

export function harness(): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "muster-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const herdr = new FakeHerdr(home);
  const sent: Array<{ to: string; message: string }> = [];
  const workerWorktree = fakeWorkerWorktree(root);
  let counter = 0;
  const h: Harness = {
    root,
    home,
    herdr,
    sent,
    workerWorktree,
    proc: { run: (command, args, options) => command === "pi"
      ? Effect.succeed({ code: 0, stdout: "", stderr: "" })
      : liveProc.run(command, args, options) },
    now: new Date("2026-09-29T06:00:00Z"),
    startupLoad: { load: 0, cpus: 8 },
    sleep: () => {},
    sessionId: "owner-session",
    live: undefined,
    emitPaneClose: noEmitPaneClose,
    get layer() {
      return Layer.mergeAll(
        Layer.succeed(Herdr)(herdr.client()),
        Layer.succeed(Proc)(h.proc),
        Layer.succeed(MusterEnv)({
          home,
          now: () => h.now,
          sessionId: h.sessionId,
          paneId: undefined,
          musterRoot: "/muster",
          workerWorktree,
          createId: () => `id${(counter += 1).toString().padStart(6, "0")}`,
          sleep: (ms) => Effect.sync(() => h.sleep(ms)),
          startupLoad: () => h.startupLoad,
          emitPaneClose: h.emitPaneClose,
        }),
        Layer.succeed(Comms)(IntercomComms({
          send: (to, message) =>
            Effect.sync(() => {
              sent.push({ to, message });
              return { status: "sent" as const };
            }),
          sessions: () => Effect.succeed(h.live),
        }, address => load(readRegistry(home).get(address.project)?.dir ?? "").pipe(
          Effect.map(project => project.agents.find(row => row.name === address.row)?.sessionId ?? ""),
          Effect.mapError(error => new CommsError(error.message)),
        ))),
      );
    },
  };
  return h;
}

/** Copy a real, prepared fixture instead of repeating unrelated launch processes.
 * Each case owns its files, Git refs, fake panes and process adapter.
 */
export function forkHarness(template: Harness, dir: string) {
  const h = harness();
  const relocate = (value: string) => value.split(template.root).join(h.root);
  cpSync(template.root, h.root, { recursive: true });
  const copiedDir = relocate(dir);
  const path = projectPath(copiedDir);
  const project = decodeProject(JSON.parse(relocate(readFileSync(path, "utf8"))));
  writeFileSync(path, JSON.stringify(project));
  for (const cwd of new Set([project.dir, ...project.agents.map(row => row.cwd)])) {
    const config = join(cwd, ".git", "config");
    writeFileSync(config, relocate(readFileSync(config, "utf8")));
  }
  writeFileSync(h.workerWorktree, relocate(readFileSync(h.workerWorktree, "utf8")));
  for (const [id, pane] of template.herdr.panes) h.herdr.panes.set(id, {
    ...pane, cwd: relocate(pane.cwd),
    ...(pane.agent_session ? { agent_session: { ...pane.agent_session, value: relocate(pane.agent_session.value) } } : {}),
  });
  for (const [id, tab] of template.herdr.tabs) h.herdr.tabs.set(id, { ...tab });
  for (const [id, workspace] of template.herdr.workspaces) h.herdr.workspaces.set(id, { ...workspace });
  h.now = new Date(template.now);
  h.sessionId = template.sessionId;
  return { h, dir: copiedDir, relocate };
}

export const runWith = <A, E>(h: Harness, program: Effect.Effect<A, E, Herdr | Proc | MusterEnv | Comms>) =>
  Effect.runPromise(program.pipe(Effect.provide(h.layer)));

export const failWith = async <A, E>(h: Harness, program: Effect.Effect<A, E, Herdr | Proc | MusterEnv | Comms>) => {
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(h.layer)));
  if (exit._tag === "Success") throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`);
  const { Cause } = await import("effect");
  return Cause.squash(exit.cause) as { _tag: string; message: string } & Record<string, unknown>;
};
