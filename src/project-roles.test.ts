import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentClose, agentLaunchForeground, laneOpen, parseMailboxRoles, projectOpen, projectRoleLine } from "./ops.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

// Joel, 2026-10-30 ("fix"): address projects, not rows. The mailbox maps a project's role name to its live desk;
// Muster points it at the desk and forwards a closed row's name to it.
const ROLES = `'{"roles":[{"name":"probe","target":"probe/old-desk","role":"old"}]}'`;
const NEW_MAILBOX = `case "$*" in "role list --json") echo ${ROLES};; esac; exit 0`;
const OLD_MAILBOX = `case "$*" in role*) echo "unknown command"; exit 1;; esac; exit 0`;

async function setup(mailbox: string, slug = "probe") {
  const h = harness();
  const dir = makeRepo(join(h.root, slug));
  const shim = join(h.home, ".config/muster/fleet-mailbox.sh");
  mkdirSync(join(shim, ".."), { recursive: true });
  writeFileSync(shim, `printf '%s\\n' "$*" >> "${h.root}/mailbox-args"; ${mailbox}\n`);
  await runWith(h, projectOpen({ dir, slug, outcome: "Run the probe desk. Then more words.", reviewTrigger: "r", nextAction: "n", space: "w1", ephemeral: true, desk: true, musterExtension: "/m", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "probe" }));
  const args = () => existsSync(join(h.root, "mailbox-args")) ? readFileSync(join(h.root, "mailbox-args"), "utf8").trim().split("\n") : [];
  const launch = (name: string, role: "desk" | "worker") => runWith(h, agentLaunchForeground(dir, { action: "launch", name, role, lane: role === "desk" ? "desk" : "work", label: name, cwd: dir }));
  return { h, dir, args, launch };
}

describe("project role names", () => {
  it("takes the outcome's first sentence, at most 120 characters", () => {
    expect(projectRoleLine("Run the  probe\ndesk. Then more.")).toBe("Run the probe desk.");
    expect(projectRoleLine("x".repeat(200))).toBe(`${"x".repeat(119)}…`);
    expect(projectRoleLine("v1.2 ships")).toBe("v1.2 ships");
    expect(projectRoleLine("Ship v1.4. then e.g. more. Next part.")).toBe("Ship v1.4. then e.g. more.");
  });

  it("parses only a roles list", () => {
    expect(parseMailboxRoles("unknown command")).toBeNull();
    expect(parseMailboxRoles('{"ok":true}')).toBeNull();
    expect(parseMailboxRoles('{"roles":[{"name":"a","target":"a/desk","role":"r"},{"target":"x"}]}')).toEqual([{ name: "a", target: "a/desk", role: "r" }]);
  });

  it("points the project's role at a launched desk", async () => {
    const { args, launch } = await setup(NEW_MAILBOX);
    const result = await launch("desk", "desk");
    expect(args()).toEqual(["role list --json", "role set probe --target probe/desk --role Run the probe desk."]);
    expect(result.notes).toContain("Rat King role probe now reaches probe/desk");
  });

  it("leaves a role that already reaches the desk alone", async () => {
    const roles = `'{"roles":[{"name":"probe","target":"probe/desk","role":"Run the probe desk."}]}'`;
    const { args, launch } = await setup(`case "$*" in "role list --json") echo ${roles};; esac; exit 0`);
    await launch("desk", "desk");
    expect(args()).toEqual(["role list --json"]);
  });

  it("does nothing before the mailbox has roles, and nothing for a worker", async () => {
    const { args, launch } = await setup(OLD_MAILBOX);
    const desk = await launch("desk", "desk");
    expect(args()).toEqual(["role list --json"]);
    expect(desk.notes.some(note => note.includes("Rat King role"))).toBe(false);
    await launch("worker", "worker");
    expect(args()).toEqual(["role list --json"]);
  });

  it("never claims an owner's name as a project role", async () => {
    const { args, launch } = await setup(NEW_MAILBOX, "switchboard");
    const result = await launch("desk", "desk");
    expect(args()).toEqual([]);
    expect(result.notes).toContain("Rat King role switchboard not set: the slug is an owner's name; mail the desk row by its own name");
  });

  it("forwards a closed row's name to the project role", async () => {
    const { h, dir, args, launch } = await setup(NEW_MAILBOX);
    await launch("worker", "worker");
    const closed = await runWith(h, agentClose(dir, { name: "worker" }));
    expect(args()).toEqual(["role list --json", "retire --name probe/worker --successor probe"]);
    expect(closed.notes).toContain("Rat King name probe/worker retired: sends to it now fail Retired, naming probe");
  });

  // Tin-Tin, #60 review: the role would forward the closed desk's mail back to the same retired name.
  it("does not forward the role's own target to the role", async () => {
    const roles = `'{"roles":[{"name":"probe","target":"probe/worker","role":"r"}]}'`;
    const { h, dir, args, launch } = await setup(`case "$*" in "role list --json") echo ${roles};; esac; exit 0`);
    await launch("worker", "worker");
    await runWith(h, agentClose(dir, { name: "worker" }));
    expect(args().filter(line => line.startsWith("retire"))).toEqual(["retire --name probe/worker"]);
  });

  it("does not retry a retire the mailbox refused for a live lease", async () => {
    const { h, dir, args, launch } = await setup(`case "$*" in "role list --json") echo ${ROLES};; retire*) echo "CliError: LeaseLive: probe/worker"; exit 1;; esac; exit 0`);
    await launch("worker", "worker");
    const closed = await runWith(h, agentClose(dir, { name: "worker" }));
    expect(args()).toEqual(["role list --json", "retire --name probe/worker --successor probe"]);
    expect(closed.notes.some(note => note.startsWith("Rat King name probe/worker not retired") && note.includes("LeaseLive"))).toBe(true);
  });
});
