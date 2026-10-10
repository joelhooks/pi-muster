import { describe, expect, it } from "vitest";
import { queuedNotice } from "./extension-main.ts";
import { sendFailureCode } from "./owner-queue.ts";

describe("owner note tool text", () => {
  it("says queued, not lost, for a stored failed send", () => {
    expect(queuedNotice({ stored: "sidecar", failureCode: "LeaseMismatch" })).toBe("queued: Rat King send failed (LeaseMismatch); saved for the owner's next pass");
  });
  it("is silent when nothing was stored, so the loud NOT DELIVERED path stands", () => {
    expect(queuedNotice({})).toBeUndefined();
  });
  it("reads the code out of a ratking failure detail", () => {
    expect(sendFailureCode("NOT DELIVERED: LeaseMismatch: Rejected LeaseMismatch (409) (ratking; no fallback)")).toBe("LeaseMismatch");
    expect(sendFailureCode("NOT DELIVERED: pi-ratking not loaded in this Pi (ratking; no fallback).")).toBe("pi-ratking not loaded in this Pi");
    expect(sendFailureCode(undefined)).toBe("unknown");
  });
});
