import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// pi-muster is public (Ernestine, 2026-10-17). Tracked text must not name the operator's home, the tailnet, or
// private addresses. Patterns are assembled from fragments so this file does not match itself.
const ROOT = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", ".brain", ".agent_sources", ".agent-sources", ".pi", ".scratch-desk", "package-lock.json"]);
const TEXT = /\.(ts|mts|js|mjs|json|md|sh|txt|yml|yaml)$|^[^.]+$/;
const user = ["jo", "el"].join("");
const RULES: ReadonlyArray<[string, RegExp]> = [
  ["operator home", new RegExp(`/(Users|home)/${user}\\b`)],
  ["tailnet hostname", new RegExp(`\\.tail[0-9a-f]+\\.ts\\.net\\b`)],
  ["private IPv4", new RegExp(String.raw`\b(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b`)],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return TEXT.test(name) ? [path] : [];
  });
}

/** Tracked files when this is a git checkout, so an operator's ignored local notes do not count; else the shipped tree. */
function files(): string[] {
  if (!existsSync(join(ROOT, ".git"))) return walk(ROOT);
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0")
    .filter(path => path && !path.split("/").some(part => SKIP.has(part)) && TEXT.test(path.slice(path.lastIndexOf("/") + 1)))
    .map(path => join(ROOT, path)).filter(path => existsSync(path));
}

export function boundaryHits(text: string): string[] {
  return RULES.filter(([, rule]) => rule.test(text)).map(([name]) => name);
}

describe("public boundary", () => {
  it("each rule catches what it names and passes neutral placeholders", () => {
    expect(boundaryHits(`/Users/${user}/Code`)).toEqual(["operator home"]);
    expect(boundaryHits(`/home/${user}/.cache`)).toEqual(["operator home"]);
    expect(boundaryHits(`http://host.tail${"7af24"}.ts.net:1`)).toEqual(["tailnet hostname"]);
    expect(boundaryHits(["100", "99", "76", "47"].join("."))).toEqual(["private IPv4"]);
    expect(boundaryHits(["192", "168", "1", "2"].join("."))).toEqual(["private IPv4"]);
    expect(boundaryHits("/Users/alice/Code /home/alice remote1 1.2.3.4 v10.2.3")).toEqual([]);
  });
  it("finds none in the tracked tree", () => {
    const hits = files().flatMap(path => {
      const text = readFileSync(path, "utf8");
      return boundaryHits(text).map(rule => `${relative(ROOT, path)}: ${rule}`);
    });
    expect(hits).toEqual([]);
  });
});
