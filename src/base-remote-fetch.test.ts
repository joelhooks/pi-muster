import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { baseRemoteFetch } from "./ops.ts";
import { Proc, type ProcOptions } from "./runtime.ts";

describe("baseRemoteFetch", () => {
  it("lends nothing and spawns no git when the local source is missing", async () => {
    const run = vi.fn((_command: string, _args: readonly string[], _options: ProcOptions) => Effect.succeed({ code: 0, stdout: "https://example.invalid/r.git", stderr: "" }));
    const result = await Effect.runPromise(baseRemoteFetch("/nonexistent/muster-remote-only/repo", "origin/main").pipe(Effect.provideService(Proc, { run })));
    expect(result).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
  it("still reads the remote URL from a local checkout", async () => {
    const run = vi.fn((_command: string, _args: readonly string[], _options: ProcOptions) => Effect.succeed({ code: 0, stdout: "https://example.invalid/r.git\n", stderr: "" }));
    const result = await Effect.runPromise(baseRemoteFetch(process.cwd(), "origin/main").pipe(Effect.provideService(Proc, { run })));
    expect(result).toEqual({ remote: "origin", branch: "main", url: "https://example.invalid/r.git" });
    expect(run.mock.calls[0]?.[2]).toMatchObject({ cwd: process.cwd() });
  });
});
