import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { promptWithProof } from "./herdr.ts";
import { load } from "./store.ts";
import { failWith, harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  let elapsed = 0;
  h.sleep = ms => { elapsed += ms; h.now = new Date(h.now.getTime() + ms); };
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "proof", outcome: "prove launch", reviewTrigger: "weekly", nextAction: "launch", criticalPath: ["proof"], space: "w1", ephemeral: true, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "proof", label: "📬 proof", goal: "deliver prompt" }));
  const launch = () => runWith(h, agentLaunch(dir, { action: "launch", name: "proof", role: "worker", lane: "proof", cwd: dir, label: "📬 proof", prompt: "do the work" }));
  return { h, dir, launch, elapsed: () => elapsed };
}

describe("launch delivery proof", () => {
  it("waits through 15 seconds of not-ready rejections and types once", async () => {
    const { h, launch, elapsed } = await setup();
    h.herdr.promptNotReady = 30;
    const result = await launch();
    expect(result.row.delivery).toBe("proven");
    expect(elapsed()).toBeGreaterThanOrEqual(15_000);
    expect(h.herdr.typedPrompts).toEqual(["do the work"]);
  });

  it("waits for reported readiness before attempting the prompt", async () => {
    const { h, launch } = await setup();
    h.herdr.readinessPending = 30;
    const result = await launch();
    expect(result.row.delivery).toBe("proven");
    expect(h.herdr.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
  });

  it("returns an exact repair call when readiness never arrives", async () => {
    const { h, launch, elapsed } = await setup();
    h.herdr.promptNotReady = 100;
    const result = await launch();
    expect(result.row.delivery).toBe("unproven");
    expect("repair" in result ? result.repair : null).toEqual({ tool: "herdr_agent", args: { action: "prompt", target: result.row.pane!.paneId, prompt: "do the work" } });
    expect(h.herdr.typedPrompts).toEqual([]);
    expect(elapsed()).toBe(30_000);
    expect(h.herdr.calls.some(call => call.method === "pane.send_keys")).toBe(false);
  });

  it("does not prompt or send Enter if agent.get consumes the readiness budget", async () => {
    const { h, launch } = await setup();
    const handle = h.herdr.handle.bind(h.herdr);
    h.herdr.handle = (method, params) => {
      if (method === "agent.get") h.now = new Date(h.now.getTime() + 30_000);
      return handle(method, params);
    };
    const result = await launch();
    expect(result.row.delivery).toBe("unproven");
    expect(h.herdr.typedPrompts).toEqual([]);
    expect(h.herdr.calls.some(call => call.method === "pane.send_keys")).toBe(false);
  });

  it("does not try the prompt while launch_pending stays true", async () => {
    const { h, launch, elapsed } = await setup();
    h.herdr.readinessPending = 100;
    const result = await launch();
    expect(result.row.delivery).toBe("unproven");
    expect(h.herdr.calls.some(call => call.method === "agent.prompt")).toBe(false);
    expect(elapsed()).toBe(30_000);
    expect(result.notes.join("\n")).toContain('"prompt":"do the work"');
  });

  it("never retries a typed prompt when proof stays unproven", async () => {
    const { h } = await setup();
    const pane = h.herdr.addPane("w1", "t", "/repo");
    pane.agent = "proof";
    h.herdr.promptWorking = false;
    expect((await runWith(h, promptWithProof(pane.pane_id, "once"))).state).toBe("unproven");
    expect(h.herdr.typedPrompts).toEqual(["once"]);
  });

  it("retries start once after the budget when the pane shows an idle shell in cwd", async () => {
    const { h, launch } = await setup();
    h.herdr.startErrors = Array(61).fill("agent_pane_busy");
    h.herdr.paneTail = "land-close-race worker/land-close-race ❯ ";
    expect((await launch()).row.state).toBe("running");
    expect(h.herdr.calls.filter(call => call.method === "agent.start")).toHaveLength(62);
    expect(h.herdr.calls.filter(call => call.method === "pane.send_input")).toHaveLength(1);
  });

  it("does not retry start without an idle shell tail", async () => {
    const { h, launch } = await setup();
    h.herdr.startErrors = Array(70).fill("agent_pane_busy");
    await expect(launch()).rejects.toThrow("available-shell wait exhausted");
    expect(h.herdr.calls.filter(call => call.method === "agent.start")).toHaveLength(61);
  });

  it("stores an exact start repair in the failed row and error", async () => {
    const { h, dir } = await setup();
    h.herdr.startErrors = Array(70).fill("agent_pane_busy");
    h.herdr.paneTail = "repo % ";
    const error = await failWith(h, agentLaunch(dir, { action: "launch", name: "proof", role: "worker", lane: "proof", cwd: dir, label: "📬 proof" }));
    const row = (await runWith(h, load(dir))).agents[0]!;
    expect(row.state).toBe("failed");
    expect(row.restore?.argv).toContain("--session-id");
    expect(row.events?.at(-1)?.detail).toContain('"action":"start"');
    expect(error.message).toContain('"action":"start"');
  });
});
