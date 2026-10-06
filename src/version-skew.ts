import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Version = { kind: "git"; id: string } | { kind: "package"; id: string };

/** Read HEAD directly, including worktree gitdir/commondir and packed refs. No process at load. */
function gitVersion(root: string): Version | undefined {
  let git = join(root, ".git");
  if (!statSync(git).isDirectory()) {
    const pointer = readFileSync(git, "utf8").trim();
    if (!pointer.startsWith("gitdir: ")) return;
    git = resolve(root, pointer.slice(8));
  }
  const head = readFileSync(join(git, "HEAD"), "utf8").trim();
  const sha = /^[0-9a-f]{40,64}$/;
  if (sha.test(head)) return { kind: "git", id: head };
  if (!head.startsWith("ref: refs/")) return;
  const ref = head.slice(5);
  if (ref.split("/").includes("..")) return;
  let common = git;
  try { common = resolve(git, readFileSync(join(git, "commondir"), "utf8").trim()); } catch { /* ordinary checkout */ }
  for (const dir of new Set([git, common])) {
    try {
      const id = readFileSync(join(dir, ref), "utf8").trim();
      if (sha.test(id)) return { kind: "git", id };
    } catch { /* packed ref */ }
    try {
      for (const line of readFileSync(join(dir, "packed-refs"), "utf8").split("\n")) {
        const [id, name] = line.split(" ");
        if (name === ref && id && sha.test(id)) return { kind: "git", id };
      }
    } catch { /* unavailable */ }
  }
}

/** Local static and dynamic imports identify the package files loaded by the extension. */
function loadedFiles(root: string): string[] {
  const files = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+\.ts)["']/g)) {
      if (match[1]) visit(resolve(dirname(file), match[1]));
    }
  };
  visit(join(root, "extensions", "pi-muster.ts"));
  return [...files];
}

function packageVersion(root: string, files: readonly string[]): Version | undefined {
  const data: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof data !== "object" || data === null || !("version" in data) || typeof data.version !== "string" || !data.version || !files.length) return;
  const newest = Math.max(...files.map((file) => statSync(file).mtimeMs));
  return Number.isFinite(newest) ? { kind: "package", id: `${data.version}@${newest}` } : undefined;
}

export interface VersionSkew {
  check(): Promise<string | undefined>;
}

/** Best effort only. One snapshot per minute; concurrent tools share the same check. */
export function createVersionSkew({ root, now = Date.now }: { root: string; now?: () => number }): VersionSkew {
  let files: string[] = [];
  const read = (): Version | undefined => {
    try { const git = gitVersion(root); if (git) return git; } catch { /* package install */ }
    try { return packageVersion(root, files); } catch { return; }
  };
  let loaded = read();
  if (!loaded) {
    try { files = loadedFiles(root); loaded = read(); } catch { /* no useful version */ }
  }
  let checkedAt = -Infinity;
  let warning: string | undefined;
  let pending: Promise<string | undefined> | undefined;
  const counts = new Map<string, number | undefined>();
  const check = async () => {
    const disk = read();
    if (!loaded || !disk || loaded.kind !== disk.kind || loaded.id === disk.id) return;
    let count: number | undefined;
    if (loaded.kind === "git" && disk.kind === "git") {
      if (!counts.has(disk.id)) {
        const id = disk.id;
        const base = loaded.id;
        const value = await new Promise<number | undefined>((done) => {
          execFile("git", ["rev-list", "--count", `${base}..${id}`], { cwd: root, timeout: 2_000 }, (error, stdout) => {
            const output = stdout.trim();
            done(!error && /^\d+$/.test(output) ? Number(output) : undefined);
          });
        });
        counts.set(id, value);
      }
      count = counts.get(disk.id);
    }
    const short = (version: Version) => version.kind === "git" ? version.id.slice(0, 7) : version.id;
    return `⚠ Muster tools are stale: loaded ${short(loaded)}, on disk ${short(disk)}${count === undefined ? "" : ` (${count} commits)`}. Restart it onto current code with agent_launch action: "restart" (an owner, or a desk for itself); never /reload.`;
  };
  return {
    check() {
      if (!loaded) return Promise.resolve(undefined);
      if (pending) return pending;
      const time = now();
      if (time - checkedAt < 60_000) return Promise.resolve(warning);
      checkedAt = time;
      pending = check().catch(() => undefined).then((line) => { warning = line; return line; }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}

/** Keep the host API intact; every nested registrar receives this same facade. */
export function withVersionSkew(pi: ExtensionAPI, skew: VersionSkew): ExtensionAPI {
  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    pi.registerTool({
      ...tool,
      async execute(...args) {
        const result = await tool.execute(...args);
        let warning: string | undefined;
        try { warning = await skew.check(); } catch { /* never fail a tool for telemetry */ }
        if (!warning) return result;
        let first = true;
        return {
          ...result,
          content: [...result.content.map((item) => {
            if (item.type !== "text" || !first) return item;
            first = false;
            const body = tool.name === "project_status" && !("isError" in result && result.isError) ? item.text.replace(/^(.*)$/m, "$1 · ⚠ Muster tools stale") : item.text;
            return { ...item, text: `${body}\n${warning}` };
          }), ...(first ? [{ type: "text" as const, text: warning }] : [])],
        };
      },
    });
  };
  return new Proxy(pi, { get: (target, key, receiver) => key === "registerTool" ? registerTool : Reflect.get(target, key, receiver) });
}
