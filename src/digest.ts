// Pi TUI patterns: column-gauge, snapshot-lens. Fit whole telemetry parts
// before dropping detail; a narrow header collapses at word boundaries.
import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit, Schema } from "effect";
import { visibleWidth } from "@earendil-works/pi-tui";
import { decodeProject, silenceLimits } from "./domain.ts";
import { projectPath } from "./store.ts";

export class BadProjectDir extends Error {}
export type DigestPart = { state: "ok"; text: string; compact: string } | { state: "unknown"; text: string; compact: string } | { state: "skipped"; text: ""; compact: "" };
export type PartName = "prs" | "kodiak" | "main" | "gates" | "agents" | "packets";
export interface DigestResult { line: string; parts: Record<PartName, DigestPart>; notes: string[] }
export interface DigestOptions {
  now?: Date;
  width?: number;
  timeoutMs?: number;
  env?: Readonly<NodeJS.ProcessEnv>;
  run?: (command: string, args: readonly string[], options: { cwd: string; signal: AbortSignal; env: Readonly<NodeJS.ProcessEnv> }) => Promise<string>;
  available?: (command: string) => Promise<boolean>;
}
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Check = Schema.Struct({ name: Schema.optionalKey(Schema.String), context: Schema.optionalKey(Schema.String), state: Schema.optionalKey(Schema.String), status: Schema.optionalKey(Schema.String), conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)), startedAt: Schema.optionalKey(Schema.String), createdAt: Schema.optionalKey(Schema.String) });
const Pulls = Schema.Array(Schema.Struct({ number: Count, isDraft: Schema.Boolean, createdAt: Schema.String, statusCheckRollup: Schema.NullOr(Schema.Array(Check)), labels: Schema.Array(Schema.Struct({ name: Schema.String })), mergeStateStatus: Schema.String, autoMergeRequest: Schema.NullOr(Schema.Unknown) }));
const Runs = Schema.Array(Schema.Struct({ status: Schema.String, conclusion: Schema.NullOr(Schema.String) }));
const Slot = Schema.Struct({ held: Schema.Boolean, window: Schema.optionalKey(Schema.NullOr(Schema.String)) });
const Gate = Schema.Struct({ slots: Count, holders: Schema.Array(Slot), queue: Schema.optionalKey(Schema.Array(Schema.Unknown)), deploySlot: Schema.optionalKey(Slot), exclusivePending: Schema.optionalKey(Slot) });
const Fleet = Schema.Struct({ machines: Schema.Array(Schema.Struct({ reading: Schema.Struct({ state: Schema.String, data: Schema.optionalKey(Schema.Unknown) }) })), queue: Schema.Array(Schema.Unknown), leases: Schema.Struct({ leases: Schema.Array(Schema.Struct({ state: Schema.optionalKey(Schema.String), label: Schema.optionalKey(Schema.String), kind: Schema.optionalKey(Schema.String) })) }) });
const Branch = Schema.Struct({ defaultBranchRef: Schema.Struct({ name: Schema.String }) });
const parse = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, text: string): S["Type"] => Schema.decodeUnknownSync(schema)(JSON.parse(text));
const ok = (text: string, compact = text): DigestPart => ({ state: "ok", text, compact });
const skipped: DigestPart = { state: "skipped", text: "", compact: "" };
const labels: Record<PartName, string> = { prs: "PRs", kodiak: "kodiak", main: "main", gates: "gates", agents: "agents", packets: "packets" };
const age = (at: string, now: Date) => {
  const ms = now.getTime() - Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error("invalid timestamp");
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
};
const oldest = (dates: readonly string[], now: Date) => dates.length ? ` (${age(dates.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b), now)})` : "";
const failed = (check: typeof Check.Type) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes((check.conclusion ?? check.state ?? "").toUpperCase());
const pending = (check: typeof Check.Type) => !failed(check) && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes((check.conclusion ?? check.state ?? "").toUpperCase());

export function pullPart(text: string): DigestPart {
  const pulls = parse(Pulls, text).filter(p => !p.isDraft);
  let ready = 0, waiting = 0, failing = 0;
  for (const p of pulls) {
    const checks = p.statusCheckRollup ?? [];
    if (checks.some(failed)) failing++;
    else if (checks.some(pending) || !["CLEAN", "HAS_HOOKS"].includes(p.mergeStateStatus)) waiting++;
    else ready++;
  }
  return ok(`PRs ${pulls.length} ready ✅${ready} ⏳${waiting} ❌${failing}`, `PRs ✅${ready} ⏳${waiting} ❌${failing}`);
}

