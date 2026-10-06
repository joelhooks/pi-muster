import { readFileSync } from "node:fs";
import { reportedNetworkSend, networkReceiptPath } from "./comms-fallback.ts";
import { Effect } from "effect";
import { commsAddress } from "./comms.ts";
import { decodeProject, type AgentRow, type Project } from "./domain.ts";
import { readRegistry } from "./registry.ts";
import { projectPath } from "./store.ts";
import { CommsError, type CommsShape } from "./runtime.ts";

export const deskRouteReceiptPath = networkReceiptPath;

/** Validate before any send, including fallback. A raw session/DID cannot bypass the desk fence. */
export function resolveDeskRoute(home: string, dir: string, to: string) {
  const address = commsAddress(to);
  if (address.kind !== "alias") throw new CommsError("desk_send requires a project/row alias");
  const known = readRegistry(home).get(address.project);
  const project = decodeProject(JSON.parse(readFileSync(projectPath(known?.dir ?? dir), "utf8")));
  if (project.slug !== address.project) throw new CommsError("desk_send unknown or foreign project alias");
  const row = project.agents.find(row => row.name === address.row && row.state !== "closed");
  if (!row || row.role === "worker" || (row.role !== "desk" && project.lanes.find(lane => lane.slug === row.lane)?.kind !== "role")) throw new CommsError("desk_send target must be a live desk or role row");
  return { project, row, identity: networkRowIdentity(project, row) };
}

/** Network first; fallback is explicit in both the result and a private receipt. */
export function sendDesk(options: {
  home: string; dir: string; to: string; text: string; sender: string; id: string; at: string;
  comms: CommsShape;
}) {
  return Effect.gen(function* () {
    const target = yield* Effect.try({ try: () => resolveDeskRoute(options.home, options.dir, options.to), catch: () => new CommsError(`desk_send refused alias ${options.to}: unknown, foreign, or non-desk row`) });
    const prepared = target.row.machine === "local" ? Effect.succeed(undefined) : Effect.gen(function* () {
      const { prepareRemoteNetworkAgent } = yield* Effect.promise(() => import("./comms-network.ts"));
      const { machineConfig } = yield* Effect.promise(() => import("./remote.ts"));
      yield* prepareRemoteNetworkAgent({ home: options.home, agent: target.identity, machineName: target.row.machine, machine: yield* machineConfig(target.row.machine) });
    }).pipe(Effect.mapError(() => new CommsError("desk_send remote provisioning failed (private output withheld)")));
    return yield* reportedNetworkSend({ ...options,
      network: prepared.pipe(Effect.flatMap(() => options.comms.send(options.to, options.text)), Effect.catch(error => Effect.succeed({ status: "failed" as const, detail: error.message }))),
      fallback: () => options.comms.relay ? options.comms.relay(options.to, options.text) : Effect.succeed({ status: "failed" as const, detail: "intercom fallback unavailable" }),
    });
  });
}

export function networkRowIdentity(project: Project, row: AgentRow): string {
  return row.role === "desk" ? `${project.slug}/${row.name}` : row.name;
}

/** Read registered catalogs at send/receive time, never accept a caller's DID mapping. */
export function networkCatalogPeers(home: string, dir: string): Record<string, string> {
  const peers: Record<string, string> = {};
  const local = decodeProject(JSON.parse(readFileSync(projectPath(dir), "utf8")));
  const entries = [...readRegistry(home).values()].filter(entry => entry.dir !== dir);
  for (const entry of entries) {
    let project: Project;
    try { project = decodeProject(JSON.parse(readFileSync(projectPath(entry.dir), "utf8"))); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw new CommsError("NetworkComms peer catalog invalid");
    }
    if (project.slug !== entry.slug) throw new CommsError("NetworkComms foreign project registry entry");
    for (const row of project.agents.filter(row => row.state !== "closed")) {
      const identity = networkRowIdentity(project, row);
      if (peers[row.sessionId] && peers[row.sessionId] !== identity) throw new CommsError("NetworkComms ambiguous peer session");
      peers[row.sessionId] = identity;
    }
  }
  for (const row of local.agents.filter(row => row.state !== "closed")) {
    const identity = networkRowIdentity(local, row);
    if (peers[row.sessionId] && peers[row.sessionId] !== identity) throw new CommsError("NetworkComms ambiguous peer session");
    peers[row.sessionId] = identity;
  }
  return peers;
}
