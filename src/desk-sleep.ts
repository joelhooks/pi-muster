import { statSync } from "node:fs";
import { Schema } from "effect";
import { forEachJsonlLine } from "./restart-snapshot.ts";

export const DRAIN_ENV = "RATKING_EXIT_WHEN_DRAINED";
export const WAKE_PROMPT = "Woken because mail is waiting. Read your Rat King inbox, then continue.";
export const MIN_DESK_IDLE_MS = 2 * 60 * 60_000;

export const sleepRefusals = (e: {
  desk: boolean; open: boolean; idleMs: number | null; paneStatus: string | null;
  packets: readonly string[]; launches: readonly string[]; watches: readonly string[];
}): string[] => [
  ...(!e.desk ? ["row is not a desk"] : []),
  ...(!e.open ? ["desk or its lane is not open and running"] : []),
  ...(e.idleMs === null ? ["session journal age is unavailable"] : e.idleMs <= MIN_DESK_IDLE_MS ? ["session journal has not been idle over 2 hours"] : []),
  ...(e.paneStatus === "working" ? ["pane is working"] : !["idle", "done"].includes(e.paneStatus ?? "") ? ["pane is not proven idle"] : []),
  ...e.packets.map(id => `packet in flight: ${id}`),
  ...e.launches.map(id => `launch in flight: ${id}`),
  ...e.watches.map(id => `live watch: ${id}`),
];

const entry = Schema.decodeUnknownSync(Schema.Struct({
  type: Schema.String, id: Schema.optional(Schema.String), timestamp: Schema.optional(Schema.String),
  customType: Schema.optional(Schema.String), data: Schema.optional(Schema.Unknown),
}));
const exit = Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }));
const watch = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, label: Schema.optional(Schema.String) }));

/** Stream the journal; never treat an inherited or subsequently used drain marker as a clean exit. */
export function sleepJournal(file: string, id: string) {
  const before = statSync(file);
  if (!before.isFile()) throw new Error("not a session journal");
  const until: string[] = [];
  const watches = new Map<string, string>();
  let header = false, start = 0, drainedAt = 0;
  forEachJsonlLine(file, line => {
    if (header && !line.includes('"pi-until-') && !line.includes('"bellwether-herdr-watch-') && !line.includes('"ratking.reader.exit"') && !line.includes('"message"')) return;
    const value = entry(JSON.parse(line));
    const at = Date.parse(value.timestamp ?? "");
    if (!header) {
      if (value.type !== "session" || value.id !== id || !Number.isFinite(at)) throw new Error("session journal header does not match row");
      header = true;
      start = at;
      until.push(line);
      return;
    }
    if (value.customType?.startsWith("pi-until-")) until.push(line);
    if (value.type === "message") drainedAt = 0;
    if (at < start || !Number.isFinite(at) || value.type !== "custom") return;
    if (value.customType === "ratking.reader.exit") drainedAt = exit(value.data).reason === "drained" ? at : 0;
    if (value.customType === "bellwether-herdr-watch-started" || value.customType === "bellwether-herdr-watch-resumed") {
      const w = watch(value.data);
      watches.set(w.id, `${w.id}${w.label ? ` (${w.label})` : ""}`);
    }
    if (value.customType === "bellwether-herdr-watch-finished") watches.delete(watch(value.data).id);
  });
  const after = statSync(file);
  if (!header || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("session journal changed while reading");
  return { mtimeMs: after.mtimeMs, watches: [...watches.values()], until: until.join("\n"), drainedAt };
}