/** The oldest age is the Kodiak context start when available, otherwise PR creation (not label time). */
export function kodiakPart(text: string, label: string, now: Date): DigestPart {
  const dates = parse(Pulls, text).filter(p => !p.isDraft && (p.labels.some(l => l.name === label) || p.autoMergeRequest !== null))
    .filter(p => !(p.statusCheckRollup ?? []).some(c => (c.context ?? c.name ?? "").toLowerCase().includes("kodiakhq") && failed(c)))
    .map(p => { const c = p.statusCheckRollup?.find(c => (c.context ?? c.name ?? "").toLowerCase().includes("kodiakhq")); return c?.startedAt || c?.createdAt || p.createdAt; });
  return ok(`kodiak ${dates.length}${oldest(dates, now)}`, `kodiak ${dates.length}`);
}

export function mainPart(text: string): DigestPart {
  const runs = parse(Runs, text);
  const completed = runs.find(r => r.status === "completed");
  if (!runs.length) return ok("main –");
  const state = completed ? completed.conclusion === "success" ? "✅" : "❌" : "running";
  return ok(`main ${state}`);
}

export function gatesPart(text: string, fleet: boolean): DigestPart {
  let used = 0, total = 0, queue = 0, deploy = false;
  if (fleet) {
    const data = parse(Fleet, text);
    for (const machine of data.machines) {
      if (machine.reading.state !== "live") throw new Error("fleet machine status unavailable");
      // Some fleet machines are not gate hosts and have no slots.
      const raw = machine.reading.data;
      if (typeof raw !== "object" || raw === null || !("slots" in raw)) continue;
      const gate = Schema.decodeUnknownSync(Gate)(raw);
      total += gate.slots; used += gate.holders.filter(h => h.held).length;
      deploy ||= !!gate.deploySlot?.held || !!gate.exclusivePending?.held;
    }
    queue = data.queue.length;
    deploy ||= data.leases.leases.some(l => l.state === "active");
  } else {
    const data = parse(Gate, text);
    total = data.slots; used = data.holders.filter(h => h.held).length; queue = data.queue?.length ?? 0;
    deploy = !!data.deploySlot?.held || !!data.exclusivePending?.held;
  }
  return ok(`gates ${used}/${total} q${queue}${deploy ? " deploy" : ""}`);
}

export const liveDigestRunner: NonNullable<DigestOptions["run"]> = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, [...args], { cwd: options.cwd, env: options.env, signal: options.signal, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
async function executable(command: string, env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    try { await access(join(dir, command), constants.X_OK); return true; } catch { /* next PATH entry */ }
  }
  return false;
}

