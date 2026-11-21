import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentClose, agentLaunchForeground, laneOpen, projectOpen, selfRetired } from "./ops.ts";
import { load } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

// rats-nest, 2026-11-21 (rat-king efcfe7d): `ratking retire --as <name>` signs with the name's own key, so a close on a
// host without the operator wrapper can still retire the row's name. The operator shim stays the fallback.
async function setup(ratking: string | null, shimPresent = true) {
  const h = harness();
  const dir = makeRepo(join(h.root, "probe"));
  const shim = join(h.home, ".config/muster/fleet-mailbox.sh");
  const shimLog = join(h.root, "shim-args");
  const selfLog = join(h.root, "self-args");
  if (shimPresent) {
    mkdirSync(join(shim, ".."), { recursive: true });
    writeFileSync(shim, `case "$*" in role*) exit 1;; esac; printf '%s\\n' "$*" >> "${shimLog}"; exit 0\n`);
  }
  if (ratking !== null) {
    const bin = join(h.home, ".local/bin/ratking");
    mkdirSync(join(bin, ".."), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${selfLog}"\n${ratking}\n`);
    chmodSync(bin, 0o755);
  }
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "o", reviewTrigger: "r", nextAction: "n", space: "w1", ephemeral: true, desk: true, musterExtension: "/m", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "probe" }));
  await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir }));
  const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(line => line.startsWith("retire")) : [];
  const row = async () => (await runWith(h, load(dir))).agents.find(agent => agent.name === "worker")!;
  return { h, dir, shim: () => lines(shimLog), self: () => lines(selfLog), row };
}

const record = (name: string) => `echo '{"by":"did:web:x","did":"did:web:x","name":"${name}","retiredAt":"2026-11-21T21:46:17Z"}'; exit 0`;

describe("a close retires the row's name with its own key", () => {
  it("accepts only a self-signed record for exactly that name", () => {
    expect(selfRetired('{"by":"did:a","did":"did:a","name":"p/w","retiredAt":"t"}', "p/w")).toBe(true);
    expect(selfRetired('{"by":"did:op","did":"did:a","name":"p/w","retiredAt":"t"}', "p/w")).toBe(false);
    expect(selfRetired('{"by":"did:a","did":"did:a","name":"p/other","retiredAt":"t"}', "p/w")).toBe(false);
    expect(selfRetired("Accepted: a local key", "p/w")).toBe(false);
  });

  it("uses ratking retire --as and never the operator shim when that succeeds", async () => {
    const f = await setup(record("probe/worker"));
    const closed = await runWith(f.h, agentClose(f.dir, { name: "worker" }));
    expect(f.self()).toEqual(["retire --as probe/worker"]);
    expect(f.shim()).toEqual([]);
    expect(closed.notes).toContain("Rat King name probe/worker retired: sends to it now fail Retired");
  }, 60_000);

  it("retires on a host with no operator shim at all", async () => {
    const f = await setup(record("probe/worker"), false);
    const closed = await runWith(f.h, agentClose(f.dir, { name: "worker" }));
    expect(f.self()).toEqual(["retire --as probe/worker"]);
    expect(closed.notes).toContain("Rat King name probe/worker retired: sends to it now fail Retired");
  }, 60_000);

  it("falls back to the operator shim when this host holds no key for the name", async () => {
    const f = await setup(`echo "NoIdentity: This machine holds no key for probe/worker" >&2; exit 2`);
    const closed = await runWith(f.h, agentClose(f.dir, { name: "worker" }));
    expect(f.self()).toEqual(["retire --as probe/worker"]);
    expect(f.shim()).toEqual(["retire --name probe/worker"]);
    expect(closed.notes).toContain("Rat King name probe/worker retired: sends to it now fail Retired");
  }, 60_000);

  it("falls back when exit 0 carries no self-signed record", async () => {
    const f = await setup(`echo "something else"; exit 0`);
    await runWith(f.h, agentClose(f.dir, { name: "worker" }));
    expect(f.shim()).toEqual(["retire --name probe/worker"]);
  }, 60_000);

  it("keeps a LeaseLive refusal pending for the lease retry, without trying the shim", async () => {
    const f = await setup(`echo "LeaseLive: probe/worker is held by a live reader until 2026-09-29T12:10:00Z; nothing was retired" >&2; exit 4`);
    const closed = await runWith(f.h, agentClose(f.dir, { name: "worker" }));
    expect(f.shim()).toEqual([]);
    expect((await f.row()).retirePending).toBeDefined();
    expect(closed.notes.some(note => note.includes("not retired") && note.includes("LeaseLive"))).toBe(true);
  }, 60_000);

  it("uses the operator shim when this host has no ratking CLI", async () => {
    const f = await setup(null);
    await runWith(f.h, agentClose(f.dir, { name: "worker" }));
    expect(f.shim()).toEqual(["retire --name probe/worker"]);
  }, 60_000);
});
