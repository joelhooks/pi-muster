import { Effect } from "effect";
import { decodeRatkingStatus } from "./domain.ts";
interface Bus { emit(event: string, value: unknown): void; on(event: string, listener: (value: unknown) => void): void | (() => void) }
/** Older pi-ratking has no event: fall back after a bounded two seconds. */
export function ratkingStatus(events: Bus, requestId: string, timeoutMs = 2000): Effect.Effect<ReturnType<typeof decodeRatkingStatus> | undefined> {
  return Effect.callback(resume => {
    let done = false;
    const finish = (status?: ReturnType<typeof decodeRatkingStatus>) => { if (done) return; done = true; clearTimeout(timer); if (typeof off === "function") off(); resume(Effect.succeed(status)); };
    const off = events.on("ratking/status:result", value => {
      if (typeof value !== "object" || value === null || !("requestId" in value) || value.requestId !== requestId) return;
      try { finish(decodeRatkingStatus(value)); } catch { finish(); }
    });
    const timer = setTimeout(() => finish(), timeoutMs);
    events.emit("ratking/status", { requestId });
    return Effect.sync(() => { clearTimeout(timer); if (typeof off === "function") off(); });
  });
}
