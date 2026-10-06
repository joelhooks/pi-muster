import { appendFileSync, readFileSync, statSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { firstTurnDetail, piReceiptSuffix, promptWithProof, readPiReceipt } from "./herdr.ts";
import { decodeMachines } from "./domain.ts";
import { sshProc } from "./remote.ts";
import { liveProc, Proc, type ProcShape } from "./runtime.ts";
import { harness, runWith } from "./test-support.ts";

const user = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } }) + "\n";
const assistant = (extra = {}) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [], ...extra } }) + "\n";

function setup() {
  const h = harness();
  h.sleep = ms => { h.now = new Date(h.now.getTime() + ms); };
  const pane = h.herdr.addPane("w1", "t", h.home);
  h.herdr.handle("agent.start", { pane_id: pane.pane_id, name: "proof", args: ["--session-id", "proof-session"] });
  return { h, pane, file: pane.agent_session!.value };
}

describe("first-turn journal boundary", () => {
  it("accepts tool use and normalized prefix, but only the first assistant", () => {
    expect(firstTurnDetail(user("Do  the\nwork now") + assistant() + assistant({ stopReason: "error" }), "Do the work").state).toBe("proven");
    expect(firstTurnDetail(user("Do the work") + assistant({ errorMessage: "failure" }), "Do the work")).toMatchObject({ state: "unproven", detail: "first assistant error: failure" });
  });
  it.each(["[paste #1 1303 chars]", "[paste #2 +20 lines]", "[paste #3]"])("rejects marker-only user text %s", marker => {
    expect(firstTurnDetail(user(marker) + assistant(), "task")).toMatchObject({ state: "unproven", detail: "user entry is only a paste marker" });
  });
  it("waits on a partial append instead of treating it as corrupt", () => {
    expect(firstTurnDetail(user("task") + '{"type":"message"', "task").state).toBe("waiting");
    expect(firstTurnDetail(user("task") + 'not json\n', "task").state).toBe("unproven");
  });
  it("does not use a clean old turn to prove a new submission", async () => {
    const { h, pane, file } = setup();
    appendFileSync(file, user("task") + assistant());
    h.herdr.firstTurn = "missing";
    const result = await runWith(h, promptWithProof(pane.pane_id, "task"));
    expect(result).toMatchObject({ state: "unproven", detail: "no first turn within 90 s" });
  }, 30_000);
  it("keeps the probe suffix below 120 typed characters, and probe failure is unknown", async () => {
    expect(piReceiptSuffix("00000000-0000-0000-0000-000000000000").length).toBeLessThan(120);
    const { h } = setup();
    expect(await runWith(h, readPiReceipt(h.home, "missing"))).toBe("Pi binary: unknown; pi version: unknown");
  });
  it("reads the remote session and writes a verified private remote prompt through SSH", async () => {
    const { h, pane } = setup();
    const calls: string[] = [];
    const runner: ProcShape = { run: (_command, args, options) => {
      const script = args.at(-1)!;
      calls.push(script);
      return liveProc.run("sh", ["-c", script], options);
    } };
    const machine = decodeMachines({ remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/muster", workerWorktree: "/worker", env: {}, wrap: [] } }).remote!;
    const remoteProc = sshProc("remote", machine, runner, h.home);
    const prompt = "complete work ".repeat(300);
    const result = await runWith(h, promptWithProof(pane.pane_id, prompt).pipe(Effect.provideService(Proc, remoteProc)));
    expect(result.state).toBe("proven");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.some(script => script.includes("writeFileSync"))).toBe(true);
    const file = /Read the complete work prompt at (.+)\. Do the work/.exec(h.herdr.typedPrompts[0]!)![1]!;
    expect(readFileSync(file, "utf8")).toBe(prompt);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("keeps the short file pointer in the repair when readiness never arrives", async () => {
    const { h, pane } = setup();
    h.herdr.promptNotReady = 100;
    const result = await runWith(h, promptWithProof(pane.pane_id, "work ".repeat(500)));
    expect(result).toMatchObject({ state: "unproven", repairPrompt: expect.stringMatching(/^Read the complete work prompt at /) });
    expect(h.herdr.typedPrompts).toEqual([]);
  });
  it("returns unproven without typing if remote prompt copy fails", async () => {
    const { h, pane } = setup();
    const base = h.proc;
    h.proc = { run: (command, args, options) => args.some(arg => arg.includes("writeFileSync")) ? Effect.succeed({ code: 1, stdout: "", stderr: "copy failed" }) : base.run(command, args, options) };
    expect(await runWith(h, promptWithProof(pane.pane_id, "work ".repeat(500)))).toMatchObject({ state: "unproven", detail: "long work prompt file could not be copied and verified; no text typed" });
    expect(h.herdr.typedPrompts).toEqual([]);
  });
});
