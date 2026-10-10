// slice B: integrity of the exact vendor bytes still needed by the phone path.
// Manifests retain upstream provenance; deleted siblings are not runtime dependencies.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const root = new URL("./vendor/", import.meta.url);
describe("slice B phone vendor integrity", () => {
  for (const group of ["lexicon", "envelope", "mailbox-client"]) {
    it(`retains pinned ${group} source bytes only`, () => {
      const dir = new URL(`rat-king-${group}/`, root);
      const manifest = JSON.parse(readFileSync(new URL("VENDOR.json", dir), "utf8"));
      const desk = group === "lexicon" ? JSON.parse(readFileSync(new URL("desk/VENDOR.json", dir), "utf8")).files : {};
      for (const file of readdirSync(dir).filter(file => file.endsWith(".ts"))) {
        const hash = manifest.files[file] ?? desk[file]?.sha256;
        expect(hash, file).toMatch(/^[a-f0-9]{64}$/);
        expect(digest(new URL(file, dir).pathname), file).toBe(hash);
      }
    });
  }
  it("retains only phone fixtures with their original provenance", () => {
    const dir = new URL("rat-king-fixtures/", root);
    const lexicon = JSON.parse(readFileSync(new URL("rat-king-lexicon/VENDOR.json", root), "utf8"));
    const desk = JSON.parse(readFileSync(new URL("desk/VENDOR.json", dir), "utf8")).files;
    // Slice A keeps the fixture inventory until Slice B removes the phone client.
    expect(readdirSync(dir).filter(file => file.endsWith(".json")).sort()).toEqual([...Object.keys(lexicon.fixtures), ...Object.keys(lexicon.newFixtures ?? {}), ...Object.keys(desk)].sort());
    for (const file of readdirSync(dir).filter(file => file.endsWith(".json"))) {
      const hash = lexicon.fixtures[file] ?? lexicon.newFixtures?.[file] ?? desk[file]?.sha256;
      expect(digest(new URL(file, dir).pathname), file).toBe(hash);
    }
  });
});