/** No state writes, clocks, pane reads or input. Each source owns its deadline and failure note. */
export async function projectDigest(dir: string, options: DigestOptions = {}): Promise<DigestResult> {
  try { if (!(await stat(dir)).isDirectory()) throw new Error("not a directory"); } catch { throw new BadProjectDir(`Bad project dir: ${dir}`); }
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const run = options.run ?? liveDigestRunner;
  const available = options.available ?? (command => executable(command, env));
  const notes: string[] = [];
  const timeout = options.timeoutMs ?? 10_000;
  async function source<A>(name: string, task: (signal: AbortSignal) => Promise<A>): Promise<{ ok: true; value: A } | { ok: false }> {
    const exit = await Effect.runPromiseExit(Effect.tryPromise({ try: task, catch: error => new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`) }).pipe(Effect.timeout(timeout)));
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
    notes.push(`${name}: ${Cause.pretty(exit.cause).replace(/\s+/g, " ").slice(0, 240)}`);
    return { ok: false };
  }
  const unknown = (name: PartName): DigestPart => ({ state: "unknown", text: `${labels[name]} ?`, compact: `${labels[name]} ?` });
  async function part(name: PartName, task: (signal: AbortSignal) => Promise<DigestPart>): Promise<DigestPart> {
    const result = await source(name, task);
    return result.ok ? result.value : unknown(name);
  }
  const cmd = (signal: AbortSignal, command: string, args: readonly string[]) => run(command, args, { cwd: dir, env, signal });
  const catalog = await source("catalog", async signal => decodeProject(JSON.parse(await readFile(projectPath(dir), { encoding: "utf8", signal }))));
  const project = catalog.ok ? catalog.value : undefined;
  const readPulls = (signal: AbortSignal, repo: string) => cmd(signal, "gh", ["pr", "list", "--repo", repo, "--state", "open", "--limit", "1000", "--json", "number,isDraft,createdAt,statusCheckRollup,labels,mergeStateStatus,autoMergeRequest"]);
  const github = async (): Promise<Pick<DigestResult["parts"], "prs" | "kodiak" | "main">> => {
    const remote = await source("GitHub remote", async signal => {
      const text = await cmd(signal, "git", ["remote", "-v"]);
      return /(?:github\.com[:/])([^/\s]+\/[^\s]+?)(?:\.git)?\s/.exec(text)?.[1];
    });
    if (!remote.ok) return { prs: unknown("prs"), kodiak: unknown("kodiak"), main: unknown("main") };
    if (!remote.value || !await available("gh")) {
      notes.push(!remote.value ? "GitHub skipped: no GitHub remote" : "GitHub skipped: gh is missing");
      return { prs: skipped, kodiak: skipped, main: skipped };
    }
    const [prs, kodiak, main] = await Promise.all([
      part("prs", async signal => pullPart(await readPulls(signal, remote.value!))),
      part("kodiak", async signal => {
        let label = "automerge";
        try {
          const config = await readFile(join(dir, ".kodiak.toml"), { encoding: "utf8", signal });
          let table = "";
          for (const line of config.split(/\r?\n/)) {
            const section = /^\s*\[([^\]]+)\]/.exec(line);
            if (section) table = section[1] ?? "";
            const match = /^\s*(automerge_label|merge\.automerge_label)\s*=\s*["']([^"']+)["']/.exec(line);
            if (match && (table === "merge" || (table === "" && match[1] === "merge.automerge_label"))) label = match[2] ?? label;
          }
        } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        return kodiakPart(await readPulls(signal, remote.value!), label, now);
      }),
      part("main", async signal => {
        const base = parse(Branch, await cmd(signal, "gh", ["repo", "view", remote.value!, "--json", "defaultBranchRef"])).defaultBranchRef.name;
        return mainPart(await cmd(signal, "gh", ["run", "list", "--branch", base, "--limit", "5", "--json", "status,conclusion,createdAt"]));
      }),
    ]);
    return { prs, kodiak, main };
  };
  const [gh, gates, agents, packets] = await Promise.all([
    github(),
    part("gates", async signal => {
      const fleet = env.MUSTER_FLEET_COMPUTE !== "off" && await available("fleet-compute");
      const text = fleet ? await cmd(signal, "fleet-compute", ["status", "--json"])
        : await available("muster-heavy") ? await cmd(signal, "muster-heavy", ["status", "--json"])
        : await cmd(signal, process.execPath, [fileURLToPath(new URL("../bin/muster-heavy.ts", import.meta.url)), "status", "--json"]);
      return gatesPart(text, fleet);
    }),
    part("agents", async () => {
      if (!project) throw new Error("catalog unavailable");
      let working = 0, idle = 0, stale = 0;
      await Promise.all(project.agents.filter(a => a.state !== "closed" && a.state !== "planned").map(async a => {
        if (["reported", "verified", "landed"].includes(a.state)) { idle++; return; }
        const mtime = a.sessionFile ? (await stat(a.sessionFile)).mtimeMs : Date.parse(a.updatedAt);
        if (!Number.isFinite(mtime)) throw new Error("invalid session timestamp");
        if (now.getTime() - mtime >= silenceLimits(project.policy).nudgeMs || ["failed", "interrupted"].includes(a.state)) stale++;
        else working++;
      }));
      return ok(`agents ${working} work ${idle} idle ${stale} stale`, `agents ${working}w ${idle}i ${stale}s`);
    }),
    part("packets", async () => {
      if (!project) throw new Error("catalog unavailable");
      const rows = project.packets.filter(p => p.state === "reported" || p.state === "verified");
      return ok(`packets ${rows.length} to land${oldest(rows.map(p => p.reportedAt), now)}`, `packets ${rows.length}`);
    }),
  ]);
  const parts = { ...gh, gates, agents, packets };
  const clock = now.toTimeString().slice(0, 5);
  return { line: digestLine(`${project?.slug ?? basename(dir)} ${clock}`, parts, options.width ?? 160), parts, notes: notes.sort() };
}

export function digestLine(header: string, parts: DigestResult["parts"], width: number): string {
  const cap = Math.max(1, Math.min(160, Math.floor(width) || 160));
  const clean = (s: string) => s.replace(/[\r\n\t\u001b]/g, " ");
  const rows = Object.values(parts).filter(p => p.state !== "skipped");
  let line = [clean(header), ...rows.map(p => p.text)].join(" · ");
  if (visibleWidth(line) <= cap) return line;
  line = [clean(header), ...rows.map(p => p.compact)].join(" · ");
  if (visibleWidth(line) <= cap) return line;
  // Drop whole low-priority parts, never cut a number or emoji in half.
  const chunks = [clean(header), ...rows.map(p => p.compact)];
  while (chunks.length > 1 && visibleWidth(chunks.join(" · ")) > cap) chunks.pop();
  line = chunks.join(" · ");
  if (visibleWidth(line) <= cap) return line;
  let shortened = "";
  for (const word of line.split(/\s+/)) {
    const next = shortened ? `${shortened} ${word}` : word;
    if (visibleWidth(next + "…") > cap) break;
    shortened = next;
  }
  return shortened + "…";
}
