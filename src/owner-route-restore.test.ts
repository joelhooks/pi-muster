import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { agentClose, agentLaunchForeground as agentLaunch, laneOpen, projectOpen, projectStatus } from "./ops.ts";
import { appendOwnerItem, forwardOwner, ownerPath, ownerRoute, readOwnerQueue } from "./owner-queue.ts";
import { load, mutate } from "./store.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

async function setup(selfOwned: boolean) {
  const h = harness();
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "restore owners", reviewTrigger: "weekly", nextAction: "test", space: "w1", ephemeral: true }));
  await runWith(h, laneOpen(dir, { slug: "probe", label: "probe", goal: "restore" }));
  const launched = await runWith(h, agentLaunch(dir, { action: "launch", name: "probe", role: "worker", lane: "probe", label: "probe", cwd: dir, prompt: "start" }));
  await runWith(h, agentClose(dir, { name: "probe" }));
  if (selfOwned) await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, owner: row.sessionId })) }, undefined] as const)));
  return { h, dir, launched };
}
const forwardFiles = (home: string, session: string) => readdirSync(dirname(ownerPath(session, home))).filter(name => name.endsWith(".forward") || name.includes(".forward.retired-"));

it.each(["desk", "worker"] as const)("restores a self-owned %s from another session without stealing or forwarding its mail", async role => {
  const { h, dir, launched } = await setup(true);
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, role })) }, undefined] as const)));
  h.sessionId = "switchboard";
  const restored = await runWith(h, agentLaunch(dir, { action: "restore", name: "probe" }));
  expect(restored.row.owner).toBe(launched.row.sessionId);
  expect(restored.row.sessionId).toBe(launched.row.sessionId);
  expect((await runWith(h, load(dir))).agents[0]?.owner).toBe(launched.row.sessionId);
  appendOwnerItem(launched.row.sessionId, { author: "child", project: "probe", kind: "question", title: "desk mail" }, h.home);
  expect(forwardFiles(h.home, launched.row.sessionId)).toEqual([]);
  expect(readOwnerQueue("switchboard", h.home).items).toEqual([]);
  expect(readOwnerQueue(launched.row.sessionId, h.home).items).toHaveLength(1);
});

it("a restored self-owned row owns the actual new session id when the journal identity changes", async () => {
  const { h, dir, launched } = await setup(true);
  const file = launched.row.sessionFile!;
  const lines = readFileSync(file, "utf8").split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), id: "new-desk-session" });
  const replacement = join(dirname(file), "2026-09-29T00-00-00-000Z_new-desk-session.jsonl");
  writeFileSync(replacement, lines.join("\n"));
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, sessionFile: replacement })) }, undefined] as const)));
  h.sessionId = "switchboard";
  const restored = await runWith(h, agentLaunch(dir, { action: "restore", name: "probe" }));
  expect(restored.row.sessionId).toBe("new-desk-session");
  expect(restored.row.owner).toBe("new-desk-session");
  appendOwnerItem("new-desk-session", { author: "child", project: "probe", kind: "fyi", title: "mail" }, h.home);
  expect(forwardFiles(h.home, "new-desk-session")).toEqual([]);
});

it("external-owned restore retains caller ownership and forwarding", async () => {
  const { h, dir } = await setup(false);
  const oldOwner = h.sessionId;
  h.sessionId = "replacement";
  const restored = await runWith(h, agentLaunch(dir, { action: "restore", name: "probe" }));
  expect(restored.row.owner).toBe("replacement");
  expect(restored.notes).toContain(`restore moved external owner ${oldOwner} → replacement for probe`);
  expect(ownerRoute(oldOwner, h.home, "probe").owner).toBe("replacement");
});

it("explicit takeover reclaims a stale reverse forward and reports its retirement", async () => {
  const { h, dir, launched } = await setup(false);
  const desk = launched.row.sessionId;
  const oldOwner = h.sessionId;
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, state: "interrupted" as const })) }, undefined] as const)));
  forwardOwner({ from: desk, to: oldOwner, project: "probe", home: h.home });
  h.sessionId = desk;
  const status = await runWith(h, projectStatus(dir, { act: false, takeover: true }));
  expect(status.notes).toContain(`retired reverse forward ${desk} → ${oldOwner} for probe`);
  expect(status.project.agents[0]?.owner).toBe(desk);
  expect(ownerRoute(oldOwner, h.home, "probe").owner).toBe(desk);
  expect(forwardFiles(h.home, desk).filter(name => name.includes(".retired-"))).toHaveLength(1);
});
