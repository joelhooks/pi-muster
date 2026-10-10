import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeRatkingClaims, decodeRatkingCursor, decodeRatkingDirectory, decodeRatkingProbe, decodeRatkingSettings } from "./domain.ts";

/** Read-only pi-ratking state probe; safe to import from remote plain Node. */
export function ratkingStateProbe(home: string, expected: string, configPath = process.env.RATKING_CONFIG || join(home, ".config/rat-king/pi.json")) {
  let state = join(home, ".local/state/rat-king/pi");
  try { state = decodeRatkingSettings(JSON.parse(readFileSync(configPath, "utf8"))).state ?? state; } catch { /* default state */ }
  let claims: ReturnType<typeof decodeRatkingClaims> = {};
  try { claims = decodeRatkingClaims(JSON.parse(readFileSync(join(state, "claims.json"), "utf8"))); } catch { /* unclaimed */ }
  const claim = claims[expected];
  let alive = false;
  if (claim) { try { process.kill(claim.pid, 0); alive = true; } catch { /* dead or inaccessible */ } }
  let did: string | null = null;
  try { did = decodeRatkingDirectory(JSON.parse(readFileSync(join(state, "directory.json"), "utf8")))[expected]?.did ?? null; } catch { /* no directory entry */ }
  let afterSeq: number | null = null;
  try { afterSeq = decodeRatkingCursor(JSON.parse(readFileSync(join(state, "cursors", `${expected.replaceAll("/", ".")}.json`), "utf8"))).afterSeq; } catch { /* cursor absence is not reader proof */ }
  return decodeRatkingProbe({ name: expected, did, session: claim?.session ?? null, pid: claim?.pid ?? null, alive, afterSeq });
}
