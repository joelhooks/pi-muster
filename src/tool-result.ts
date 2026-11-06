import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { registryPath } from "./registry.ts";

export const DETAILS_LIMIT = 16 * 1024;
export const TEXT_LIMIT = 32 * 1024;
const TEXT_PREVIEW = 24 * 1024;

/** Bound the actual JSON bytes Pi persists, not JavaScript character counts. */
export function boundedDetails(value: unknown, tool?: string): unknown {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= DETAILS_LIMIT) return JSON.parse(serialized) as unknown;
  // Keys can themselves be huge. Keep the summary bounded even for hostile key names/counts.
  const keys = value !== null && typeof value === "object" ? Object.keys(value).slice(0, 32).map(key => Buffer.from(key).subarray(0, 64).toString("utf8")) : [];
  const ok = !(value !== null && typeof value === "object" && "ok" in value && value.ok === false);
  return { ok, truncated: true, bytes, keys, ...(tool ? { tool } : {}) };
}

const SPILL_NAME = /^[a-zA-Z0-9_-]+-\d+-[0-9a-f-]{36}\.txt$/;

/** Only our regular spill files are eligible. Retention must never turn a completed tool into a failure. */
function pruneResults(dir: string, current: string) {
  try {
    const files = readdirSync(dir).filter(name => SPILL_NAME.test(name)).flatMap(name => {
      try {
        const file = join(dir, name);
        const stat = lstatSync(file);
        return stat.isFile() ? [{ file, mtime: stat.mtimeMs }] : [];
      } catch { return []; }
    }).sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // Reserve one slot for this call, even when concurrent calls have the same timestamp.
    let kept = 1;
    for (const { file, mtime } of files) {
      if (file === current) continue;
      if (mtime < cutoff || kept >= 200) {
        try { unlinkSync(file); } catch { /* best effort; another call may already have pruned it */ }
      } else kept += 1;
    }
  } catch { /* a readable result matters more than retention */ }
}

/** Only oversized text touches disk. Exclusive creation prevents collisions and symlink overwrites. */
export function boundedToolResult(home: string, tool: string, body: string, value: unknown) {
  const details = boundedDetails(value, tool);
  const bytes = Buffer.byteLength(body);
  if (bytes > TEXT_LIMIT) {
    const preview = Buffer.from(body).subarray(0, TEXT_PREVIEW).toString("utf8");
    try {
      const dir = join(dirname(registryPath(home)), "results");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}-${randomUUID()}.txt`);
      writeFileSync(file, body, { mode: 0o600, flag: "wx" });
      pruneResults(dir, file);
      body = `${preview}\n\n[Truncated. Full text: ${file} (${bytes} bytes)]`;
    } catch (error) {
      // The operation already ran. A diagnostic write must not make it look failed (or invite a retry).
      const reason = Buffer.from(error instanceof Error ? error.message : String(error)).subarray(0, 512).toString("utf8");
      body = `${preview}\n\n[Truncated; full text not saved: ${reason} (${bytes} bytes)]`;
    }
  }
  return { content: [{ type: "text" as const, text: body }], details };
}
