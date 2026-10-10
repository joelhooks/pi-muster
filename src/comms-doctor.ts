import { join } from "node:path";
import { Effect } from "effect";
import { decodeRatkingProbe, decodeRatkingStatus } from "./domain.ts";
import { ratkingStateProbe } from "./comms-probe.ts";
export { ratkingStateProbe } from "./comms-probe.ts";
import { ratkingConfigPath, rowRatkingName } from "./comms-ratking.ts";
import { machineConfig, remoteNode } from "./remote.ts";
import { load } from "./store.ts";
import { CommsError } from "./runtime.ts";

export type RatkingProbe = ReturnType<typeof ratkingStateProbe>;
export function doctorReport(expected: string, session: string, machine: string, probe: RatkingProbe, live?: ReturnType<typeof decodeRatkingStatus>) {
  const claimed = live?.name ?? probe.name;
  const mismatch = claimed !== expected || probe.session !== session || !probe.alive;
  return { expected, claimed, session, machine, did: live?.did ?? probe.did,
    reader: live?.reader ?? (probe.alive ? "claimed process alive; reader state unavailable" : "no live claimant"),
    lease: live?.lease ?? "unavailable (pi-ratking owns the lease)", claim: probe,
    mismatch, verdict: mismatch ? "mismatch: restart the row with its expected RATKING_NAME" : "claim matches; lease is pi-ratking's",
  };
}
interface Bus { emit(event: string, value: unknown): void; on(event: string, listener: (value: unknown) => void): void | (() => void) }
/** Opportunistic live status. Older pi-ratking has no event and falls back after 2 seconds. */
export function ratkingStatus(events: Bus, requestId: string, timeoutMs = 2000): Effect.Effect<ReturnType<typeof decodeRatkingStatus> | undefined> {
  return Effect.callback(resume => {
    let done = false;
    const finish = (status?: ReturnType<typeof decodeRatkingStatus>) => { if (done) return; done = true; clearTimeout(timer); if (typeof off === "function") off(); resume(Effect.succeed(status)); };
    const off = events.on("ratking/status:result", value => {
      if (typeof value !== "object" || value === null || !("requestId" in value) || value.requestId !== requestId) return;
      try { finish(decodeRatkingStatus(value)); } catch { finish(); }
    });
    const timer = setTimeout(() => finish(), timeoutMs);
    events.emit("ratking/status", { requestId });
    return Effect.sync(() => { clearTimeout(timer); if (typeof off === "function") off(); });
  });
}
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
    // Execute the same read-only probe and domain decoders in the deployed Muster package.
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
  `expected: ${report.expected} · claimed: ${report.claimed} · DID: ${report.did ?? "unknown"}`,
  `reader: ${JSON.stringify(report.reader)} · lease: ${JSON.stringify(report.lease)}`,
  `claim session: ${report.claim.session ?? "none"} · pid: ${report.claim.pid ?? "none"} · alive: ${report.claim.alive} · cursor: ${report.claim.afterSeq ?? "none"}`,
].join("\n");
