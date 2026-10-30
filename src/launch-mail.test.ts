import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  },
}));
import { agentLaunch, laneOpen, projectOpen, readLaunchJob, runLaunchJob, undeliveredLaunchNotes } from "./ops.ts";
import { ProcError } from "./errors.ts";
import { load, mutate } from "./store.ts";
import { ratkingInbound } from "./comms-ratking.ts";
import type { Project } from "./domain.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

// Slice 5: a result mail that does not go out is recorded on the job, not appended to a JSONL queue.
const undelivered = (home: string, id: string) => readLaunchJob(home, id).undelivered;

async function setup(withOwnerRow: boolean) {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "mail", outcome: "mail", reviewTrigger: "weekly", nextAction: "launch", criticalPath: ["work"], space: "w1", ephemeral: true, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "launch" }));
  const receipt = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, prompt: "go" }));
  if (!("jobId" in receipt)) throw new Error("expected job");
  if (withOwnerRow) await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: [...project.agents, { ...project.agents[0]!, name: "desk", sessionId: h.sessionId, state: "running" as const }] }, null] as const)));
  const sends: string[][] = [];
  const base = h.proc;
  const respond = (reply: () => ReturnType<typeof base.run>) => { h.proc = { run: (command, args, options) => command === "env" && args[0] === "-u" ? (sends.push([...args]), reply()) : base.run(command, args, options) }; };
  return { h, dir, receipt, sends, respond };
}
const sentOk = () => Effect.succeed({ code: 0, stdout: '{"command":"send","ok":true,"delivered":{"id":"m1"}}', stderr: "" });

