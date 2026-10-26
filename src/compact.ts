import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ROLE_DEFAULTS } from "./domain.ts";
import type { Role } from "./domain.ts";

/**
 * Per-role compaction, absorbed from dark-wizard `herdr/lane-compact`. The
 * threshold is a cost policy (see `ROLE_DEFAULTS`): a live `/compact-at`
 * setting persisted in the session wins, then the flag, then the role default
 * from `MUSTER_ROLE`, then `PI_COMPACT_AT`. It compacts at `agent_end`, between
 * turns, never mid-turn.
 */
const ENTRY_TYPE = "compact-at";

/**
 * agent_ends that stay over the threshold after a landed compaction before compact-at tries again. A kept tail that is
 * itself over the threshold would otherwise compact on every turn, a summary and a full cache rebuild each time
 * (Tin-Tin, #35); a run that grew past the threshold still compacts on its third over-threshold end.
 */
export const COOLDOWN_ENDS = 2;

export function parseThreshold(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === true || raw === false) return undefined;
  const text = String(raw).trim().toLowerCase();
  if (text === "off") return null;
  const value = Number(text.replace(/[_,]/g, ""));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function roleThreshold(role: string | undefined): number | null | undefined {
  return role && role in ROLE_DEFAULTS ? ROLE_DEFAULTS[role as Role].compactAt : undefined;
}

export interface PiCompaction { readonly enabled: boolean; readonly reserveTokens: number }

/**
 * Pi compacts on its own, inside the run, above `contextWindow - reserveTokens`. When that is at or below compactAt,
 * compact-at only duplicates it, and its `ctx.compact()` aborts the run and leaves the session idle mid-summary: a wake
 * then starts a turn on the old context and Pi starts a second compaction (drovr-desk-2, 2026-10-17, MacLeod).
 */
export function piCompactsFirst(threshold: number, contextWindow: number, settings: PiCompaction | undefined): number | null {
  if (!settings?.enabled || !(contextWindow > 0)) return null;
  const auto = contextWindow - settings.reserveTokens;
  return auto <= threshold ? auto : null;
}

/** Pi 1.3 resolves reserveTokens per model (compaction.modelOverrides); 0.79 ignores the argument. Unreadable settings keep compact-at on. */
const readPiCompaction = (cwd: string, model?: unknown): PiCompaction | undefined => {
  try {
    const settings = SettingsManager.create(cwd);
    return (settings.getCompactionSettings as (model?: unknown) => PiCompaction).call(settings, model);
  } catch { return undefined; }
};

export function registerCompaction(pi: ExtensionAPI, env: Readonly<Record<string, string | undefined>>, piCompaction: (cwd: string, model?: unknown) => PiCompaction | undefined = readPiCompaction) {
  pi.registerFlag("compact-at", {
    description: "Compact at agent_end when context tokens exceed this count, or 'off'. Muster sets it per role as a cache-cost policy.",
    type: "string",
  });

  let threshold: number | null = null;
  let armed = true;
  let cooldown = 0;

  const restore = (ctx: ExtensionContext) => {
    let value = parseThreshold(env.PI_COMPACT_AT);
    const role = roleThreshold(env.MUSTER_ROLE);
    if (role !== undefined) value = role;
    const flag = parseThreshold(pi.getFlag("compact-at"));
    if (flag !== undefined) value = flag;
    for (const entry of ctx.sessionManager.getEntries() as ReadonlyArray<{ type?: string; customType?: string; data?: { threshold?: unknown } }>) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        const persisted = parseThreshold(entry.data?.threshold);
        if (persisted !== undefined) value = persisted;
      }
    }
    threshold = value ?? null;
    armed = true;
  };

  pi.on("session_start", (_event, ctx) => restore(ctx));
  // MacLeod, 2026-10-26: a run that grew from the kept tail past the threshold before its first agent_end never saw
  // tokens at or below it, so a landed compaction left compact-at disarmed for good (flowing-pi ccanary: 238K, 276K,
  // 284K, no compaction). Any landed compaction, ours or Pi's, starts a new crossing.
  pi.on("session_compact", () => { armed = true; cooldown = COOLDOWN_ENDS; });

  pi.on("agent_end", (_event, ctx) => {
    if (threshold === null) return;
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens;
    if (tokens === null || tokens === undefined) return;
    if (tokens <= threshold) {
      armed = true;
      cooldown = 0;
      return;
    }
    if (!armed) return;
    if (cooldown > 0) {
      // Limits alarm; they don't loop. Say it once per landed compaction, with the numbers.
      if (cooldown === COOLDOWN_ENDS && ctx.hasUI) ctx.ui.notify(`compact-at: still ${tokens} > ${threshold} tokens after a compaction; trying again in ${COOLDOWN_ENDS} turns. If it repeats, the kept tail exceeds the threshold: raise /compact-at`, "warning");
      cooldown -= 1;
      return;
    }
    armed = false;
    const auto = piCompactsFirst(threshold, usage?.contextWindow ?? 0, piCompaction(ctx.cwd, ctx.model));
    if (auto !== null) {
      if (ctx.hasUI) ctx.ui.notify(`compact-at: Pi compacts this model at ${auto} tokens, inside the run; standing down at ${threshold}`, "info");
      return;
    }
    if (ctx.hasUI) ctx.ui.notify(`compact-at: ${tokens} > ${threshold} tokens, compacting`, "info");
    ctx.compact({
      onError: (error) => {
        // Pi 1.3.0-p4 refuses a manual compaction while its own runs (MacLeod, 2026-10-17). Pi's brings the context
        // down, so this crossing is handled: no retry, no error.
        if (/compaction already in progress/i.test(error.message)) {
          if (ctx.hasUI) ctx.ui.notify("compact-at: Pi is already compacting; standing down", "info");
          return;
        }
        armed = true;
        if (ctx.hasUI) ctx.ui.notify(`compact-at: compaction failed: ${error.message}`, "error");
      },
    });
  });

  pi.registerCommand("compact-at", {
    description: "Set the live compaction threshold: /compact-at <tokens|off> (no args shows it)",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify(`compact-at: ${threshold ?? "off"}`, "info");
        return;
      }
      const value = parseThreshold(text);
      if (value === undefined) {
        ctx.ui.notify("compact-at: expected a positive token count or 'off'", "error");
        return;
      }
      threshold = value;
      armed = true;
      pi.appendEntry(ENTRY_TYPE, { threshold: value === null ? "off" : value });
      ctx.ui.notify(`compact-at: ${value ?? "off"}`, "info");
    },
  });
}
