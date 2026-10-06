import type { Lane, Project, Role, Roster } from "./domain.ts";

/** Selection only; roleDefaults resolves aliases and the alternate's settings. */
export function retroJudgeModel(roster: Roster | undefined, launch?: { kind: Lane["kind"]; role: Role; model?: string | undefined }) {
  if (launch && (launch.kind !== "retro" || launch.role !== "judge" || launch.model !== undefined)) return { model: undefined, notes: [] };
  const model = roster?.roles.judge?.alternates?.find(alternate => alternate.useFor.includes("retro"))?.model;
  return { model, notes: model ? [] : ['retro judge: missing roster judge alternate with useFor: "retro"; keeping the default model'] };
}

/** One cursor and due decision shared by the flow line and close receipt. */
export function retroCadence(project: Pick<Project, "lanes" | "lastRetroAt">, now: number) {
  const cursor = project.lastRetroAt ? Date.parse(project.lastRetroAt) : undefined;
  const closed = project.lanes.filter(lane => lane.kind === "work" && lane.state === "closed" && !lane.discarded)
    .map(lane => Date.parse(lane.closedAt ?? lane.updatedAt))
    .filter(at => cursor === undefined || at > cursor);
  const count = closed.length;
  const since = cursor ?? Math.min(...closed);
  const reason = count >= 3 ? "count" : count >= 1 && now - since >= 86_400_000 ? "day" : null;
  return { count, reason, due: reason !== null };
}
