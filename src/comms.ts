import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { decodeAgentName, decodeSlug, decodeProject, type CommsMode, type Policy } from "./domain.ts";
import { RatkingMissing } from "./comms-ratking.ts";
import { projectPath } from "./store.ts";
import { CommsError, type CommsAddress, type CommsShape, type CommsTarget } from "./runtime.ts";

/** Session metadata is local bookkeeping, never a network identity or delivery fence. */
export function catalogCommsSender(dir: string, session: string) {
  try {
    const project = decodeProject(JSON.parse(readFileSync(projectPath(dir), "utf8")));
    const row = project.agents.find(row => row.sessionId === session);
    return row ? { agent: `${project.slug}/${row.name}`, session } : undefined;
  } catch { return undefined; }
}

export const remoteCommsEnvironment = (_project: unknown, _machine: unknown): Record<string, string> => ({ MUSTER_COMMS: "ratking" });
/** Legacy policy and launch hints remain readable, but cannot choose another transport. */
export const selectComms = (_env?: string, _policy?: Pick<Policy, "comms">): CommsMode => "ratking";

export function commsAddress(identity: CommsTarget): CommsAddress {
  if (typeof identity !== "string") {
    if (identity.kind === "alias") { decodeSlug(identity.project); decodeAgentName(identity.row); }
    if (identity.kind === "did" && !identity.did.startsWith("did:")) throw new CommsError("invalid DID");
    return identity;
  }
  if (identity.startsWith("did:")) return { kind: "did", did: `did:${identity.slice(4)}` };
  if (identity.includes("/")) {
    const [project, row, extra] = identity.split("/");
    if (!project || !row || extra !== undefined) throw new CommsError(`invalid Muster alias: ${identity}`);
    return { kind: "alias", project: decodeSlug(project), row: decodeAgentName(row) };
  }
  return { kind: "session", id: identity };
}

/** Resolve pi-ratking at call time, including after extension reload. No reader, keys or fallback. */
export function createComms(options: { ratking?: () => CommsShape | undefined }) {
  const current = () => options.ratking?.() ?? RatkingMissing;
  const service: CommsShape = {
    mode: () => Effect.succeed("ratking"),
    send: (to, message) => Effect.suspend(() => current().send(to, message)),
    postOwner: (to, item) => Effect.suspend(() => (current().postOwner ?? RatkingMissing.postOwner!)(to, item)),
    ask: (to, message, opts) => Effect.suspend(() => current().ask(to, message, opts)),
    reply: (id, message) => Effect.suspend(() => current().reply(id, message)),
    wake: to => Effect.suspend(() => current().wake(to)),
    resolve: to => Effect.suspend(() => current().resolve(to)),
    sessions: () => Effect.succeed(undefined),
  };
  return { ...service, dispose: () => {} };
}
