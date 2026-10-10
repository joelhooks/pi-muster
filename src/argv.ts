import { fileURLToPath } from "node:url";
import type { AgentRow, LaunchProfile, Project, Role, RoleDefaults } from "./domain.ts";
import { ROLE_DEFAULTS } from "./domain.ts";

/** Loaders that keep function names (tsx, esbuild keepNames) wrap a serialized function's inner
 * functions in `__name(...)`. A bare remote `node -e` has no such helper, so every script that
 * embeds `fn.toString()` starts with this shim. */
export const NAME_SHIM = "globalThis.__name ??= (fn) => fn;";

export type LaunchKind = "launch" | "fork" | "restore";

/** Flags that shrink the tool registry. They silently drop unknown names, so Muster never emits them. */
export const FORBIDDEN_FLAGS = ["--tools", "-t", "--exclude-tools", "-xt", "--no-tools", "-nt", "--no-builtin-tools", "-nbt"];

export interface ArgvInput {
  readonly kind: LaunchKind;
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly parentSessionFile: string | null;
  readonly profile: LaunchProfile;
  readonly musterExtension: string | null;
  readonly prompt?: string;
  readonly promptFile?: string;
}

function value(flag: string, text: string): readonly [string, string] {
  if (text.length === 0 || text.startsWith("-")) {
    throw new Error(`${flag} value ${JSON.stringify(text)} would parse as a flag`);
  }
  return [flag, text];
}

/**
 * The exact Pi argv for one agent. Everything that shapes the fixed prompt
 * prefix is set here, once: bridge lanes fail closed when the prompt changes
 * mid-session, and the prefix is the part every turn re-reads from cache.
 */
export function buildArgv(input: ArgvInput): string[] {
  const { profile } = input;
  const argv: string[] = [];
  if (input.kind === "fork") {
    if (!input.parentSessionFile) throw new Error("fork needs the parent's session file");
    argv.push(...value("--fork", input.parentSessionFile), "--session-id", input.sessionId);
  } else if (input.kind === "restore" && input.sessionFile) {
    argv.push(...value("--session", input.sessionFile));
  } else {
    argv.push("--session-id", input.sessionId);
  }
  argv.push(...value("--name", profile.label));
  argv.push(...value("--model", profile.thinking ? `${profile.model}:${profile.thinking}` : profile.model));
  for (const prompt of profile.appendSystemPrompt) argv.push(...value("--append-system-prompt", prompt));
  if (profile.noSkills) argv.push("-ns");
  for (const skill of profile.skills) argv.push(...value("--skill", skill));
  const extensions = input.musterExtension ? [input.musterExtension, ...profile.extensions] : profile.extensions;
  for (const extension of new Set(extensions)) argv.push(...value("-e", extension));
  // Always explicit: without the flag the role default comes back, so "off" must say off.
  argv.push("--compact-at", profile.compactAt === null ? "off" : String(profile.compactAt));
  argv.push("--approve");
  const forbidden = argv.filter((arg) => FORBIDDEN_FLAGS.includes(arg));
  if (forbidden.length > 0) throw new Error(`argv contains tool-registry flags: ${forbidden.join(", ")}`);
  if (input.prompt || input.promptFile) {
    argv.push("--");
    if (input.promptFile) argv.push(`@${input.promptFile}`);
    if (input.prompt) argv.push(input.prompt);
  }
  return argv;
}

export interface ProfileInput {
  readonly label: string;
  readonly model?: string | undefined;
  readonly thinking?: LaunchProfile["thinking"] | undefined;
  readonly appendSystemPrompt?: readonly string[] | undefined;
  readonly noSkills?: boolean | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly extensions?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly compactAt?: number | null | undefined;
}

export function profileFor(role: Role, input: ProfileInput, d: RoleDefaults = ROLE_DEFAULTS[role]): LaunchProfile {
  const noSkills = input.noSkills ?? d.noSkills;
  const requested = [...(d.skills ?? []), ...(input.skills ?? [])];
  const musterSkill = fileURLToPath(new URL("../skills/muster", import.meta.url));
  const roleSkills = !noSkills && role !== "worker"
    ? [musterSkill, ...requested.filter(skill => skill !== "muster" && skill !== musterSkill && skill !== `${musterSkill}/SKILL.md`)]
    : requested;
  return {
    label: input.label,
    model: input.model ?? d.model,
    thinking: input.thinking === undefined ? d.thinking : input.thinking,
    appendSystemPrompt: [...(input.appendSystemPrompt ?? [])],
    noSkills,
    skills: [...new Set(roleSkills)],
    extensions: [...(input.extensions ?? [])],
    env: { ...(input.env ?? {}) },
    compactAt: input.compactAt === undefined ? d.compactAt : input.compactAt,
  };
}

/** Environment a launched agent receives. Muster's worker tools read these; nothing else does. */
export function agentEnv(project: Project, row: AgentRow): Record<string, string> {
  return {
    ...row.profile.env,
    ...(row.role === "desk" ? { HERDR_DESK_PROJECT: project.slug } : {}),
    MUSTER_PROJECT: project.dir,
    MUSTER_AGENT: row.name,
    MUSTER_OWNER: row.owner,
    ...(row.ownerName ? { MUSTER_OWNER_NAME: row.ownerName } : {}),
    MUSTER_LANE: row.lane,
    MUSTER_ROLE: row.role,
    ...(project.policy?.comms === "ratking" ? { MUSTER_COMMS: "ratking" } : {}),
    // pi-ratking claims this name; Muster mints nothing.
    RATKING_NAME: `${project.slug}/${row.name}`,
  };
}

export function extensionsFor(project: Project, row: AgentRow): LaunchProfile {
  if (row.role !== "desk" || !project.deskExtension) return row.profile;
  if (row.profile.extensions.includes(project.deskExtension)) return row.profile;
  return { ...row.profile, extensions: [...row.profile.extensions, project.deskExtension] };
}

export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * One line that sets the cwd and the environment in a fresh shell. `pathPrepend`
 * extends the shell's own PATH, so a long owner PATH is never typed into a pane.
 */
export function shellPrelude(cwd: string, env: Readonly<Record<string, string>>, pathPrepend?: string): string {
  const exports = Object.entries(env).map(([key, val]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`invalid env name ${key}`);
    return `export ${key}=${shellQuote(val)}`;
  });
  const path = pathPrepend ? [`export PATH=${shellQuote(pathPrepend)}:"$PATH"`] : [];
  return [`cd ${shellQuote(cwd)}`, ...exports, ...path].join(" && ");
}

/** Pi names a session file `<timestamp>_<session id>.jsonl`. */
export function sessionIdFromFile(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const at = base.indexOf("_");
  if (at < 0 || !base.endsWith(".jsonl")) return null;
  return base.slice(at + 1, -".jsonl".length) || null;
}

export function mintSessionId(name: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${name}-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

export function sessionDirFor(cwd: string, home: string): string {
  return `${home}/.pi/agent/sessions/--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
