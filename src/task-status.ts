import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { AgentState, GateReceipt, Slug, AgentName, decodeRemotePacket, type AgentRow, type Project } from "./domain.ts";
import { InputError } from "./errors.ts";
import { paneList, type PaneInfo } from "./herdr.ts";
import { machineConfig, mapPath, onRemote, remoteNode, sshProc } from "./remote.ts";
import { MusterEnv, Proc, type ProcShape } from "./runtime.ts";
import { sourceOf } from "./packet.ts";

export type TaskStatus = "drafted" | "working" | "reported" | "landed" | "rejected";
export interface TaskFacts {
  readonly live: boolean;
  readonly commits: boolean;
  readonly merged: boolean;
  readonly report: boolean;
  readonly gate: boolean;
  /** The only progress fact read from catalog state: an explicit packet rejection. */
  readonly rejected: boolean;
}

/** Progress and process liveness are deliberately independent. */
export function deriveTaskStatus(facts: TaskFacts): TaskStatus {
  if (facts.rejected) return "rejected";
  if (facts.commits && facts.merged && facts.gate) return "landed";
  if (facts.commits && facts.report) return "reported";
  if (facts.live || facts.commits) return "working";
  return "drafted";
}

/** Side states map to progress, not to another process lifecycle. Closed rows are not traced. */
export const STORED_TASK_STATUS: Readonly<Record<AgentRow["state"], TaskStatus | null>> = {
  planned: "drafted", launching: "drafted", running: "working", silent: "working",
  nudged: "working", restarted: "working", reported: "reported", verified: "reported",
  landed: "landed", interrupted: "working", restoring: "working", failed: "working", closed: null,
};

export interface TaskTrace {
  readonly derived: TaskStatus | "?";
  readonly liveness: "alive" | "quiet" | "?";
  readonly facts: TaskFacts & { readonly head: string | null; readonly tree: string | null; readonly gaps: readonly string[] };
}

const decodeGate = Schema.decodeUnknownSync(GateReceipt);
// Journal boundaries reuse domain identities and lifecycle schemas; raw facts are diagnostic only.
const decodeTrace = Schema.decodeUnknownSync(Schema.Struct({
  at: Schema.String, project: Slug, row: AgentName, stored: AgentState,
  derived: Schema.Literals(["drafted", "working", "reported", "landed", "rejected", "?"]), facts: Schema.Unknown,
}));
const io = <A>(fn: () => A) => Effect.try({ try: fn, catch: error => new InputError({ message: `task tracer: ${String(error)}` }) });

/** Persist deduplication across tool calls and owner restarts. Nothing is written for agreement. */
export function appendTaskTraces(home: string, at: string, project: string, rows: readonly AgentRow[], traces: ReadonlyMap<string, TaskTrace>): void {
  const root = join(home, ".local/state/muster");
  const path = join(root, "task-status-trace.jsonl");
  const previous = new Map<string, string>();
  if (existsSync(path)) for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = decodeTrace(JSON.parse(line));
      previous.set(`${record.project}/${record.row}`, `${record.stored}/${record.derived}`);
    } catch { /* A torn last append does not disable the read-only board. */ }
  }
  const records: string[] = [];
  for (const row of rows) {
    const trace = traces.get(row.name);
    if (row.state === "closed" || !trace || STORED_TASK_STATUS[row.state] === trace.derived) continue;
    const key = `${row.state}/${trace.derived}`;
    if (previous.get(`${project}/${row.name}`) === key) continue;
    records.push(JSON.stringify(decodeTrace({ at, project, row: row.name, stored: row.state, derived: trace.derived, facts: trace.facts })));
  }
  if (!records.length) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  appendFileSync(path, `${records.join("\n")}\n`, { mode: 0o600 });
}

interface Files { readonly sidecar: string | null; readonly report: boolean; readonly gates: readonly string[] }
const decodeFiles = Schema.decodeUnknownSync(Schema.Struct({ sidecar: Schema.NullOr(Schema.String), report: Schema.Boolean, gates: Schema.Array(Schema.String) }));

