import { expect, it } from "vitest";

// Capture at module load: setup must run before modules read the caller's identity.
const inheritedRowKeys = Object.keys(process.env).filter(key => key.startsWith("MUSTER_") || key.startsWith("RATKING_"));

it("starts test modules without the caller's Muster or Rat King environment", () => {
  expect(inheritedRowKeys).toEqual([]);
});
