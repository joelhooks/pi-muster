import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentClose, agentLaunchForeground, laneOpen, leaseLiveUntil, projectOpen, projectStatus } from "./ops.ts";
import { load } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

// rats-nest, 2026-11-14: restore then agent_close met "LeaseLive: rats-nest/synconce is held by a live reader until
// 16:11:37Z; nothing was retired", and close never tried again, so closed rows piled up live names.
async function setup() {
  const h = harness();
  const dir = makeRepo(join(h.root, "probe"));
  const shim = join(h.home, ".config/muster/fleet-mailbox.sh");
  const log = join(h.root, "mailbox-args");
  const live = join(h.root, "lease-live");
  mkdirSync(join(shim, ".."), { recursive: true });
  const broken = join(h.root, "mailbox-down");
  writeFileSync(shim, `printf '%s\\n' "$*" >> "${log}"\ncase "$*" in\nretire*) if [ -e "${broken}" ]; then echo "CliError: fetch failed"; exit 1; fi; if [ -e "${live}" ]; then echo "CliError: LeaseLive: probe/worker is held by a live reader until $(cat "${live}"); nothing was retired."; exit 1; fi ;;\nesac\nexit 0\n`);
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n", space: "w1", ephemeral: true, desk: true, musterExtension: "/m", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "probe" }));
  await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir }));
  const retires = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(line => line.startsWith("retire ")) : [];
  const lease = (until: string | null) => until ? writeFileSync(live, until) : rmSync(live, { force: true });
  const row = async () => (await runWith(h, load(dir))).agents.find(agent => agent.name === "worker")!;
  const status = () => runWith(h, projectStatus(dir, { act: true }));
  const at = (time: string) => { h.now = new Date(`2026-09-29T${time}Z`); };
  const down = (on: boolean) => on ? writeFileSync(broken, "") : rmSync(broken, { force: true });
  return { h, dir, retires, lease, row, status, at, down };
}

describe("a retire refused for a live lease", () => {
  it("reads the lease end from the refusal, as today or tomorrow", () => {
    const now = Date.parse("2026-11-14T16:06:00Z");
    expect(leaseLiveUntil("is held by a live reader until 16:11:37Z; nothing", now)).toBe("2026-11-14T16:11:37.000Z");
    expect(leaseLiveUntil("until 2026-11-14T16:11:37.250Z;", now)).toBe("2026-11-14T16:11:37.250Z");
    expect(leaseLiveUntil("until 00:03:00Z", Date.parse("2026-11-14T23:59:00Z"))).toBe("2026-11-15T00:03:00.000Z");
    expect(leaseLiveUntil("CliError: LeaseLive: probe/worker", now)).toBeNull();
  }, 30_000);

  it("stays pending on the closed row, and project_status retires it once the lease ends", async () => {
    const s = await setup();
    s.lease("06:05:00Z");
    const closed = await runWith(s.h, agentClose(s.dir, { name: "worker" }));
    expect(closed.notes.some(note => note.includes("LeaseLive") && note.includes("project_status retries after 06:05:15Z"))).toBe(true);
    expect((await s.row()).retirePending).toEqual({ after: "2026-09-29T06:05:15.000Z", tries: 1 });
    expect(s.retires()).toHaveLength(1);

    await s.status();
    expect(s.retires()).toHaveLength(1);

    s.at("06:05:20"); s.lease(null);
    const retried = await s.status();
    expect(s.retires()).toHaveLength(2);
    expect(retried.notes.some(note => note.startsWith("retry: Rat King name probe/worker retired"))).toBe(true);
    expect((await s.row()).retirePending).toBeUndefined();

    await s.status();
    expect(s.retires()).toHaveLength(2);
  }, 30_000);

  it("counts a lease still live at retry, and gives up on a reader that keeps renewing", async () => {
    const s = await setup();
    s.lease("06:05:00Z");
    await runWith(s.h, agentClose(s.dir, { name: "worker" }));
    for (let tries = 2; tries <= 5; tries++) {
      s.at(`06:0${tries + 3}:20`); s.lease(`06:0${tries + 4}:00Z`);
      const status = await s.status();
      expect((await s.row()).retirePending).toEqual({ after: `2026-09-29T06:0${tries + 4}:15.000Z`, tries });
      expect(status.notes.some(note => note.startsWith("retry: ") && note.includes(`retries after 06:0${tries + 4}:15Z`))).toBe(true);
    }
    s.at("06:09:20");
    const last = await s.status();
    expect(last.notes.some(note => note.includes("still held after 6 tries"))).toBe(true);
    expect((await s.row()).retirePending).toBeUndefined();
    expect(s.retires()).toHaveLength(6);
  }, 30_000);

  // Tin-Tin, #91 review: a mailbox blip cleared the mark and left the name live, the same bug by another route.
  it("keeps the mark through a mailbox failure, retrying two minutes later", async () => {
    const s = await setup();
    s.lease("06:05:00Z");
    await runWith(s.h, agentClose(s.dir, { name: "worker" }));
    s.at("06:05:20"); s.lease(null); s.down(true);
    const failed = await s.status();
    expect((await s.row()).retirePending).toEqual({ after: "2026-09-29T06:07:20.000Z", tries: 2 });
    expect(failed.notes.some(note => note.includes("fetch failed") && note.endsWith("retries after 06:07:20Z"))).toBe(true);
    s.at("06:07:30"); s.down(false);
    await s.status();
    expect((await s.row()).retirePending).toBeUndefined();
    expect(s.retires()).toHaveLength(3);
  }, 30_000);

  it("a second agent_close on the closed row retries now and clears the mark", async () => {
    const s = await setup();
    s.lease("06:05:00Z");
    await runWith(s.h, agentClose(s.dir, { name: "worker" }));
    s.lease(null);
    const again = await runWith(s.h, agentClose(s.dir, { name: "worker" }));
    expect(again.notes.some(note => note.startsWith("Rat King name probe/worker retired"))).toBe(true);
    expect((await s.row()).retirePending).toBeUndefined();
  }, 30_000);

  it("restore drops the mark, so a later status never retires the restored Pi's name", async () => {
    const s = await setup();
    s.lease("06:05:00Z");
    await runWith(s.h, agentClose(s.dir, { name: "worker" }));
    s.lease(null);
    await runWith(s.h, agentLaunchForeground(s.dir, { action: "restore", name: "worker" }));
    expect((await s.row()).retirePending).toBeUndefined();
    s.at("06:10:00");
    await s.status();
    expect(s.retires()).toHaveLength(1);
  }, 30_000);
});
