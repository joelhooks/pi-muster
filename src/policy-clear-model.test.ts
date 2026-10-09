import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { projectOpen, projectUpdate, splitClearedModels } from "./ops.ts";
import { load, mutate } from "./store.ts";
import { harness, runWith } from "./test-support.ts";

it("splits model:null off a role patch and leaves everything else to the decoder", () => {
  expect(splitClearedModels({ roles: { worker: { model: null } } })).toEqual({ policy: undefined, cleared: ["worker"] });
  expect(splitClearedModels({ wipLimit: 2, roles: { worker: { model: null, thinking: "high" } } })).toEqual({ policy: { wipLimit: 2, roles: { worker: { thinking: "high" } } }, cleared: ["worker"] });
  expect(splitClearedModels({ roles: { worker: { model: "sol" } } }).cleared).toEqual([]);
});

// A pinned worker model outranks the fleet steer; the Switchboard had no way to unpin one.
it("project_update with roles.worker.model null clears the stored pin and keeps the role's other settings", async () => {
  const h = harness();
  const dir = join(h.home, "alpha"); mkdirSync(dir, { recursive: true });
  await runWith(h, projectOpen({ dir, slug: "alpha", outcome: "o", reviewTrigger: "r", nextAction: "n", ephemeral: true, createSpace: true }));
  await runWith(h, mutate(dir, p => Effect.succeed([{ ...p, policy: { ...p.policy, comms: "network" as const, roles: { worker: { model: "openai-codex/gpt-6.1-sol", thinking: "medium" as const }, desk: { model: "opus" } } } }, undefined] as const)));
  await runWith(h, projectUpdate(dir, { policy: { roles: { worker: { model: null } } } }));
  const policy = (await runWith(h, load(dir))).policy;
  expect(policy?.roles?.worker).toEqual({ thinking: "medium" });
  expect(policy?.roles?.desk).toEqual({ model: "opus" });
  expect(policy?.comms).toBe("network");
});