/** Only file presence is needed for reports; structured sidecars and receipts decode through domain.ts. */
function localFiles(cwd: string, head: string, report: string | null, home: string): Files {
  const sidecar = join(cwd, ".pi/muster/packets", head, "packet.json");
  const root = join(home, ".local/state/muster/gates");
  const present = (path: string) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  return decodeFiles({
    sidecar: present(sidecar) ? readFileSync(sidecar, "utf8") : null,
    report: [join(cwd, ".pi/muster/packets", head, "report.svx"), ...(report ? [report] : [])].some(present),
    gates: existsSync(root) ? readdirSync(root).filter(file => file.endsWith(".json")).map(file => readFileSync(join(root, file), "utf8")) : [],
  });
}

const filesScript = `import {existsSync,statSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
const [cwd,head,report] = process.argv.slice(1);
const present = p => existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;
const sidecar = join(cwd,'.pi/muster/packets',head,'packet.json');
const root = join(process.env.HOME,'.local/state/muster/gates');
process.stdout.write(JSON.stringify({sidecar:present(sidecar)?readFileSync(sidecar,'utf8'):null,
report:[join(cwd,'.pi/muster/packets',head,'report.svx'),...(report?[report]:[])].some(present),
gates:existsSync(root)?readdirSync(root).filter(f=>f.endsWith('.json')).map(f=>readFileSync(join(root,f),'utf8')):[]}));`;

const probeTask = (project: Project, row: AgentRow, panes: readonly PaneInfo[], proc: ProcShape,
  source: string, files: (head: string, report: string | null) => Effect.Effect<Files, InputError | import("./errors.ts").ProcError, MusterEnv | Proc>) =>
  Effect.gen(function* () {
    const matching = panes.filter(pane => !!pane.agent && pane.agent_session?.kind === "path" && pane.agent_session.value === row.sessionFile);
    const live = matching.length > 0;
    const liveness = matching.some(pane => pane.agent_status === "working") ? "alive" as const : "quiet" as const;
    const gaps: string[] = [];
    const facts = { live, commits: false, merged: false, report: false, gate: false, rejected: false };
    let head: string | null = null;
    let tree: string | null = null;
    const lane = project.lanes.find(lane => lane.slug === row.lane);
    const run = (cwd: string, ...args: string[]) => proc.run("git", args, { cwd, timeoutMs: 10_000 });
    const resolve = (cwd: string, ref: string) => run(cwd, "rev-parse", "--verify", `${ref}^{commit}`);
    const branch = row.clone?.branch ?? "HEAD";
    let checkout = row.cwd;
    let resolved = yield* resolve(checkout, branch).pipe(Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })));
    if (resolved.code !== 0 && source !== checkout) {
      checkout = source;
      resolved = yield* resolve(checkout, branch);
    }
    if (resolved.code !== 0) gaps.push("worker branch head unavailable");
    else head = resolved.stdout.trim();
    // Rejection remains an explicit catalog fact, never inferred from failure or pane absence.
    facts.rejected = project.packets.some(packet => packet.agent === row.name && packet.lane === row.lane && packet.state === "rejected" && (!head || packet.id === head));
    const baseSha = row.clone?.base?.sha;
    if (!baseSha) gaps.push("starting base SHA unavailable");
    if (head && baseSha) {
      const ancestor = yield* run(checkout, "merge-base", "--is-ancestor", baseSha, head);
      const count = yield* run(checkout, "rev-list", "--count", `${baseSha}..${head}`);
      if (ancestor.code !== 0 || count.code !== 0 || !/^\d+$/.test(count.stdout.trim())) gaps.push("commits beyond base unavailable");
      else facts.commits = Number(count.stdout.trim()) > 0;
    }
    if (head) {
      let target = lane?.base;
      if (!target) {
        const symbolic = yield* run(source, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
        target = symbolic.code === 0 ? symbolic.stdout.trim() : "main";
      }
      const base = yield* resolve(source, target);
      if (base.code !== 0) gaps.push("lane base head unavailable");
      else {
        const object = yield* proc.run("git", ["cat-file", "--batch-check"], { cwd: source, timeoutMs: 10_000, input: `${head}\n` });
        // A source that has never fetched this head cannot contain its merge.
        if (object.code === 0 && object.stdout.trim() === `${head} missing`) facts.merged = false;
        else {
          const merged = yield* run(source, "merge-base", "--is-ancestor", head, base.stdout.trim());
          if (merged.code !== 0 && merged.code !== 1) gaps.push("merge reachability unavailable");
          else facts.merged = merged.code === 0;
        }
        // Find the first base-line commit containing the worker head. Later base
        // commits must not invalidate the receipt for the actual merged tree.
        let landing = base.stdout.trim();
        if (facts.merged && facts.commits && baseSha) {
          const history = yield* run(source, "rev-list", "--first-parent", "--reverse", `${baseSha}..${landing}`);
          if (history.code !== 0) gaps.push("merge history unavailable");
          else for (const candidate of history.stdout.trim().split("\n").filter(Boolean)) {
            const contains = yield* run(source, "merge-base", "--is-ancestor", head, candidate);
            if (contains.code === 0) { landing = candidate; break; }
            if (contains.code !== 1) { gaps.push("merge history reachability unavailable"); break; }
          }
        }
        const mergedTree = yield* run(source, "rev-parse", "--verify", `${landing}^{tree}`);
        if (mergedTree.code !== 0) gaps.push("merged tree unavailable");
        else tree = mergedTree.stdout.trim();
      }
      // Catalog locates a report only; its presence proves reporting, not packet state.
      const packet = project.packets.find(packet => packet.agent === row.name && packet.lane === row.lane && packet.id === head && packet.kind === "commit");
      const evidence = yield* files(head, packet?.report ?? null);
      facts.report = evidence.report;
      if (evidence.sidecar) {
        try {
          const sidecar = decodeRemotePacket(JSON.parse(evidence.sidecar));
          if (sidecar.project === project.slug && sidecar.machine === row.machine && sidecar.packet.agent === row.name && sidecar.packet.lane === row.lane && sidecar.packet.id === head && sidecar.packet.kind === "commit") facts.report = true;
          else gaps.push("packet sidecar identity disagrees");
        } catch { gaps.push("packet sidecar invalid"); }
      }
      for (const raw of evidence.gates) {
        try {
          const receipt = decodeGate(JSON.parse(raw));
          if (tree && receipt.tree === tree && receipt.exit === 0 && receipt.exactTree !== false) facts.gate = true;
        } catch { /* Other or incomplete gate receipts are not proof. */ }
      }
    }
    return { derived: facts.rejected ? "rejected" : gaps.length ? "?" : deriveTaskStatus(facts), liveness, facts: { ...facts, head, tree, gaps } } satisfies TaskTrace;
  });

