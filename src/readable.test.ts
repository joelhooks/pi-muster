import { describe, expect, it } from "vitest";
import { squashed } from "./readable.ts";

// Real drovr report excerpts, relative to .brain/data/muster/reports.
const reports = [
  ["resume-merge-drain/resume-merge-drain-f517dd335b5b.md", "authoritativeall5DOtagNULL+actualclass/nsIDs", false],
  ["resume-merge-drain/resume-merge-drain-f517dd335b5b.md", "matchescandidate24migrationnames", false],
  ["resume-merge-drain/resume-merge-drain-f517dd335b5b.md", "boundedexactf517/stageownTWO/before-stateb299DISABLED2Shieldabsent/explicitb299return+receipt", false],
  ["resume-merge-drain/fix663-outbox-ed69b2804f9d.svx", "Missing actors leave work owed for retry; success settles it.", true],
  ["resume-merge-drain/fix663-outbox-ed69b2804f9d.svx", "apps/api/src/unsubscribe/drain.ts", true],
  ["basin/basin-rebase-4e19f6857ab8.svx", "https://github.com/badass-courses/drovr/actions/runs/37181126242", true],
  ["cd-instructions/cd-instructions-7c44d03ee073.svx", "MySQL collection behavior/property tests", true],
  ["ratstack-parity/xstate-effect-073fba80996b.svx", "Adds `snapshot?` to `createEffectActor` options in @xstate/effect", true],
] as const;

describe("squashed", () => {
  it.each(reports)("checks real report %s: %s", (_source, text, ok) => {
    expect(squashed(text).ok).toBe(ok);
  });

  it.each([
    "Collectionfence4/4behavior/propertytests",
    "CollectionFenceBehaviorPropertyTests",
    "collectionfence4behaviortests",
    "collectionfence/4behaviortests/propertytests",
    "This report includes Collectionfence4/4behavior/propertytests and needs spaces.",
    "thisfieldhasmanywordsbutnospaces".repeat(3),
    `${"joinedwords".repeat(4)} ${"otherjoinedwords".repeat(3)}`,
  ])("rejects joined prose: %s", text => {
    expect(squashed(text)).toMatchObject({ ok: false, samples: expect.any(Array) });
  });

  it.each([
    "", "internationalization", "electroencephalographically", "shortCamelCase", "4/4 tests passed.",
    "Collection fence: 4/4 behavior/property tests passed.",
    "src/CollectionFence/BehaviorPropertyTests.ts", "./SomeLongCamelCaseDirectory/file", "../x/y", "~/x",
    "/Users/joel/CollectionFenceBehaviorPropertyTests", "foo/SomeLongCamelCaseDirectory/file.ts",
    "docs/design/collectionfence/behaviortests/propertytests",
    "collectionfence/behaviortests/propertytests", "foo/SomeLongCamelCaseDirectory/file",
    "CollectionFenceBehaviorPropertyTests.ts",
    "@scope/CollectionFenceBehaviorPropertyTests", "collection-fence-behavior-property-tests", "Collection_Fence_Behavior_Property_Tests",
    "4e19f6857ab8b8dbf5f3109fe639bf8045c76667", "b299e35893df", "01234567-abcd-abcd-abcd-0123456789ab",
    "01ARZ3NDEKTSV4RRFFQ69G5FAV", "37181126242", "🐀".repeat(50),
    "https://example.com/CollectionFenceBehaviorPropertyTests?q=" + "a".repeat(90),
    "`Collectionfence4/4behavior/propertytests`",
    "``CollectionFenceBehaviorPropertyTests ` nested``",
    "Before.\n```ts\nCollectionFenceBehaviorPropertyTests\n```\nAfter.",
    "Before.\n~~~ts\nCollectionFenceBehaviorPropertyTests\n~~~\nAfter.",
    "Before.\r\n```ts\r\nCollectionFenceBehaviorPropertyTests\r\n```\r\nAfter.",
    "````ts\n```\nCollectionFenceBehaviorPropertyTests\n````\nReadable after the fence.",
    "```ts\nCollectionFenceBehaviorPropertyTests\n`````\nReadable after the fence.",
    "```ts\n" + "CollectionFenceBehaviorPropertyTests".repeat(4),
    "Checked `/" + "a".repeat(100) + "`.",
    "Paths: " + "/" + "a".repeat(100),
    Array(10).fill("internationalization").join(" "),
    Array(4).fill("electroencephalographically").join(" "),
  ])("accepts readable prose or literals: %s", text => {
    expect(squashed(text)).toEqual({ ok: true });
  });

  it("still checks prose after a longer closing fence", () => {
    expect(squashed("```ts\ncode\n`````\nCollectionFenceBehaviorPropertyTests").ok).toBe(false);
  });

  it("returns unique samples in source order", () => {
    const joined = "CollectionFenceBehaviorPropertyTests";
    expect(squashed(`${joined} ${joined}`)).toEqual({ ok: false, samples: [joined] });
  });
});
