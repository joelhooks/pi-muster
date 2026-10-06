import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentLaunchForeground as agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { harness, makeRepo, runWith } from "./test-support.ts";

async function setup() {
  const h = harness();
  h.sleep = ms => { h.now = new Date(h.now.getTime() + ms); };
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "proof", outcome: "prove launch", reviewTrigger: "weekly", nextAction: "launch", criticalPath: ["proof"], space: "w1", ephemeral: true, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "proof", label: "📬 proof", goal: "deliver prompt" }));
  const launch = (prompt = "do the work") => runWith(h, agentLaunch(dir, { action: "launch", name: "proof", role: "worker", lane: "proof", cwd: dir, label: "📬 proof", prompt }));
  return { h, launch };
}

describe("launch first-turn proof", () => {
  it.each([
    ["error", "broken model route"],
    ["paste", "paste marker"],
    ["mismatch", "does not match"],
    ["missing", "no first turn within 90 s"],
  ] as const)("does not prove %s", async (mode, detail) => {
    const { h, launch } = await setup();
    h.herdr.firstTurn = mode;
    const result = await launch();
    expect(result.row.delivery).toBe("unproven");
    expect(result.proof).toMatchObject({ state: "unproven", detail: expect.stringContaining(detail) });
    expect(result.row.events?.at(-1)).toMatchObject({ type: "FIRST_TURN", detail: expect.stringContaining(detail) });
    expect("repair" in result && result.repair).toMatchObject({ tool: "herdr_agent", args: { action: "prompt" } });
    expect(h.herdr.typedPrompts).toHaveLength(0);
    expect(h.herdr.initialPrompts).toHaveLength(1);
  });

  it("proves a clean first turn and includes the binary receipt", async () => {
    const { launch } = await setup();
    const result = await launch();
    expect(result.row.delivery).toBe("proven");
    expect(result.notes.join("\n")).toContain("Pi binary:");
  });

  it("delivers long text intact via a private @file in the start argv", async () => {
    const { h, launch } = await setup();
    const prompt = "Read this complete task.\n" + "work ".repeat(1000);
    const result = await launch(prompt);
    expect(result.row.delivery).toBe("proven");
    expect(h.herdr.typedPrompts).toEqual([]);
    expect(h.herdr.initialPrompts[0]).toContain(prompt);
    const path = result.argv.at(-1)?.slice(1);
    expect(path).toBeDefined();
    expect(readFileSync(path!, "utf8")).toBe(prompt);
  });
});
