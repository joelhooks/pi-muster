import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeProject } from "./domain.ts";
import { CATALOG_WRITER_SCHEMA_VERSION, create, load, mutate, projectPath, requiredWriterSchema } from "./store.ts";
import { failWith, harness, runWith } from "./test-support.ts";

const CURRENT_WRITER = CATALOG_WRITER_SCHEMA_VERSION;
const NEWER = CURRENT_WRITER + 1;
const lane = (slug: string) => ({
  slug, kind: "work", label: slug, goal: "ship", writeScope: [], repo: null,
  generated: [], tabId: null, root: null, state: "proposed", archived: false,
  createdAt: "t", updatedAt: "t",
});
function setup(extra = {}) {
  const h = harness();
  const dir = join(h.root, "catalog");
  const raw = {
    version: 1, slug: "probe", label: "probe", dir, outcome: "ship", reviewTrigger: "weekly",
    criticalPath: [], nextAction: "ship", mode: "rift-merge", spaceId: null, sidebar: "off",
    ephemeral: true, musterExtension: null, deskExtension: null, cadenceMinutes: null,
    state: "active", lanes: [lane("one"), lane("two")], agents: [], packets: [], reviews: [],
    createdAt: "t", updatedAt: "t", ...extra,
  };
  mkdirSync(join(dir, ".brain/data/muster"), { recursive: true });
  writeFileSync(projectPath(dir), `${JSON.stringify(raw, null, 2)}\n`);
  return { h, dir, raw };
}
const unrelatedPatch = (project: ReturnType<typeof decodeProject>) => Effect.succeed([
  { ...project, lanes: project.lanes.map(row => row.slug === "two" ? { ...row, label: "changed" } : row) }, null,
] as const);

describe("catalog writer schema fence", () => {
  it("reads newer catalogs but refuses an unrelated write without changing any bytes", async () => {
    const s = setup({ writerSchemaVersion: NEWER, futureProject: { keep: true }, lanes: [
      { ...lane("one"), futureLane: "keep" }, lane("two"),
    ] });
    expect((await runWith(s.h, load(s.dir))).slug).toBe("probe");
    const before = readFileSync(projectPath(s.dir), "utf8");
    const error = await failWith(s.h, mutate(s.dir, unrelatedPatch));
    expect(error._tag).toBe("StoreError");
    expect(error.message).toContain(`catalog written by a newer Muster (schema ${NEWER} > ${CURRENT_WRITER}); restart this session on current code`);
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(before);
  });

  it("checks the disk stamp even if the patch removes or downgrades it", async () => {
    const s = setup({ writerSchemaVersion: NEWER });
    const before = readFileSync(projectPath(s.dir), "utf8");
    await failWith(s.h, mutate(s.dir, p => Effect.succeed([{ ...p, writerSchemaVersion: CURRENT_WRITER }, null] as const)));
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(before);
  });

  it.each([{}, { writerSchemaVersion: 0 }, { writerSchemaVersion: 1 }, { writerSchemaVersion: CURRENT_WRITER }])("writes legacy/current catalogs and stamps what the content needs: %j", async extra => {
    const s = setup(extra);
    expect((await runWith(s.h, load(s.dir))).slug).toBe("probe");
    await runWith(s.h, mutate(s.dir, unrelatedPatch));
    const saved = await runWith(s.h, load(s.dir));
    expect(saved).toMatchObject({ writerSchemaVersion: 1, lanes: [
      { slug: "one", label: "one" }, { slug: "two", label: "changed" },
    ] });
  });

  it.each([
    [1, {}],
    [2, { lanes: [{ ...lane("one"), discarded: true }, lane("two")] }],
    [3, { policy: { deployLevel: 2 } }],
    [3, { lanes: [{ ...lane("one"), deployLevel: 1 }, lane("two")] }],
    [4, { lanes: [{ ...lane("one"), kind: "retro" }, lane("two")] }],
  ])("stamps schema %i for content that needs it, even over a higher current stamp", async (want, extra) => {
    const s = setup({ writerSchemaVersion: CURRENT_WRITER, ...extra });
    await runWith(s.h, mutate(s.dir, unrelatedPatch));
    expect(requiredWriterSchema(await runWith(s.h, load(s.dir)))).toBe(want);
    expect(JSON.parse(readFileSync(projectPath(s.dir), "utf8")).writerSchemaVersion).toBe(want);
  });

  it("lets an older writer back in once current code rewrites content it can hold", async () => {
    const s = setup({ writerSchemaVersion: 3 });
    await runWith(s.h, mutate(s.dir, unrelatedPatch));
    expect(JSON.parse(readFileSync(projectPath(s.dir), "utf8")).writerSchemaVersion).toBe(1);
  });

  it("rechecks the disk at write time even when load saw an older stamp", async () => {
    const s = setup({ writerSchemaVersion: CURRENT_WRITER });
    const newer = `${JSON.stringify({ ...s.raw, writerSchemaVersion: NEWER, futureProject: true })}\n`;
    await failWith(s.h, mutate(s.dir, p => {
      // Simulate a writer outside the lock protocol changing the file after load.
      writeFileSync(projectPath(s.dir), newer);
      return unrelatedPatch(p);
    }));
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(newer);
  });

  it("allows a read-only mutation on a newer catalog", async () => {
    const s = setup({ writerSchemaVersion: NEWER });
    const before = readFileSync(projectPath(s.dir), "utf8");
    expect(await runWith(s.h, mutate(s.dir, p => Effect.succeed([p, "read-only"] as const)))).toBe("read-only");
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(before);
  });

  it("stamps newly created catalogs too", async () => {
    const s = setup();
    const dir = join(s.h.root, "new-catalog");
    await runWith(s.h, create(decodeProject({ ...s.raw, dir })));
    expect(await runWith(s.h, load(dir))).toMatchObject({ writerSchemaVersion: 1 });
  });

  it.each([-1, 1.5, "2", null])("rejects malformed version stamps rather than silently dropping them: %j", async writerSchemaVersion => {
    const s = setup({ writerSchemaVersion });
    const before = readFileSync(projectPath(s.dir), "utf8");
    expect((await failWith(s.h, load(s.dir)))._tag).toBe("StoreError");
    await failWith(s.h, mutate(s.dir, unrelatedPatch));
    expect(readFileSync(projectPath(s.dir), "utf8")).toBe(before);
  });
});
