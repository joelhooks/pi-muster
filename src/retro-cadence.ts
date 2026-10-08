import type { Lane, Role, Roster } from "./domain.ts";

/** Selection only; roleDefaults resolves aliases and the alternate's settings. */
export function retroJudgeModel(roster: Roster | undefined, launch?: { kind: Lane["kind"]; role: Role; model?: string | undefined }) {
  if (launch && (launch.kind !== "retro" || launch.role !== "judge" || launch.model !== undefined)) return { model: undefined, notes: [] };
  const model = roster?.roles.judge?.alternates?.find(alternate => alternate.useFor.includes("retro"))?.model;
  return { model, notes: model ? [] : ['retro judge: missing roster judge alternate with useFor: "retro"; keeping the default model'] };
}
