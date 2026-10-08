import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionCommsSender } from "./extension-main.ts";

const catalog = (agents: unknown[]) => {
  const dir = mkdtempSync(join(tmpdir(), "muster-sender-"));
  mkdirSync(join(dir, ".brain/data/muster"), { recursive: true });
  writeFileSync(join(dir, ".brain/data/muster/project.json"), JSON.stringify({ agents }));
  return dir;
};

describe("sessionCommsSender", () => {
  it("signs a rowless owner as MUSTER_AGENT, as desk_send needs", () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-sender-"));
    expect(sessionCommsSender(dir, "owner-session", { MUSTER_AGENT: "rubicon-fitness-owner" })).toEqual({ agent: "rubicon-fitness-owner", session: "owner-session" });
  });

  it("has no sender without a row or MUSTER_AGENT", () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-sender-"));
    expect(sessionCommsSender(dir, "owner-session", {})).toBeUndefined();
  });

  it("maps a configured peer session to its identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "muster-sender-"));
    expect(sessionCommsSender(dir, "s1", { MUSTER_AGENT: "x", MUSTER_NETWORK_DESK_PEERS: JSON.stringify({ s1: "probe/desk" }) })).toEqual({ agent: "probe/desk", session: "s1" });
  });

  it("an unreadable catalog does not block the MUSTER_AGENT sender", () => {
    const dir = catalog([{ name: "not-a-valid-row" }]);
    expect(sessionCommsSender(dir, "owner-session", { MUSTER_AGENT: "rubicon-fitness-owner" })?.agent).toBe("rubicon-fitness-owner");
  });
});
