import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { assertCurrentSession, createComms, recordSessionSuccessor, retiredSessionReason, sessionSuccessorsPath } from "./comms.ts";
import { decodeSessionSuccessor } from "./domain.ts";
import { resolveDeskRoute, sendDesk } from "./desk-route.ts";
import { NetworkComms } from "./comms.ts";
import { harness, runWith } from "./test-support.ts";
import { agentLaunchForeground, laneOpen, projectOpen } from "./ops.ts";
import { appendOwnerItem, deliverOwnerItem, forwardOwner, ownerPath } from "./owner-queue.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mutate } from "./store.ts";
import { OUTBOX_REQUEST_EVENT, OUTBOX_RESULT_EVENT } from "./intercom.ts";

const successor = { at: "2026-10-07T22:00:00.000Z", project: "probe", row: "desk", from: "old-session", to: "new-session" };

describe("private session successor history", () => {
  it("decodes records, appends privately, and leaves same-id restores alone", () => {
    const h = harness();
    expect(retiredSessionReason(h.home, successor.from)).toBeUndefined();
    recordSessionSuccessor(h.home, successor);
    recordSessionSuccessor(h.home, { ...successor, from: successor.to });
    const lines = readFileSync(sessionSuccessorsPath(h.home), "utf8").trim().split("\n");
    expect(lines.map(line => decodeSessionSuccessor(JSON.parse(line)))).toEqual([successor]);
    expect(statSync(sessionSuccessorsPath(h.home)).mode & 0o777).toBe(0o600);
    expect(() => decodeSessionSuccessor({ ...successor, row: "bad/row" })).toThrow();
    expect(() => decodeSessionSuccessor({ ...successor, from: "" })).toThrow();
  });

  it("refuses only exact retired ids with a corrective alias and successor", () => {
    const h = harness();
    recordSessionSuccessor(h.home, successor);
    expect(retiredSessionReason(h.home, successor.from)).toBe("session old-session retired by restart; successor new-session; send to probe/desk or the new id");
    expect(() => assertCurrentSession(h.home, { kind: "session", id: successor.from })).toThrow("successor new-session");
    for (const to of ["probe/desk", "new-session", "old", "desk", "did:web:example.test"]) expect(() => assertCurrentSession(h.home, to)).not.toThrow();
  });

  it("allows a revived id after A → B → A and refuses the now-retired B", async () => {
    const h = harness();
    recordSessionSuccessor(h.home, successor);
    const listeners = new Map<string, (payload: unknown) => void>();
    const sent: string[] = [];
    const comms = createComms({ home: h.home, projectDir: h.root, adapterEnv: () => "intercom", createId: () => "id", events: {
      on: (event, listener) => { listeners.set(event, listener); return () => { listeners.delete(event); }; },
      emit: (event, payload) => {
        if (event !== OUTBOX_REQUEST_EVENT) return;
        const request = payload as { requestId: string; to: string };
        sent.push(request.to);
        listeners.get(OUTBOX_RESULT_EVENT)?.({ requestId: request.requestId, status: "sent" });
      },
    } });
    try {
      expect(await Effect.runPromise(comms.send(successor.from, "Hello."))).toMatchObject({ status: "failed" });
      recordSessionSuccessor(h.home, { ...successor, from: successor.to, to: successor.from });
      expect(retiredSessionReason(h.home, successor.from)).toBeUndefined();
      expect(await Effect.runPromise(comms.send(successor.from, "Hello again."))).toMatchObject({ status: "delivered" });
      expect(await Effect.runPromise(comms.send(successor.to, "Hello."))).toMatchObject({ status: "failed", detail: expect.stringContaining("successor old-session") });
      expect(sent).toEqual([successor.from]);
      // A subsequent restart must retire the revived id again.
      recordSessionSuccessor(h.home, successor);
      expect(retiredSessionReason(h.home, successor.from)).toContain("successor new-session");
      expect(retiredSessionReason(h.home, successor.to)).toBeUndefined();
    } finally { comms.dispose(); }
  });

  it("fails closed on malformed history, but aliases do not depend on it", () => {
    const h = harness();
    recordSessionSuccessor(h.home, successor);
    writeFileSync(sessionSuccessorsPath(h.home), "{}\n");
    expect(() => assertCurrentSession(h.home, successor.from)).toThrow("history invalid");
    expect(() => assertCurrentSession(h.home, "probe/desk")).not.toThrow();
  });

  it.each(["intercom", "network"] as const)("refuses %s sends and owner posts before resolving transport", async mode => {
    const h = harness();
    recordSessionSuccessor(h.home, successor);
    let emits = 0;
    const comms = createComms({ home: h.home, projectDir: h.root, adapterEnv: () => mode, createId: () => "id", events: { emit: () => { emits++; }, on: () => () => {} } });
    const delivery = await Effect.runPromise(comms.send(successor.from, "Hello."));
    expect(delivery).toMatchObject({ status: "failed", detail: expect.stringContaining("successor new-session") });
    expect(await Effect.runPromise(comms.postOwner!(successor.from, appendOwnerItem("sender", { author: "sender", kind: "fyi", title: "Hello." }, h.home, false)))).toMatchObject({ status: "failed", detail: expect.stringContaining("successor new-session") });
    await expect(Effect.runPromise(comms.resolve(successor.from))).rejects.toThrow("successor new-session");
    expect(emits).toBe(0);
    comms.dispose();
  });

  it("desk_send refuses retired ids before provisioning, network, or fallback", async () => {
    const h = harness();
    recordSessionSuccessor(h.home, successor);
    expect(() => resolveDeskRoute(h.home, h.root, successor.from)).toThrow("successor new-session");
    await expect(runWith(h, sendDesk({ home: h.home, dir: h.root, to: successor.from, text: "Hello.", sender: "sender", id: "id", at: successor.at, comms: NetworkComms }))).rejects.toThrow("successor new-session");
  });

  it("owner posts and replies refuse a retired recipient with no forward before writing or sending", async () => {
    const h = harness();
    recordSessionSuccessor(h.home, successor);
    let sent = false;
    const send = () => { sent = true; return Effect.succeed({ status: "delivered" as const }); };
    const input = { author: "sender", kind: "fyi" as const, title: "Hello." };
    expect(() => appendOwnerItem(successor.from, input, h.home)).toThrow("project_status takeover or agent_launch adopt");
    await expect(Effect.runPromise(deliverOwnerItem({ home: h.home, owner: successor.from, project: "probe", session: "sender", item: input, send }))).rejects.toThrow("owner route has no live successor");
    expect(existsSync(ownerPath(successor.from, h.home))).toBe(false);
    expect(sent).toBe(false);
  });

  it("preserves explicit owner handover forwarding and makes it visible", async () => {
    const h = harness();
    recordSessionSuccessor(h.home, successor);
    forwardOwner({ from: successor.from, to: successor.to, project: "probe", home: h.home });
    const result = await Effect.runPromise(deliverOwnerItem({ home: h.home, owner: successor.from, project: "probe", session: "sender", item: { author: "sender", kind: "fyi", title: "Hello." }, send: () => Effect.succeed({ status: "delivered" as const }) }));
    expect(result.owner).toBe(successor.to);
    expect(result.resolution).toContain("owner old-session retired; routed to successor new-session");
    expect(existsSync(ownerPath(successor.to, h.home))).toBe(true);
    expect(existsSync(ownerPath(successor.from, h.home))).toBe(false);
  });

  it("records a restore that discovers a new session id", async () => {
    const h = harness();
    await runWith(h, projectOpen({ dir: h.root, slug: "probe", outcome: "guard", reviewTrigger: "weekly", nextAction: "test", criticalPath: [], space: "w1", sidebar: false, ephemeral: true }));
    await runWith(h, laneOpen(h.root, { slug: "desk", label: "desk", goal: "guard" }));
    const old = (await runWith(h, agentLaunchForeground(h.root, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: h.root, noSkills: true }))).row;
    const file = join(h.root, "date_restored-session.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", id: "restored-session", cwd: h.root }) + "\n");
    const shell = h.herdr.panes.get(old.pane!.paneId)!;
    shell.agent = undefined;
    shell.agent_session = undefined;
    await runWith(h, mutate(h.root, project => Effect.succeed([{ ...project, agents: project.agents.map(row => row.name === old.name ? { ...row, state: "interrupted" as const, pane: null, sessionFile: file } : row) }, undefined] as const)));
    const restored = await runWith(h, agentLaunchForeground(h.root, { action: "restore", name: "desk" }));
    expect(restored.row.sessionId).toBe("restored-session");
    expect(decodeSessionSuccessor(JSON.parse(readFileSync(sessionSuccessorsPath(h.home), "utf8").trim()))).toMatchObject({ from: old.sessionId, to: "restored-session", project: "probe", row: "desk" });
  });

  it("a row alias still resolves through the live catalog", async () => {
    const h = harness();
    await runWith(h, projectOpen({ dir: h.root, slug: "probe", outcome: "guard", reviewTrigger: "weekly", nextAction: "test", criticalPath: [], space: "w1", sidebar: false, ephemeral: true }));
    await runWith(h, laneOpen(h.root, { slug: "desk", label: "desk", goal: "guard" }));
    const row = (await runWith(h, agentLaunchForeground(h.root, { action: "launch", name: "desk", role: "desk", lane: "desk", label: "desk", cwd: h.root, noSkills: true }))).row;
    recordSessionSuccessor(h.home, successor);
    const comms = createComms({ home: h.home, projectDir: h.root, adapterEnv: () => "intercom", createId: () => "id", events: { emit: () => {}, on: () => () => {} } });
    expect((await Effect.runPromise(comms.resolve("probe/desk"))).session).toBe(row.sessionId);
    comms.dispose();
  });
});
