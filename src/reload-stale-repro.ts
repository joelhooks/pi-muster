/** Scratch-only smoke: node src/reload-stale-repro.ts [path/to/effect-4.0.0-beta.99]. */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "muster-reload-proof-"));
const oldEffect = process.argv[2] ?? join(repo, "node_modules", "effect");
mkdirSync(join(root, "extensions"));
mkdirSync(join(root, "src"));
mkdirSync(join(root, "node_modules"));
writeFileSync(join(root, "package.json"), '{"type":"module"}');
for (const name of readdirSync(join(repo, "node_modules"))) {
  if (name === "effect" || name.startsWith(".")) continue;
  symlinkSync(join(repo, "node_modules", name), join(root, "node_modules", name));
}
// beta.99 also needs its old transitive dependencies (notably fast-check).
if (process.argv[2]) {
  for (const name of readdirSync(dirname(oldEffect))) {
    if (name === "effect" || name.startsWith(".") || existsSync(join(root, "node_modules", name))) continue;
    symlinkSync(join(dirname(oldEffect), name), join(root, "node_modules", name));
  }
}
cpSync(oldEffect, join(root, "node_modules", "effect"), { recursive: true });
cpSync(join(repo, "extensions", "pi-muster.ts"), join(root, "extensions", "pi-muster.ts"));
cpSync(join(repo, "src", "reload-stale.ts"), join(root, "src", "reload-stale.ts"));
writeFileSync(join(root, "node_modules", ".package-lock.json"), "old installed tree");
writeFileSync(join(root, "src", "extension-main.ts"), `
import { Schema } from "effect";
import { Type } from "typebox";
export default function(pi) {
  pi.registerTool({name:"skill_find",label:"cache probe",description:"cache probe",parameters:Type.Object({}),
    async execute() { return {content:[{type:"text",text:typeof Schema.TaggedError}],details:{}}; }
  });
}
`);
const entry = join(root, "extensions", "pi-muster.ts");
const first = await loadExtensions([entry], root);
assert.deepEqual(first.errors, []);
assert.equal(first.extensions[0]?.tools.size, 1, "jiti awaited the dynamic import and registered the real tool");
const unchanged = await loadExtensions([entry], root);
assert.deepEqual(unchanged.errors, []);
assert.equal(unchanged.extensions[0]?.tools.size, 1, "unchanged dependencies reload normally");

// Same paths, same process, installed modules swapped exactly as in the bridge repro.
renameSync(join(root, "node_modules", "effect"), join(root, "old-effect-stash"));
cpSync(join(repo, "node_modules", "effect"), join(root, "node_modules", "effect"), { recursive: true });
cpSync(join(repo, "src"), join(root, "src"), { recursive: true });
writeFileSync(join(root, "node_modules", ".package-lock.json"), "new installed tree");
const reload = await loadExtensions([entry], root);
assert.deepEqual(reload.errors, []);
const tool = reload.extensions[0]?.tools.get("skill_find");
assert.ok(tool, "Muster tool survives the stale reload");
const context = { sessionManager: { getSessionFile: () => join(root, "session.jsonl") } };
const result = await tool.definition.execute("proof", {}, undefined, undefined, context as never);
const text = result.content.find(item => item.type === "text");
assert.ok(text?.type === "text" && text.text.includes("dependencies changed") && text.text.includes("pi --session"));

if (process.argv[2]) {
  const version: unknown = JSON.parse(readFileSync(join(oldEffect, "package.json"), "utf8"));
  assert.ok(typeof version === "object" && version !== null && "version" in version && version.version === "4.0.0-beta.99");
  // Control: bypass the entry guard. The unchanged Node cache still breaks the upgraded main.
  const bypass = await loadExtensions([join(root, "src", "extension-main.ts")], root);
  assert.ok(bypass.errors.some(error => error.error.includes("Schema.TaggedError is not a function")), JSON.stringify(bypass.errors));
}
console.log(JSON.stringify({ ok: true, root, tools: reload.extensions[0]?.tools.size, message: text?.type === "text" ? text.text : "" }));
