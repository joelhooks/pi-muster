import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

const Hashes = Schema.Record(Schema.String, Schema.String);
const VendorManifest = Schema.Struct({
  repo: Schema.String,
  commit: Schema.String,
  sourcePath: Schema.String,
  review: Schema.Literal("unreviewed"),
  files: Hashes,
  upstreamFiles: Hashes,
  fixturePath: Schema.String,
  fixtures: Hashes,
  newFixtures: Schema.optional(Hashes),
});
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const manifests = ["lexicon", "envelope", "mailbox-client"].map(name => {
  const directory = new URL(`./vendor/rat-king-${name}/`, import.meta.url);
  const manifest = Schema.decodeUnknownSync(VendorManifest)(JSON.parse(readFileSync(new URL("VENDOR.json", directory), "utf8")));
  return { name, directory, manifest };
});

// Pinned from rat-king 0e895a3, independent of the new manifests.
const originalFixtures = {
  "ack.input.json": "5ae3c6912e14f90a8fe64c331133ce7d75c2925c1b4c2cacbe2c46bf9f26b1b6",
  "ack.output.json": "d92f3c839ac585dfb6729e81f4f2ae283bb50c8a4187dff5b86ceac013747b31",
  "lease.object.json": "316646b06ffe0cbe4a694b704c0a616606d6fe967aad8603de69adfc0fbc73db",
  "list.output.json": "0a9d87da780445a8b9926bbd2ce5ae44451500cab2cb4e40707d6d23be003a61",
  "list.params.json": "b5f928471a0852599db6eeb21b23d8f02797aacb3c019e8751178a20f635e9de",
  "profile.record.json": "c3eb2252b5f64a6c61692f5dd069ca4ed0ef5221dc9391ff06d4fe0ad9019cdc",
  "send.input.json": "6920c3ad59e6c0fb49a8d3d18dffeeddb80609e7314a5d2fd6ebdbef798f678b",
  "send.output.json": "4e5ce9dde39a60317cd3653d887a752cb699628886e7fd3236490fa7daed62c1",
  "signed-message.object.json": "b26017b44e5b0db42d530afe3e9d4717232f96a4b1b10dc873a399bf19920915",
  "signing-payload.object.json": "c535b1ffbc3a1c327e862ff9dd0c193d0ae266e38d537106d11377f0e21beb4d",
  "theme.record.json": "86c23ed981414bb971464a8c995c5c4abe8843a30de2eb54ebc0799b5064ecab",
};

describe("Rat King c49a733 vendor integrity", () => {
  for (const { name, directory, manifest } of manifests) {
    it(`${name}: hashes every source file and permits only package import rewrites`, () => {
      expect(manifest.repo).toBe("https://github.com/joelhooks/rat-king");
      expect(manifest.commit).toBe("c49a733");
      expect(manifest.sourcePath).toBe(`packages/${name}/src`);
      expect(manifest.review).toBe("unreviewed");
      expect(readdirSync(directory).sort()).toEqual([...Object.keys(manifest.files), "VENDOR.json"].sort());
      expect(Object.keys(manifest.upstreamFiles).sort()).toEqual(Object.keys(manifest.files).sort());
      for (const [file, hash] of Object.entries(manifest.files)) {
        const bytes = readFileSync(new URL(file, directory));
        expect(sha256(bytes), `${name}/${file}`).toBe(hash);
        const restored = bytes.toString("utf8").replace(
          /(from\s+")\.\.\/rat-king-(lexicon|envelope)\/([^"\n]+)\.ts(")/g,
          (_match, prefix: string, target: string, module: string, quote: string) =>
            `${prefix}@rat-king/${target}${target === "envelope" && module === "envelope" ? "" : `/${module}`}${quote}`,
        );
        expect(sha256(Buffer.from(restored)), `${name}/${file} upstream`).toBe(manifest.upstreamFiles[file]);
      }
    });
    it(`${name}: hashes all 28 upstream fixtures`, () => {
      const fixtures = new URL(manifest.fixturePath, directory);
      const hashes = { ...manifest.fixtures, ...manifest.newFixtures };
      expect(Object.keys(hashes)).toHaveLength(28);
      expect(readdirSync(fixtures).sort()).toEqual(Object.keys(hashes).sort());
      for (const [file, hash] of Object.entries(hashes)) {
        expect(sha256(readFileSync(new URL(file, fixtures))), file).toBe(hash);
      }
    });
  }
  it("keeps all original 11 fixtures byte-identical to 0e895a3 in both locations", () => {
    for (const [file, hash] of Object.entries(originalFixtures)) {
      for (const directory of ["./__fixtures__/ratking-v0/", "./vendor/rat-king-fixtures/"]) {
        expect(sha256(readFileSync(new URL(`${directory}${file}`, import.meta.url))), `${directory}${file}`).toBe(hash);
      }
    }
  });
  it("explicitly packs every vendored source, manifest and fixture", () => {
    const pkg = Schema.decodeUnknownSync(Schema.Struct({ files: Schema.Array(Schema.String) }))(
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
    );
    for (const { name, manifest } of manifests) {
      for (const file of [...Object.keys(manifest.files), "VENDOR.json"]) {
        expect(pkg.files).toContain(`src/vendor/rat-king-${name}/${file}`);
      }
    }
    for (const file of readdirSync(new URL("./vendor/rat-king-fixtures/", import.meta.url))) {
      expect(pkg.files).toContain(`src/vendor/rat-king-fixtures/${file}`);
    }
  });
});
