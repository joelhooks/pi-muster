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

  pi.on("agent_end", (_event, ctx) => {
    if (threshold === null) return;
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens;
    if (tokens === null || tokens === undefined) return;
    if (tokens <= threshold) {
      armed = true;
      return;
    }
    if (!armed) return;
    armed = false;
    const auto = piCompactsFirst(threshold, usage?.contextWindow ?? 0, piCompaction(ctx.cwd, ctx.model));
    if (auto !== null) {
      if (ctx.hasUI) ctx.ui.notify(`compact-at: Pi compacts this model at ${auto} tokens, inside the run; standing down at ${threshold}`, "info");
      return;
    }
    if (ctx.hasUI) ctx.ui.notify(`compact-at: ${tokens} > ${threshold} tokens, compacting`, "info");
    ctx.compact({
      onError: (error) => {
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
