import { readFileSync } from "node:fs";
import { networkReceiptPath } from "./comms-fallback.ts";
import { Effect } from "effect";
import { assertCurrentSession, commsAddress } from "./comms.ts";
import { decodeProject, type AgentRow, type Project } from "./domain.ts";
import { readRegistry } from "./registry.ts";
import { projectPath } from "./store.ts";
import { CommsError, type CommsShape } from "./runtime.ts";

export const deskRouteReceiptPath = networkReceiptPath;

/** Validate before any send, including fallback. A raw session/DID cannot bypass the desk fence. */
export function resolveDeskRoute(home: string, dir: string, to: string) {
  assertCurrentSession(home, to);
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
    const target = yield* Effect.try({ try: () => resolveDeskRoute(options.home, options.dir, options.to), catch: error => error instanceof CommsError ? error : new CommsError(`desk_send refused alias ${options.to}: unknown, foreign, or non-desk row`) });
    const peers = rowPeers(target.project, target.row);
    const prepared = target.row.machine === "local" ? Effect.succeed(undefined) : Effect.gen(function* () {
      const { prepareRemoteNetworkAgent } = yield* Effect.promise(() => import("./comms-network.ts"));
      const { machineConfig } = yield* Effect.promise(() => import("./remote.ts"));
      yield* prepareRemoteNetworkAgent({ home: options.home, agent: target.identity, machineName: target.row.machine, machine: yield* machineConfig(target.row.machine), peers });
    }).pipe(Effect.mapError(() => new CommsError("desk_send remote provisioning failed (private output withheld)")));
    const { routedNetworkSend } = yield* Effect.promise(() => import("./comms-network.ts"));
    return yield* routedNetworkSend({ ...options, target: { ...target, peers },
      network: prepared.pipe(Effect.flatMap(() => options.comms.send(options.to, options.text)), Effect.catch(error => Effect.succeed({ status: "failed" as const, detail: error.message }))),
      fallback: () => options.comms.relay ? options.comms.relay(options.to, options.text) : Effect.succeed({ status: "failed" as const, detail: "intercom fallback unavailable" }),
    });
  });
}

export function networkRowIdentity(project: Project, row: AgentRow): string {
  return row.role === "desk" ? `${project.slug}/${row.name}` : row.name;
}

/** Identities a remote row may hold public references for: its project's other open rows. */
const rowPeers = (project: Project, row: AgentRow) => project.agents.filter(other => other.state !== "closed" && other.name !== row.name).map(other => networkRowIdentity(project, other));

/** The open catalog row a network send addresses, in this catalog first, then registered ones.
 * Undefined for DIDs and anything that is not a row: those keep the plain network path and its refusal. */
export function networkTargetRow(home: string, dir: string, to: string) {
  let address;
  try { address = commsAddress(to); } catch { return undefined; }
  if (address.kind === "did") return undefined;
  const catalogs: Project[] = [];
  try { catalogs.push(decodeProject(JSON.parse(readFileSync(projectPath(dir), "utf8")))); } catch { /* a slug, or a remote worker without the catalog */ }
  try {
    for (const entry of readRegistry(home).values()) {
      try {
        const project = decodeProject(JSON.parse(readFileSync(projectPath(entry.dir), "utf8")));
        if (project.slug === entry.slug && !catalogs.some(known => known.slug === project.slug)) catalogs.push(project);
      } catch { /* an unreadable foreign catalog has no row to offer */ }
    }
  } catch { /* no registry */ }
  for (const [index, project] of catalogs.entries()) {
    const row = project.agents.find(row => row.state !== "closed" && (address.kind === "alias"
      ? project.slug === address.project && row.name === address.row
      : row.sessionId === address.id || row.intercomAddress === address.id || (index === 0 && row.name === address.id)));
    if (row) return { project, row, identity: networkRowIdentity(project, row), peers: rowPeers(project, row) };
  }
  return undefined;
}

/** Old launch readers see bare names only; new readers have a separate desk channel. */
export function networkPeerEnvironment(project: Project, rows: readonly AgentRow[]) {
  return {
    MUSTER_NETWORK_PEERS: JSON.stringify(Object.fromEntries(rows.map(row => [row.sessionId, row.name]))),
    MUSTER_NETWORK_DESK_PEERS: JSON.stringify(Object.fromEntries(rows.filter(row => row.role === "desk").map(row => [row.sessionId, networkRowIdentity(project, row)]))),
  };
}

/** Read registered catalogs at send/receive time, never accept a caller's DID mapping. */
/** Rows that can no longer speak yield to a live row with the same session (renamed or adopted rows). */
const DEAD = new Set(["closed", "failed", "interrupted"]);

/** Session → identity across registered catalogs. A session is ambiguous only when its
 * live rows disagree; that fails a lookup of that session alone, never every send.
 * An unreadable foreign catalog is skipped: its rows resolve through the later fallbacks. */
export function networkCatalogPeerTable(home: string, dir: string): { peers: Record<string, string>; ambiguous: ReadonlySet<string> } {
  const candidates = new Map<string, Array<{ identity: string; dead: boolean }>>();
  const add = (project: Project) => {
    for (const row of project.agents.filter(row => row.state !== "closed")) {
      const list = candidates.get(row.sessionId) ?? [];
      list.push({ identity: networkRowIdentity(project, row), dead: DEAD.has(row.state) });
      candidates.set(row.sessionId, list);
    }
  };
  const local = decodeProject(JSON.parse(readFileSync(projectPath(dir), "utf8")));
  for (const entry of [...readRegistry(home).values()].filter(entry => entry.dir !== dir)) {
    let project: Project;
    try { project = decodeProject(JSON.parse(readFileSync(projectPath(entry.dir), "utf8"))); }
    catch { continue; }
    if (project.slug !== entry.slug) continue;
    add(project);
  }
  add(local);
  const peers: Record<string, string> = {};
  const ambiguous = new Set<string>();
  for (const [session, list] of candidates) {
    const live = list.filter(item => !item.dead);
    const identities = new Set((live.length ? live : list).map(item => item.identity));
    if (identities.size === 1) peers[session] = [...identities][0]!;
    else ambiguous.add(session);
  }
  return { peers, ambiguous };
}

export function networkCatalogPeers(home: string, dir: string): Record<string, string> {
  return networkCatalogPeerTable(home, dir).peers;
}

export function networkCatalogPeer(home: string, dir: string, session: string): string | undefined {
  const table = networkCatalogPeerTable(home, dir);
  if (table.ambiguous.has(session)) throw new CommsError(`NetworkComms ambiguous peer session ${session}`);
  return table.peers[session];
}
