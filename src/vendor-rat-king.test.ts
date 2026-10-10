import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { phoneItem } from "./desk-record-fake.ts";

const root = new URL("./vendor/", import.meta.url);
describe("restart-wave compatibility only", () => {
  it("removes the client, crypto, fixtures and all generated lexicon except three inert lazy-import names", () => {
    expect(readdirSync(root)).toEqual(["rat-king-lexicon"]);
    expect(readdirSync(new URL("rat-king-lexicon/", root)).sort()).toEqual(["defs.ts", "desk.item.ts", "mailbox.send.ts"]);
    expect(existsSync(new URL("./__fixtures__/ratking-v0/", import.meta.url))).toBe(false);
    for (const name of ["defs.ts", "desk.item.ts", "mailbox.send.ts"]) {
      expect(readFileSync(new URL(`rat-king-lexicon/${name}`, root), "utf8")).not.toMatch(/openNetworkMailbox|fetch\(|WebSocket|lease\.acquire/);
    }
  });
  it("keeps the old domain's lazy Item and Output imports usable to read an existing pending thread", async () => {
    const [{ Main }, { Output }] = await Promise.all([
      import("./vendor/rat-king-lexicon/desk.item.ts"), import("./vendor/rat-king-lexicon/mailbox.send.ts"),
    ]);
    expect(Schema.decodeUnknownSync(Main)(phoneItem)).toEqual(phoneItem);
    const receipt = { receipt: { state: "delivered", message: { messageId: "existing-thread" } } };
    expect(Schema.decodeUnknownSync(Output)(receipt)).toEqual(receipt);
  });
  it("refuses the old quarantine path rather than restarting envelope ownership", async () => {
    const { MessageEvent } = await import("./vendor/rat-king-lexicon/defs.ts");
    expect(() => Schema.decodeUnknownSync(MessageEvent)({ receipt: { message: { messageId: "x" } } })).toThrow();
  });
  it("retains the inert comms-network restart imports, without phone open/identity exports", async () => {
    const standIn = await import("./comms-network.ts");
    expect(standIn.liveRows()).toEqual([]);
    expect(await Effect.runPromise(standIn.provisionLiveRows())).toEqual([]);
    expect(standIn).not.toHaveProperty("openNetworkMailbox"); expect(standIn).not.toHaveProperty("readNetworkIdentities");
  });
});
