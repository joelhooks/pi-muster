import { Effect, Schema } from "effect";
import type { Packet, Project } from "./domain.ts";
import { sourceOf } from "./packet.ts";
import { Proc } from "./runtime.ts";

export interface Landing { readonly sha: string; readonly pr?: number; readonly by?: string; readonly how: "ancestor" | "squash"; readonly base: string }
const Pull = Schema.Struct({
  number: Schema.Number, merged_at: Schema.NullOr(Schema.String), merge_commit_sha: Schema.NullOr(Schema.String),
  base: Schema.Struct({ ref: Schema.String }),
  merged_by: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
});
const decodePulls = Schema.decodeUnknownSync(Schema.Array(Pull));
const decodePull = Schema.decodeUnknownSync(Pull);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const AUTOLAND_CAP = 10;
export const AUTOLAND_RECHECK_MS = 10 * 60_000;
export const autolandEligible = (packet: Packet) => packet.kind === "commit" && (packet.state === "reported" || packet.state === "verified");

/** Evidence only: fetches refs, never changes the index, checkout, PR or agent. */
export const findLanding = (project: Project, packet: Packet, options: { notes?: string[]; fetch?: boolean } = {}) =>
  Effect.gen(function* () {
    if (!autolandEligible(packet) || !SHA.test(packet.id)) return null;
    const row = project.agents.find(row => row.name === packet.agent);
    if (!row) return null;
    const lane = project.lanes.find(lane => lane.slug === packet.lane);
    const cwd = sourceOf(project, lane, row);
    const proc = yield* Proc;
    const deadline = Date.now() + 10_000;
    const run = (command: string, args: readonly string[], dir = cwd) => proc.run(command, args, {
      cwd: dir, timeoutMs: Math.max(1, deadline - Date.now()), env: { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    }).pipe(Effect.catch(error => {
      options.notes?.push(`autoland: ${command} unavailable: ${error.message}`);
      return Effect.succeed({ code: -1, stdout: "", stderr: "" });
    }));
    const symbolic = yield* run("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    const base = lane?.base?.replace(/^(?:(?:refs\/remotes\/)?origin\/|refs\/heads\/)/, "") ??
      (symbolic.code === 0 ? symbolic.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : "main");
    // A lane starting from a sha is not a landing branch.
    if (SHA.test(base) || (yield* run("git", ["check-ref-format", `refs/heads/${base}`])).code !== 0) return null;
    if (options.fetch !== false) {
      const fetched = yield* run("git", ["fetch", "--no-tags", "--", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`]);
      if (fetched.code !== 0) { options.notes?.push(`autoland: fetch origin/${base} failed; not using stale refs`); return null; }
    }
    const onBase = (sha: string) => run("git", ["merge-base", "--is-ancestor", sha, `refs/remotes/origin/${base}`]);
    if ((yield* onBase(packet.id)).code === 0) return { sha: packet.id, base, how: "ancestor" as const };
    const remote = yield* run("git", ["remote", "get-url", "origin"]);
    const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote.stdout.trim())?.[1];
    if (!repo) { options.notes?.push("autoland: no GitHub origin; ancestor-only"); return null; }
    const candidates = [packet.id];
    // A later worker head is usable only when it provably contains this packet.
    if (row.clone) {
      const head = yield* run("git", ["rev-parse", "HEAD"], row.cwd);
      const sha = head.stdout.trim();
      if (SHA.test(sha) && sha !== packet.id && (yield* run("git", ["merge-base", "--is-ancestor", packet.id, sha], row.cwd)).code === 0) candidates.push(sha);
    }
    for (const sha of candidates) {
      if (Date.now() >= deadline) break;
      const result = yield* run("gh", ["api", `repos/${repo}/commits/${sha}/pulls`, "--paginate", "--slurp"]);
      if (result.code !== 0) { options.notes?.push("autoland: gh lookup failed; ancestor-only"); return null; }
      const pulls = yield* Effect.try({ try: () => {
        const pages: unknown = JSON.parse(result.stdout);
        // --slurp wraps each page; injected runners may return a single page.
        return decodePulls(Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : pages);
      }, catch: () => new Error("invalid GitHub pull response") }).pipe(Effect.catch(error => {
        options.notes?.push(`autoland: ${error.message}`); return Effect.succeed([]);
      }));
      for (const pull of pulls) {
        if (Date.now() >= deadline) break;
        if (!pull.merged_at || !pull.merge_commit_sha || !SHA.test(pull.merge_commit_sha) || pull.base.ref !== base) continue;
        if ((yield* onBase(pull.merge_commit_sha)).code !== 0) continue;
        let by = pull.merged_by?.login;
        if (!by && Date.now() < deadline) {
          const detail = yield* run("gh", ["api", `repos/${repo}/pulls/${pull.number}`]);
          if (detail.code === 0) by = yield* Effect.try({ try: () => decodePull(JSON.parse(detail.stdout)).merged_by?.login, catch: () => new Error("invalid PR detail") }).pipe(Effect.orElseSucceed(() => undefined));
        }
        return { sha: pull.merge_commit_sha, base, pr: pull.number, ...(by ? { by } : {}), how: "squash" as const };
      }
    }
    return null;
  });

export const landingEvidence = (landing: Landing, base: string) => landing.how === "ancestor"
  ? `auto: ${landing.sha.slice(0, 8)} is on origin/${base}`
  : `auto: PR #${landing.pr} squash-merged by ${landing.by ?? "unknown"} as ${landing.sha.slice(0, 8)} on ${base}`;
