import { describe, expect, it } from "vitest";
import { sendFailureCode } from "./owner-queue.ts";

describe("owner note tool text", () => {
  it("reads the code out of a ratking failure detail", () => {
    expect(sendFailureCode("NOT DELIVERED: LeaseMismatch: Rejected LeaseMismatch (409) (ratking; no fallback)")).toBe("LeaseMismatch");
    expect(sendFailureCode("NOT DELIVERED: pi-ratking not loaded in this Pi (ratking; no fallback).")).toBe("pi-ratking not loaded in this Pi");
    expect(sendFailureCode(undefined)).toBe("unknown");
  });
});
