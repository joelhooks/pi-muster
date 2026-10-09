import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { NAME_SHIM } from "./argv.ts";
import { transcriptRescueScript } from "./packet.ts";
import { sidecarRootsScript } from "./remote.ts";
import { SESSION_MODEL_READ_SCRIPT } from "./session-model.ts";

// A keepNames loader (tsx, esbuild) serializes inner functions as `__name(fn, "x")`; bare remote node has no helper.
it("serialized remote scripts run __name-wrapped functions in bare node", () => {
  const body = `const f = __name(function g() { return 7; }, "g"); process.stdout.write(String(f()));`;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", body], { stdio: "pipe" })).toThrow(/__name is not defined/);
  expect(execFileSync(process.execPath, ["--input-type=module", "-e", `${NAME_SHIM}\n${body}`], { encoding: "utf8" })).toBe("7");
  expect(execFileSync(process.execPath, ["-e", `${NAME_SHIM}\n${body}`], { encoding: "utf8" })).toBe("7");
  for (const script of [SESSION_MODEL_READ_SCRIPT, transcriptRescueScript(), sidecarRootsScript]) expect(script).toContain(NAME_SHIM);
});
