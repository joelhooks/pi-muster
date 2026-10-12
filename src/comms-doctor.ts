import { join } from "node:path";
import { Effect } from "effect";
import { decodeRatkingProbe, decodeRatkingStatus } from "./domain.ts";
import { ratkingStateProbe } from "./comms-probe.ts";
export { ratkingStateProbe } from "./comms-probe.ts";
import { ratkingStatus } from "./ratking-status.ts";
export { ratkingStatus } from "./ratking-status.ts";
import { ratkingConfigPath, rowRatkingName } from "./comms-ratking.ts";
import { machineConfig, remoteNode } from "./remote.ts";
import { load } from "./store.ts";
import { CommsError } from "./runtime.ts";

export type RatkingProbe = ReturnType<typeof ratkingStateProbe>;
/** A reader rewrites its lease file every consume poll; this much silence means its loop has stopped. */
export const LEASE_STALE_MS = 5 * 60_000;
export function doctorReport(expected: string, session: string, machine: string, probe: RatkingProbe, live?: ReturnType<typeof decodeRatkingStatus>, now = Date.now()) {
  const claimed = live ? live.name : probe.name;
  // Env-given names have no claim, so a remote probe used to report "alive: false" for healthy readers (ship-c,
  // 2026-10-12). The lease file's mtime on the row's host is the reader's own heartbeat.
  const leaseAge = !live && probe.session === null && probe.lease ? Math.max(0, Math.round((now - Date.parse(probe.lease.writtenAt)) / 1000)) : null;
  const leased = leaseAge !== null && leaseAge * 1000 <= LEASE_STALE_MS;
  const stale = leaseAge !== null && !leased;
  const unknown = !live && probe.session === null && probe.afterSeq !== null && leaseAge === null;
  const mismatch = live ? claimed !== expected || ["retired", "off", "send-only"].includes(live.reader)
    : !unknown && (claimed !== expected || probe.session !== session || !probe.alive);
  return { expected, claimed, session, machine, did: live ? live.did : probe.did,
    reader: live?.reader ?? (leased ? `consuming: lease generation ${probe.lease!.generation} rewritten ${leaseAge}s ago (lease file on ${machine}); mail reaches the agent when its turn ends`
      : stale ? `stopped: lease generation ${probe.lease!.generation} last rewritten ${leaseAge}s ago (lease file on ${machine})`
      : probe.alive ? "claimed process alive; reader state unavailable" : unknown ? "unknown: no claim for an env-given name; this pi-ratking reports no status" : "no live claimant"),
    leaseGeneration: live?.leaseGeneration ?? probe.lease?.generation ?? null, leaseUntil: live?.leaseUntil ?? null, claim: probe,
    mismatch: mismatch && !leased, verdict: leased ? `reader holds the name: lease generation ${probe.lease!.generation}, last poll ${leaseAge}s ago`
      : stale ? `stale: the reader's last poll was ${leaseAge}s ago; check the row's Pi is alive, then restart it`
      : unknown ? "unknown: the name has a cursor but no claim; reader state needs pi-ratking's status event"
      : mismatch ? "mismatch: restart the row with its expected RATKING_NAME"
      : live ? `name matches; reader ${live.reader}` : "claim matches; lease is pi-ratking's",
  };
}
interface Bus { emit(event: string, value: unknown): void; on(event: string, listener: (value: unknown) => void): void | (() => void) }
export const commsDoctor = (options: { home: string; dir: string; session: string; row?: string; env: Readonly<Record<string, string | undefined>>; events: Bus }) => Effect.gen(function* () {
  const project = yield* load(options.dir).pipe(Effect.orElseSucceed(() => undefined));
  const row = project?.agents.find(row => options.row ? row.name === options.row : row.sessionId === options.session);
  if (options.row && !row) return yield* Effect.fail(new CommsError(`no row ${options.row}`));
  const expected = row && project ? rowRatkingName(project, row) : options.env.RATKING_NAME;
  if (!expected) return yield* Effect.fail(new CommsError("no expected Rat King name; set RATKING_NAME"));
  const session = row?.sessionId ?? options.session;
  const machine = row?.machine ?? options.env.MUSTER_MACHINE ?? "local";
  const remote = row && row.machine !== "local" && row.machine !== options.env.MUSTER_MACHINE;
  if (remote) {
    const config = yield* machineConfig(row.machine);
    const script = `import {homedir} from 'node:os'; import {pathToFileURL} from 'node:url';
const {ratkingStateProbe}=await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(JSON.stringify(ratkingStateProbe(homedir(),process.argv[2],process.argv[3]||undefined)));`;
    const raw = yield* remoteNode(row.machine, config, script, [join(config.musterExtension, "src/comms-probe.ts"), expected, row.restore?.env.RATKING_CONFIG ?? config.env.RATKING_CONFIG ?? ""]);
    const probe = yield* Effect.try({ try: () => decodeRatkingProbe(JSON.parse(raw)), catch: () => new CommsError("remote pi-ratking probe unreadable") });
    return doctorReport(expected, session, machine, probe);
  }
  const probe = yield* Effect.try({ try: () => ratkingStateProbe(options.home, expected, ratkingConfigPath(options.home, options.env)), catch: () => new CommsError("pi-ratking state unreadable") });
  const live = session === options.session ? yield* ratkingStatus(options.events, `muster-status-${options.session}-${Date.now()}`) : undefined;
  return doctorReport(expected, session, machine, probe, live);
});
export const commsDoctorText = (report: ReturnType<typeof doctorReport>) => [
  `comms_doctor ${report.expected} (${report.machine}): ${report.verdict}`,
  `expected: ${report.expected} · claimed: ${report.claimed ?? "none"} · DID: ${report.did ?? "unknown"}`,
  `reader: ${JSON.stringify(report.reader)} · lease generation: ${report.leaseGeneration ?? "unknown"} · lease until: ${report.leaseUntil ?? "unknown"}`,
  `claim session: ${report.claim.session ?? "none"} · pid: ${report.claim.pid ?? "none"} · alive: ${report.claim.alive} · cursor: ${report.claim.afterSeq ?? "none"}`,
].join("\n");
