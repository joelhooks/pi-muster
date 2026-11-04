import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Role } from "./domain.ts";
import { agentClose, agentLaunchForeground, laneClose, laneOpen, projectOpen, projectReview } from "./ops.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

async function setup(refuse = false) {
  const h = harness();
  const dir = makeRepo(join(h.root, "probe"));
  const shim = join(h.home, ".config/muster/fleet-mailbox.sh");
  const log = join(h.root, "mailbox-args");
  mkdirSync(join(shim, ".."), { recursive: true });
  writeFileSync(shim, `printf '%s\\n' "$*" >> "${log}"\ncase "$*" in\n"role list --json") echo '{"roles":[{"name":"probe","target":"probe/desk","role":"r"}]}' ;;\nretire*) ${refuse ? 'echo "CliError: LeaseLive: probe/boss"; exit 1' : "exit 0"} ;;\nesac\nexit 0\n`);
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n", space: "w1", ephemeral: true, desk: true, musterExtension: "/m", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "probe" }));
  await runWith(h, laneOpen(dir, { slug: "other", label: "other", goal: "other" }));
  const args = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  const retires = () => args().filter(line => line.startsWith("retire "));
  const launch = (name: string, role: Role, lane = role === "desk" || role === "hawk" ? "desk" : "work") =>
    runWith(h, agentLaunchForeground(dir, { action: "launch", name, role, lane, label: name, cwd: dir }));
  const close = (name: string) => runWith(h, agentClose(dir, { name }));
  return { h, dir, args, retires, launch, close };
}

describe("standing Rat King names on close", () => {
  it.each(["desk", "hawk", "boss"] as const)("keeps a parked %s name so sends queue until restore", async role => {
    const s = await setup();
    await s.launch(role, role);
    const closed = await s.close(role);
    expect(closed.row.state).toBe("closed");
    expect(s.retires()).toEqual([]);
    expect(closed.notes).toContain(`Rat King name probe/${role} kept: mail queues until restore. For a permanent close: sh ~/.config/muster/fleet-mailbox.sh retire --name probe/${role}`);
  });

  it.each(["worker", "judge"] as const)("still retires a finished %s so sends get Retired", async role => {
    const s = await setup();
    await s.launch(role, role);
    const closed = await s.close(role);
    expect(s.retires()).toEqual([`retire --name probe/${role} --successor probe`]);
    expect(closed.notes).toContain(`Rat King name probe/${role} retired: sends to it now fail Retired, naming probe`);
  });

  it("retires only the closed standing names of a lane, not while draining", async () => {
    const s = await setup();
    await s.launch("boss", "boss");
    await s.launch("other-boss", "boss", "other");
    await s.launch("desk", "desk");
    await s.close("other-boss");
    await s.close("desk");
    const draining = await runWith(s.h, laneClose(s.dir, "work"));
    expect(draining.closed).toBe(false);
    expect(s.retires()).toEqual([]);
    await s.close("boss");
    const closed = await runWith(s.h, laneClose(s.dir, "work"));
    expect(closed.closed).toBe(true);
    expect(s.retires()).toEqual(["retire --name probe/boss --successor probe"]);
    expect(closed.paneNote).toContain("Rat King name probe/boss retired:");
  });

  it("retires the closed desk on actual project archive, not a review or refused archive", async () => {
    const s = await setup();
    await s.launch("desk", "desk");
    await s.close("desk");
    await runWith(s.h, projectReview(s.dir, { note: "continue" }));
    expect(s.retires()).toEqual([]);
    await expect(runWith(s.h, projectReview(s.dir, { note: "too early", decision: "archive" }))).rejects.toThrow();
    expect(s.retires()).toEqual([]);
    for (const slug of ["desk", "work", "other"]) await runWith(s.h, laneClose(s.dir, slug));
    // lane_close already permanently retired the desk; archive must still cover all closed standing rows.
    const before = s.retires().length;
    const archived = await runWith(s.h, projectReview(s.dir, { note: "finished", decision: "archive" }));
    expect(archived.project.state).toBe("archived");
    expect(s.retires().slice(before)).toEqual(["retire --name probe/desk"]);
    expect(archived.notes).toContain("Rat King name probe/desk retired: sends to it now fail Retired");
  });

  it("keeps a retirement refusal as a note without failing lane close or archive", async () => {
    const s = await setup(true);
    await s.launch("boss", "boss");
    await s.close("boss");
    const closed = await runWith(s.h, laneClose(s.dir, "work"));
    expect(closed.closed).toBe(true);
    expect(closed.paneNote).toContain("not retired (exit 1: CliError: LeaseLive");
    for (const slug of ["desk", "other"]) await runWith(s.h, laneClose(s.dir, slug));
    const archived = await runWith(s.h, projectReview(s.dir, { note: "finished", decision: "archive" }));
    expect(archived.project.state).toBe("archived");
    expect(archived.notes.some(note => note.includes("not retired (exit 1: CliError: LeaseLive"))).toBe(true);
  });

  it("still unretires the standing name on restore", async () => {
    const s = await setup();
    await s.launch("desk", "desk");
    await s.close("desk");
    const restored = await runWith(s.h, agentLaunchForeground(s.dir, { action: "restore", name: "desk" }));
    expect(s.args()).toContain("unretire --name probe/desk");
    expect(restored.notes).toContain("Rat King name probe/desk unretired: it takes mail again");
  });
});
