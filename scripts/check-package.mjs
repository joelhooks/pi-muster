import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const approved = [...pkg.files, "package.json"].sort();

const extensionSources = readdirSync("extensions")
  .filter((path) => path.endsWith(".ts"))
  .sort();
if (JSON.stringify(extensionSources) !== JSON.stringify(["pi-muster.ts"])) {
  throw new Error(`Pi loads every TypeScript file in extensions; expected only pi-muster.ts, got ${JSON.stringify(extensionSources)}`);
}

const report = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }))[0];
if (!report || !Array.isArray(report.files)) throw new Error("npm pack did not return one JSON file list");

const actual = report.files.map((entry) => entry.path).sort();
if (JSON.stringify(actual) !== JSON.stringify(approved)) {
  throw new Error(`package path set changed\nexpected: ${JSON.stringify(approved)}\nactual:   ${JSON.stringify(actual)}`);
}

// Every relative value import in a packed source must itself be packed; an installed copy cannot load otherwise.
const packed = new Set(actual);
const unresolved = actual.filter((path) => path.endsWith(".ts")).flatMap((path) =>
  [...readFileSync(path, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gmu)]
    .map((match) => normalize(join(dirname(path), match[1])))
    .filter((target) => !packed.has(target))
    .map((target) => `${path} -> ${target}`));
if (unresolved.length > 0) throw new Error(`packed sources import unpacked files: ${unresolved.join(", ")}`);

const forbidden = actual.filter(
  (path) => path.startsWith(".brain/") || path.startsWith(".pi/") || path.endsWith(".test.ts") || path.endsWith("test-support.ts"),
);
if (forbidden.length > 0) throw new Error(`forbidden package paths: ${forbidden.join(", ")}`);

const privateFiles = actual.filter((path) => /privacy\s*:\s*["']?private\b/i.test(readFileSync(path, "utf8")));
if (privateFiles.length > 0) throw new Error(`private files in package: ${privateFiles.join(", ")}`);

for (const tool of ["--tools", "--exclude-tools"]) {
  const argv = readFileSync("src/argv.ts", "utf8");
  if (!argv.includes(`"${tool}"`)) throw new Error(`argv.ts no longer names ${tool} as forbidden`);
}

process.stdout.write(`${JSON.stringify({ ok: true, entryCount: actual.length, packageSize: report.size, unpackedSize: report.unpackedSize })}\n`);
