import { expect, it } from "vitest";
import { agentEnv, profileFor } from "./argv.ts";
import { decodeAgentRow, decodeTurnRecord, type Project } from "./domain.ts";
import { turnUnsupported, turnWake } from "./turn-wake.ts";

const decodeWire = (value: unknown) => decodeTurnRecord(JSON.parse(JSON.stringify(value)));
const at = "2026-10-13T00:00:00.000Z";
const row = decodeAgentRow({ name: "worker", role: "worker", lane: "work", cwd: "/work", clone: null,
  profile: profileFor("worker", { label: "worker" }), sessionId: "current-session", sessionFile: null,
  parentSessionFile: null, pane: null, owner: "new-owner", brief: null, state: "running", delivery: "proven",
  restarts: 1, restore: null, createdAt: at, updatedAt: at,
  events: [{ type: "RESTARTED", at, detail: "old-session -> current-session: restarted" }] });
const project = { slug: "project", dir: "/project", agents: [row] } as unknown as Project;
const record = { $type: "sh.mschf.agentgraph.turn", agent: "project/worker", at, session: row.sessionId,
  state: "done", turnId: `${row.sessionId}:1`, version: "0.1", stopReason: "stop" };

it("decodes valid turn records and refuses malformed fields and state-specific metadata", () => {
  expect(decodeWire(record)).toEqual(record);
  for (const patch of [{ state: "finished" }, { version: "1" }, { at: "bad-date" }, { turnId: "other:1" },
    { turnId: `${row.sessionId}:wat` }, { stopReason: "unknown" }, { reason: "wrong state" }, { generation: 1 },
    { state: "crashed", stopReason: undefined, generation: -1 }, { session: "" }]) {
    expect(() => decodeWire({ ...record, ...patch })).toThrow();
  }
});
it.each(["done", "blocked", "crashed"] as const)("%s addresses and mentions the current owner", state => {
  const decoded = decodeWire({ ...record, state, stopReason: state === "done" ? "stop" : undefined,
    reason: state === "done" ? undefined : "needs attention", generation: state === "crashed" ? 2 : undefined });
  const notice = turnWake(decoded, project)!;
  expect(notice.owner).toBe("new-owner");
  expect(notice.item).toMatchObject({ author: row.sessionId, mention: "new-owner", kind: state === "done" ? "done" : "blocked" });
  expect(notice.item.title).toContain(state);
  expect(notice.item.body).toContain(decoded.turnId);
  expect(notice.item.body).toContain(state === "done" ? "stopReason: stop" : "reason: needs attention");
});
it.each(["working", "idle"] as const)("%s stays silent", state => {
  expect(turnWake(decodeWire({ ...record, state, stopReason: undefined }), project)).toBeNull();
});
it("rejects agents and sessions outside the project row, but accepts the session chain", () => {
  expect(turnWake(decodeWire({ ...record, agent: "elsewhere/worker" }), project)).toBeNull();
  expect(turnWake(decodeWire({ ...record, session: "stranger", turnId: "stranger:1" }), project)).toBeNull();
  expect(turnWake(decodeWire({ ...record, session: "old-session", turnId: "old-session:1" }), project)?.item.author).toBe("old-session");
});
it("enables records for every role and diagnoses recorded launch env rather than the current profile", () => {
  for (const role of ["desk", "boss", "worker", "hawk", "judge"] as const) {
    expect(agentEnv(project, { ...row, role, profile: { ...row.profile, env: { RATKING_TURN_RECORDS: "0" } } }).RATKING_TURN_RECORDS).toBe("1");
  }
  expect(turnUnsupported(row)).toBe('TurnUnsupported: worker was launched before turn records. Fix: agent_launch action:"restart" name:"worker". Debug: comms_doctor row:"worker"');
  const supported = { ...row, profile: { ...row.profile, env: { RATKING_TURN_RECORDS: "1" } } };
  expect(turnUnsupported(supported)).toBeNull();
  expect(turnUnsupported({ ...supported, restore: { cwd: row.cwd, argv: [], env: {} } })).toContain("TurnUnsupported");
  expect(turnUnsupported({ ...row, restore: { cwd: row.cwd, argv: [], env: { RATKING_TURN_RECORDS: "1" } } })).toBeNull();
  expect(turnUnsupported({ ...row, state: "closed" })).toBeNull();
});
