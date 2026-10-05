import { join } from "node:path";
import { Effect } from "effect";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HerdrApiError } from "@joelhooks/pi-bellwether/herdr-client";
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
  const reprompt = () => {
    const pane = h.herdr.addPane("w1", "t", dir);
    h.herdr.handle("agent.start", { name: "proof", pane_id: pane.pane_id, args: [] });
    return runWith(h, promptWithProof(pane.pane_id, "do the work"));
  };
  return { h, dir, launch, reprompt, elapsed: () => elapsed };
}

describe("explicit re-prompt delivery proof", () => {
  it("waits through 15 seconds of not-ready rejections and types once", async () => {
    const { h, reprompt, elapsed } = await setup();
    h.herdr.promptNotReady = 30;
    expect((await reprompt()).state).toBe("proven");
    expect(elapsed()).toBeGreaterThanOrEqual(15_000);
    expect(h.herdr.typedPrompts).toEqual(["do the work"]);
  });

  it("waits for reported readiness before attempting the prompt", async () => {
    const { h, reprompt } = await setup();
    h.herdr.readinessPending = 30;
    expect((await reprompt()).state).toBe("proven");
    expect(h.herdr.calls.filter(call => call.method === "agent.prompt")).toHaveLength(1);
  });

  it("returns the repair text when readiness never arrives", async () => {
    const { h, reprompt, elapsed } = await setup();
    h.herdr.promptNotReady = 100;
    expect(await reprompt()).toMatchObject({ state: "unproven", repairPrompt: "do the work" });
    expect(h.herdr.typedPrompts).toEqual([]);
    expect(elapsed()).toBe(30_000);
    expect(h.herdr.calls.some(call => call.method === "pane.send_keys")).toBe(false);
  });

  it("does not prompt or send Enter if agent.get consumes the readiness budget", async () => {
    const { h, reprompt } = await setup();
    const handle = h.herdr.handle.bind(h.herdr);
    h.herdr.handle = (method, params) => {
      if (method === "agent.get") h.now = new Date(h.now.getTime() + 30_000);
      return handle(method, params);
    };
    expect((await reprompt()).state).toBe("unproven");
    expect(h.herdr.typedPrompts).toEqual([]);
    expect(h.herdr.calls.some(call => call.method === "pane.send_keys")).toBe(false);
  });

  it("does not try the prompt while launch_pending stays true", async () => {
    const { h, reprompt, elapsed } = await setup();
    h.herdr.readinessPending = 100;
    expect(await reprompt()).toMatchObject({ state: "unproven", repairPrompt: "do the work" });
    expect(h.herdr.calls.some(call => call.method === "agent.prompt")).toBe(false);
    expect(elapsed()).toBe(30_000);
  });

  it("never retries a typed prompt when proof stays unproven", async () => {
    const { h } = await setup();
    const pane = h.herdr.addPane("w1", "t", "/repo");
    pane.agent = "proof";
    h.herdr.promptWorking = false;
    expect((await runWith(h, promptWithProof(pane.pane_id, "once"))).state).toBe("unproven");
    expect(h.herdr.typedPrompts).toEqual(["once"]);
  });
});

describe("private launcher submission", () => {
  it("submits one short exec line, with a private full script and no agent.start", async () => {
    const { h, launch } = await setup();
    const result = await launch();
    const inputs = h.herdr.calls.filter(call => call.method === "pane.send_input");
    expect(inputs).toHaveLength(1);
    const text = String(inputs[0]!.params.text);
    expect(text).toMatch(/^exec sh '/);
    expect(text.length).toBeLessThan(800);
    const path = /^exec sh '(.+)'$/.exec(text)![1]!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("'--' 'do the work'");
    expect(h.herdr.calls.some(call => call.method === "agent.start" || call.method === "agent.prompt")).toBe(false);
    expect(result.row.delivery).toBe("proven");
  });

  it("fails a rejected submission once instead of blindly repeating exec", async () => {
    const { h, dir, launch } = await setup();
    const handle = h.herdr.handle.bind(h.herdr);
    let submissions = 0;
    h.herdr.handle = (method, params) => {
      if (method === "pane.send_input") {
        submissions += 1;
        throw new HerdrApiError({ operation: method, code: "pane_not_found", message: "launch rejected" });
      }
      return handle(method, params);
    };
    await expect(launch()).rejects.toThrow("launch rejected");
    expect(submissions).toBe(1);
    expect((await runWith(h, load(dir))).agents[0]?.state).toBe("failed");
  });

  it("fails closed before typing if private script verification fails", async () => {
    const { h } = await setup();
    const proc = h.proc;
    h.proc = { run: (command, args, options) => args.some(arg => arg.includes("fs.statSync(p).mode"))
      ? Effect.succeed({ code: 1, stdout: "", stderr: "verify refused" })
      : proc.run(command, args, options) };
    expect((await failWith(h, launchEffect(h.root))).message).toContain("copied and verified");
    expect(h.herdr.calls.some(call => call.method === "pane.send_input")).toBe(false);
  });
});

function launchEffect(root: string) {
  return agentLaunch(join(root, "repo"), { action: "launch", name: "proof", role: "worker", lane: "proof", cwd: join(root, "repo"), label: "proof", prompt: "do the work" });
}
