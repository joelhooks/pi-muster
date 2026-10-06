import { execFileSync, spawnSync } from "node:child_process";
import { join, delimiter } from "node:path";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLaunch, laneOpen, projectOpen } from "./ops.ts";
import { FakeHerdr, harness, makeRepo, runWith } from "./test-support.ts";
import { mutate } from "./store.ts";
import { MusterEnv, Proc, type EnvShape, type ProcShape } from "./runtime.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "bin");
const hasGitIndex = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8" }).status === 0;
afterEach(() => { vi.unstubAllEnvs(); });

async function open(h: ReturnType<typeof harness>) {
  const dir = makeRepo(join(h.root, "repo"));
  await runWith(h, projectOpen({ dir, slug: "probe", outcome: "bare commands", reviewTrigger: "weekly", nextAction: "launch", criticalPath: [], space: "w1", sidebar: false, ephemeral: true, cadenceMinutes: 15, musterExtension: "/muster", deskExtension: null }));
  await runWith(h, laneOpen(dir, { slug: "work", label: "work", goal: "bare commands" }));
  return dir;
}

describe("Muster CLI launch PATH", () => {
  it.each(["launch", "fork", "restore"] as const)("prepends the local install bin for %s and preserves a profile PATH", async action => {
    const h = harness();
    const dir = await open(h);
    const parent = await runWith(h, agentLaunch(dir, { action: "launch", name: "first", role: "worker", lane: "work", label: "first", cwd: dir, env: { PATH: "/profile/bin:/usr/bin" } }));
    if (action === "restore") {
      await runWith(h, mutate(dir, project => Effect.succeed([{ ...project, agents: project.agents.map(row => ({ ...row, state: "failed" as const })) }, null] as const)));
      delete h.herdr.panes.get(parent.row.pane!.paneId)!.agent; // The failed process exited to its shell.
    }
    const result = action === "launch" ? parent : await runWith(h, agentLaunch(dir, action === "fork"
      ? { action, name: "second", from: "first", label: "second" }
      : { action, name: "first" }));
    expect(result.row.restore?.env.PATH).toBe("/muster/bin:/profile/bin:/usr/bin");
    expect(h.herdr.launcherScripts.some(script => script.includes("export PATH='/muster/bin:/profile/bin:/usr/bin'"))).toBe(true);
  });

  it("prepends the bin to the pane's own PATH instead of typing a long owner PATH", async () => {
    const long = ["/muster/bin", ...Array.from({ length: 60 }, (_, i) => `/owner/tool-${i}/bin`), process.env.PATH ?? "", "/muster/bin"].join(delimiter);
    vi.stubEnv("PATH", long);
    const h = harness();
    const dir = await open(h);
    const result = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir }));
    const typed = h.herdr.calls.filter(call => call.method === "pane.send_input").map(call => String(call.params.text)).join("\n");
    expect(h.herdr.launcherScripts.join("\n")).toContain(`export PATH='/muster/bin':"$PATH"`);
    expect(typed).toMatch(/^exec sh '/);
    expect(typed).not.toContain("/owner/tool-0/bin");
    expect(result.row.restore?.env.PATH).toBeUndefined();
  });

  it("drops duplicate bin entries from a profile PATH", async () => {
    const h = harness();
    const dir = await open(h);
    const result = await runWith(h, agentLaunch(dir, { action: "launch", name: "worker", role: "worker", lane: "work", label: "worker", cwd: dir, env: { PATH: "/muster/bin:/profile/bin:/muster/bin:/usr/bin" } }));
    expect(result.row.restore?.env.PATH).toBe("/muster/bin:/profile/bin:/usr/bin");
  });

  it.each([undefined, "/profile/bin:/usr/bin", "/configured/bin:/usr/bin"])("uses the remote install and remote PATH (%s)", async configuredPath => {
    const h = harness();
    const dir = await open(h);
    const remote = new FakeHerdr(h.home);
    const proc: ProcShape = { run: (command, args, options) => {
      if (command !== "ssh") return h.proc.run(command, args, options);
      const script = args.at(-1) ?? "";
      if (["'node' '-e'", "'git'", "'mkdir'", "'mktemp'"].some(part => script.includes(part))) return h.proc.run("sh", ["-c", script.replace("exec env PATH='/configured/bin:/usr/bin'", "exec env")], options);
      return Effect.succeed({ code: 0, stdout: script.includes("'printenv' 'PATH'") ? "/remote/node/bin:/usr/bin\n" : "", stderr: "" });
    } };
    const env: EnvShape = {
      home: h.home, now: () => h.now, sessionId: h.sessionId, paneId: undefined, musterRoot: "/owner/muster", workerWorktree: h.workerWorktree,
      createId: () => "remote-id", sleep: () => Effect.void, emitPaneClose: h.emitPaneClose,
      machines: { remote: { herdr: "remote", ssh: "remote", paths: {}, musterExtension: "/remote/muster", workerWorktree: h.workerWorktree, env: configuredPath?.startsWith("/configured") ? { PATH: configuredPath } : {}, wrap: [] } },
      remoteHerdr: () => Effect.succeed(remote.client()),
    };
    const result = await runWith(h, agentLaunch(dir, {
      action: "launch", machine: "remote", name: "remote-worker", role: "worker", lane: "work", label: "remote worker", cwd: dir, noSkills: true,
      env: configuredPath?.startsWith("/profile") ? { PATH: configuredPath } : {},
    }).pipe(Effect.provideService(MusterEnv, env), Effect.provideService(Proc, proc)));
    const expected = `/remote/muster/bin:${configuredPath ?? "/remote/node/bin:/usr/bin"}`;
    expect(result.row.restore?.env.PATH).toBe(expected);
    expect(remote.launcherScripts.some(script => script.includes(`export PATH='${expected}'`))).toBe(true);
  });

  it("prepends the owner's PATH at extension load", () => {
    const script = `await import(${JSON.stringify(join(root, "src/extension-main.ts"))}); console.log(process.env.PATH);`;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(output.trim()).toBe(`${bin}${delimiter}/usr/bin:/bin`);
  });

  // Fleet ships a tree, not a checkout. Local checkouts and CI still enforce Git modes.
  it.skipIf(!hasGitIndex).each(["muster-heavy", "muster-digest", "muster-heavy.ts", "muster-digest.ts"])("%s is executable in Git's index", file => {
    const entry = execFileSync("git", ["ls-files", "-s", `bin/${file}`], { cwd: root, encoding: "utf8" });
    expect(entry.startsWith("100755 ")).toBe(true);
  });

  it("runs packed commands bare and through an npm-style symlink", async () => {
    const destination = mkdtempSync(join(tmpdir(), "muster-path-pack-"));
    const archive = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination, "--silent"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("tar", ["-xzf", join(destination, archive), "-C", destination]);
    const packed = join(destination, "package");
    symlinkSync(join(root, "node_modules"), join(packed, "node_modules"), "dir");
    const h = harness();
    const dir = await open(h);
    const environment = { ...process.env, PATH: `${join(packed, "bin")}${delimiter}${process.env.PATH}` };
    const heavy = spawnSync("muster-heavy", ["status"], { env: environment, encoding: "utf8" });
    expect(heavy.status, heavy.stderr).toBe(0);
    expect(heavy.stdout).toContain("heavy slots:");
    const digest = spawnSync("muster-digest", [dir], { env: environment, encoding: "utf8" });
    expect(digest.status, digest.stderr).toBe(0);
    expect(digest.stdout).toContain("probe ");
    // A relative link outside the package mirrors npm's node_modules/.bin layout.
    const link = join(destination, "linked-heavy");
    symlinkSync("package/bin/muster-heavy", link);
    const linked = spawnSync(link, ["status"], { encoding: "utf8" });
    expect(linked.status, linked.stderr).toBe(0);
    expect(linked.stdout).toContain("heavy slots:");
  }, 30_000);

  it("runs muster-heavy status by bare name", () => {
    const result = spawnSync("muster-heavy", ["status"], { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("heavy slots:");
  });
});
