import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: () => { const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} }); queueMicrotask(() => child.emit("spawn")); return child; },
}));
import { NetworkComms } from "./comms.ts";
import { networkConfigPath, networkIdentityPath } from "./comms-network.ts";
import { agentLaunch, agentLaunchForeground, laneOpen, projectOpen, runLaunchJob } from "./ops.ts";
import { Comms } from "./runtime.ts";
import { load, mutate } from "./store.ts";
import { harness, runWith } from "./test-support.ts";
import { readOwnerQueue } from "./owner-queue.ts";

function reference(agent: string) {
  const did = `did:web:${agent}.example.invalid`;
  return { did, secret: `entry_${agent}`, document: { id: did, verificationMethod: ["atproto", "encryption"].map(key => ({ id: `${did}#${key}`, controller: did, publicKeyJwk: { kty: "EC", crv: "P-256", x: "public-x", y: "public-y" } })), authentication: [`${did}#atproto`], keyAgreement: [`${did}#encryption`] } };
}
function privateFile(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }

it("the background result reports mailbox delivery, never via argv", async () => {
  const h = harness(); const dir = join(h.home, "project"); mkdirSync(dir, { recursive: true });
  await runWith(h, projectOpen({ dir, slug: "pilot", outcome: "mailbox proof", reviewTrigger: "review", nextAction: "launch", ephemeral: true, createSpace: true }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "packet", repo: dir }));
  await runWith(h, agentLaunchForeground(dir, { action: "launch", name: "desk", role: "desk", lane: "work", label: "desk", cwd: dir, noSkills: true }));
  await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, policy: { ...project.policy, comms: "network" }, agents: project.agents.map(row => ({ ...row, sessionId: h.sessionId })) }, undefined] as const)));
  privateFile(networkConfigPath(h.home), { endpoint: "https://mailbox.example.invalid", serviceDid: "did:web:mailbox.example.invalid", provisionWrapper: "/private/wrapper", didTemplate: "did:web:{agent}.example.invalid" });
  privateFile(networkIdentityPath(h.home), { desk: reference("desk"), worker: reference("worker") });
  const messages: Array<{ to: string; body: string }> = [];
  const service = { ...NetworkComms, mode: () => Effect.succeed("network" as const), send: (to: unknown, body: string) => Effect.sync(() => {
    if (typeof to !== "string") throw new Error("expected session target");
    messages.push({ to, body });
    const pane = [...h.herdr.panes.values()].find(pane => pane.agent_session?.value.includes(to));
    if (!pane?.agent_session) throw new Error("recipient Pi not started");
    appendFileSync(pane.agent_session.value, `${JSON.stringify({ type: "message", message: { role: "user", content: body } })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: "working", stopReason: "stop" } })}\n`);
    return { status: "accepted" as const };
  }) };
  const receipt = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, noSkills: true, prompt: "The complete mailbox brief." }));
  if (!("jobId" in receipt)) throw new Error("expected background job");
  const result = await runWith(h, runLaunchJob(dir, receipt.jobId).pipe(Effect.provideService(Comms, service)));
  expect(result.kind).toBe("action");
  expect(result.body).toContain("delivery: proven via network");
  expect(result.body).toContain("network brief: accepted");
  expect(result.body).not.toContain("via argv");
  expect(messages).toEqual([{ to: receipt.row.sessionId, body: "The complete mailbox brief." }]);
  expect(h.herdr.initialPrompts).toEqual([]);
  expect((await runWith(h, load(dir))).agents.find(row => row.name === "worker")?.delivery).toBe("proven");
  expect(readOwnerQueue(h.sessionId, h.home).items.at(-1)?.item.text).toContain("delivery: proven via network");
});