describe("launch receipt mail", () => {
  beforeEach(() => vi.stubEnv("MUSTER_RATKING_CLI", "/fake/ratking.ts"));

  it("exit 0 sends one mail from muster/launcher and records nothing undelivered", async () => {
    const { h, dir, receipt, sends, respond } = await setup(true);
    respond(sentOk);
    const result = await runWith(h, runLaunchJob(dir, receipt.jobId));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.slice(0, 5)).toEqual(["-u", "RATKING_NAME", "node", "/fake/ratking.ts", "send"]);
    expect(sends[0]).toEqual(expect.arrayContaining(["--as", "muster/launcher", "--to", "mail/desk", "--json", `action muster/launcher · Launch worker finished`]));
    expect(sends[0]!.at(sends[0]!.indexOf("--body") + 1)).toBe(`${result.body}\n\nlane work · refs ${receipt.log}`);
    expect(undelivered(h.home, receipt.jobId)).toBeUndefined();
    expect((await runWith(h, load(dir))).agents.find(row => row.name === "worker")?.state).toBe("running");
  });

  it.each([
    ["exit 2", () => Effect.succeed({ code: 2, stdout: "", stderr: "refused" })],
    ["exit 3", () => Effect.succeed({ code: 3, stdout: "", stderr: "uncertain" })],
    ["a timeout", () => Effect.fail(new ProcError({ command: "env", code: null, stderr: "", message: "timed out after 30000ms" }))],
    ["unparseable output", () => Effect.succeed({ code: 0, stdout: "not json", stderr: "" })],
  ])("%s records the job undelivered once, never resends, and shows it on the owner's board for a day", async (_name, reply) => {
    const { h, dir, receipt, sends, respond } = await setup(true);
    respond(reply as never);
    await runWith(h, runLaunchJob(dir, receipt.jobId));
    expect(sends).toHaveLength(1);
    const job = readLaunchJob(h.home, receipt.jobId);
    expect(job.undelivered).toEqual(expect.any(String));
    const notes = undeliveredLaunchNotes([job], "mail", job.owner, Date.parse(job.startedAt) + 60_000);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("launch worker finished, but its result mail did not go out (");
    expect(notes[0]).toContain(`read ${job.log}`);
    expect(undeliveredLaunchNotes([job], "mail", job.owner, Date.parse(job.startedAt) + 86_400_001)).toEqual([]);
    expect(undeliveredLaunchNotes([job], "mail", "someone-else", Date.parse(job.startedAt))).toEqual([]);
  });

  // A desk that restarts while its launch runs: the job names the old session, the row now holds the new one.
  it("an owner that restarted mid-launch still gets mail at its row's name", async () => {
    const { h, dir, receipt, sends, respond } = await setup(true);
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => row.name === "desk" ? { ...row, sessionId: "desk-new-session", events: [...(row.events ?? []), { type: "RESTARTED", at: "2026-10-15T00:00:00.000Z", detail: `${h.sessionId} -> desk-new-session: restarted` }] } : row) }, null] as const)));
    respond(sentOk);
    await runWith(h, runLaunchJob(dir, receipt.jobId));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual(expect.arrayContaining(["--to", "mail/desk"]));
    expect(undelivered(h.home, receipt.jobId)).toBeUndefined();
  });

  // Tin-Tin, P5 audit 1: desks started outside Muster own workers but have no row; their receipts bypassed mail.
  it("an owner without a row gets mail at the name its worker row records", async () => {
    const { h, dir, receipt, sends, respond } = await setup(false);
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => row.name === "worker" ? { ...row, ownerName: "rowless-owner" } : row) }, null] as const)));
    respond(sentOk);
    await runWith(h, runLaunchJob(dir, receipt.jobId));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual(expect.arrayContaining(["--to", "rowless-owner"]));
    expect(undelivered(h.home, receipt.jobId)).toBeUndefined();
  });

  // Switchboard, 2026-10-28: a rowless owner with RATKING_NAME had every launch receipt parked, because the receipt read
  // the reservation, which carried no ownerName, instead of the row the launch had written.
  it("a rowless owner with RATKING_NAME gets its launch receipt by mail", async () => {
    vi.stubEnv("RATKING_NAME", "rowless-owner");
    const { h, dir, receipt, sends, respond } = await setup(false);
    respond(sentOk);
    await runWith(h, runLaunchJob(dir, receipt.jobId));
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual(expect.arrayContaining(["--to", "rowless-owner"]));
    expect(undelivered(h.home, receipt.jobId)).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("an owner with no row and no recorded name records the reason, without sending", async () => {
    const { h, dir, receipt, sends, respond } = await setup(false);
    await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(({ ownerName: _, ...row }) => row) }, null] as const)));
    respond(sentOk);
    await runWith(h, runLaunchJob(dir, receipt.jobId));
    expect(sends).toHaveLength(0);
    expect(undelivered(h.home, receipt.jobId)).toContain("owner has no Rat King name");
  });
});

describe("launcher mail inbound", () => {
  const project = { slug: "mail", agents: [{ name: "desk", sessionId: "owner-session", state: "running" }] } as unknown as Project;
  const mail = (kind: string, patch = {}) => ({ id: `lm-${kind}`, verified: true, from: "muster/launcher", kind: "message", summary: `${kind} muster/launcher · Launch w finished`, body: "done\n\nlane work · refs /tmp/log", ...patch });
  const run = (message: unknown) => { const owner = vi.fn(); return { result: ratkingInbound(message, { owner, message: vi.fn(), session: "owner-session", catalogs: () => [project] }), owner }; };

  it.each(["action", "blocked"])("%s mail becomes one item", kind => {
    const { result, owner } = run(mail(kind));
    expect(result).toBe("owner");
    expect(owner).toHaveBeenCalledTimes(1);
    expect(owner.mock.calls[0]![0]).toMatchObject({ uri: `lm-${kind}`, kind, author: "muster-launcher", project: "mail", lane: "work", refs: ["/tmp/log"], renderedBy: "ratking" });
  });

  it("ignores a forged from with the launcher heading, and unverified mail", () => {
    expect(run(mail("action", { from: "other/name" })).result).toBe("ignored");
    expect(run(mail("action", { verified: false })).result).toBe("ignored");
    expect(run(mail("fyi")).result).toBe("ignored");
  });
});
