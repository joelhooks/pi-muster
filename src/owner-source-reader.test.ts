import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs/promises", { spy: true });
afterEach(() => vi.clearAllMocks());
import { appendOwnerItem, forwardOwner, ownerPath, ownerSourceReader, readOwnerSources, writeReader } from "./owner-queue.ts";

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "owner-reader-"));
  const events: Array<{ path: string; bytes: number; lines: number }> = [];
  const reader = ownerSourceReader("owner", home, event => events.push(event));
  const post = (owner = "owner", project?: string) => appendOwnerItem(owner, { author: "probe", kind: "question", title: "hello 🐀", project }, home);
  return { home, events, reader, post };
};
describe("incremental owner source reader", () => {
  it("rebuilds the forward index only after a forward or unknown-directory event", async () => {
    const f = fixture(); f.post("old", "p");
    forwardOwner({ from: "old", to: "owner", home: f.home, project: "p" });
    await f.reader.read(); expect(readdir).toHaveBeenCalledOnce();
    await f.reader.read(); expect(readdir).toHaveBeenCalledOnce();
    expect(f.reader.event("owner.jsonl")).toBe(true);
    await f.reader.read(); expect(readdir).toHaveBeenCalledOnce();
    f.reader.event("changed.forward");
    await f.reader.read(); expect(readdir).toHaveBeenCalledTimes(2);
    f.reader.event(undefined);
    await f.reader.read(); expect(readdir).toHaveBeenCalledTimes(3);
  });
  it("decodes and reads zero history bytes on an unchanged tick", async () => {
    const f = fixture(); f.post();
    expect(await f.reader.read()).toEqual(readOwnerSources("owner", f.home));
    f.events.length = 0;
    await f.reader.read();
    expect(f.events).toEqual([{ path: ownerPath("owner", f.home), bytes: 0, lines: 0 }]);
  });
  it("ignores another recipient and reads only relevant forwards", async () => {
    const f = fixture(); f.post("other", "p"); f.post("old", "p");
    forwardOwner({ from: "other", to: "elsewhere", home: f.home, project: "p" });
    forwardOwner({ from: "old", to: "owner", home: f.home, project: "p" });
    expect(await f.reader.read()).toEqual(readOwnerSources("owner", f.home));
    f.events.length = 0;
    if (f.reader.event("other.jsonl")) await f.reader.read();
    expect(f.events).toEqual([]);
    expect(f.reader.event("old.jsonl")).toBe(true);
    expect(f.reader.event("owner.jsonl")).toBe(true);
    expect(f.reader.event("owner.reader")).toBe(false);
  });
  it("holds a partial UTF-8 line until complete, then reads only its suffix", async () => {
    const f = fixture(); const item = f.post(); const path = ownerPath("owner", f.home);
    const bytes = Buffer.from(JSON.stringify(item) + "\n");
    const split = bytes.indexOf(Buffer.from("🐀")) + 1;
    writeFileSync(path, bytes.subarray(0, split));
    expect((await f.reader.read())[0]!.items).toEqual([]);
    f.events.length = 0;
    await f.reader.read(); expect(f.events[0]!.bytes).toBe(0);
    appendFileSync(path, bytes.subarray(split));
    expect((await f.reader.read())[0]!.items.map(record => record.item)).toEqual([item]);
    expect(f.events.at(-1)).toMatchObject({ bytes: bytes.length - split, lines: 1 });
  });
  it("fully rereads on truncation and same-size inode replacement", async () => {
    const f = fixture(); const first = f.post(); f.post();
    await f.reader.read(); const path = ownerPath("owner", f.home);
    writeFileSync(path, JSON.stringify(first) + "\n");
    expect(await f.reader.read()).toEqual(readOwnerSources("owner", f.home));
    expect(f.events.at(-1)).toMatchObject({ bytes: Buffer.byteLength(JSON.stringify(first) + "\n"), lines: 1 });
    const changed = { ...first, text: first.text.replace("hello", "world") };
    writeFileSync(path + ".replacement", JSON.stringify(changed) + "\n"); renameSync(path + ".replacement", path);
    expect((await f.reader.read())[0]!.items[0]!.item.text).toContain("world");
    expect(f.events.at(-1)!.lines).toBe(1);
  });
  it("preserves boundaries, aliases, multi-hop order and malformed line cursors", async () => {
    const f = fixture(); f.post(); f.post("old", "p");
    writeReader("old", f.home, Date.now() + 1000);
    forwardOwner({ from: "old", to: "middle", home: f.home, project: "p" });
    forwardOwner({ from: "middle", to: "owner", home: f.home, project: "p" });
    const late = f.post("scratch", "p");
    appendFileSync(ownerPath("old", f.home), "not-json\n" + JSON.stringify(late) + "\n");
    expect(await f.reader.read()).toEqual(readOwnerSources("owner", f.home));
    f.post("new", "p"); forwardOwner({ from: "new", to: "owner", home: f.home, project: "p" });
    expect(f.reader.event("new.forward")).toBe(true);
    expect(await f.reader.read()).toEqual(readOwnerSources("owner", f.home));
  });
});