/** Read-only shadow projection. Existing SSH and Herdr helpers are the only remote transport. */
export const traceProjectTasks = (project: Project, panes: readonly PaneInfo[]) => Effect.gen(function* () {
  const env = yield* MusterEnv;
  const proc = yield* Proc;
  const traces = new Map<string, TaskTrace>();
  const remotePanes = new Map<string, readonly PaneInfo[]>();
  for (const row of project.agents) {
    if (row.state === "closed") continue;
    const source = sourceOf(project, project.lanes.find(lane => lane.slug === row.lane), row);
    const result = yield* Effect.gen(function* () {
      if (row.machine === "local") return yield* probeTask(project, row, panes, proc, source,
        (head, report) => io(() => localFiles(row.cwd, head, report, env.home)));
      const machine = yield* machineConfig(row.machine);
      if (!remotePanes.has(row.machine)) remotePanes.set(row.machine, yield* onRemote(row.machine, machine, paneList()));
      const runner = sshProc(row.machine, machine, proc, env.home);
      return yield* probeTask(project, row, remotePanes.get(row.machine)!, runner, mapPath(source, machine),
        (head, report) => remoteNode(row.machine, machine, filesScript, [row.cwd, head, report ? mapPath(report, machine) : ""]).pipe(
          Effect.flatMap(raw => io(() => decodeFiles(JSON.parse(raw))))));
    }).pipe(Effect.catch(error => Effect.succeed<TaskTrace>({ derived: "?", liveness: "?", facts: {
      live: false, commits: false, merged: false, report: false, gate: false,
      rejected: project.packets.some(packet => packet.agent === row.name && packet.lane === row.lane && packet.state === "rejected"),
      head: null, tree: null, gaps: [`facts unavailable: ${error.message}`],
    } })));
    traces.set(row.name, result);
  }
  // Logging failure must not change the tool's lifecycle behavior or hide its board.
  const warning = yield* io(() => appendTaskTraces(env.home, env.now().toISOString(), project.slug, project.agents, traces)).pipe(
    Effect.as(null as string | null), Effect.catch(error => Effect.succeed(error.message)));
  return { traces, warning };
});
