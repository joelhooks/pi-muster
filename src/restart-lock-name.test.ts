import { expect, it } from "vitest";
import { decodeAgentName } from "./domain.ts";
import { restartLockName } from "./ops.ts";

it("keys the restart lock by project and row, so two projects' desks never collide", () => {
  const a = restartLockName("pi-muster", "desk"), b = restartLockName("gypsy", "desk");
  expect(a).not.toBe(b);
  expect(restartLockName("pi-muster", "desk")).toBe(a);
  const long = restartLockName("drovr", "a-very-long-row-name-that-fills-32");
  for (const name of [a, b, long]) expect(decodeAgentName(name)).toBe(name);
});
