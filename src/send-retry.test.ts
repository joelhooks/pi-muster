import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RATKING_SEND, RATKING_SEND_RESULT, RatkingComms, SEND_RETRY_DELAYS_MS, withSendRetry } from "./comms-ratking.ts";
import { sendLaunchMail } from "./launch-mail.ts";
import { ProcError } from "./errors.ts";
import type { CommsDelivery } from "./runtime.ts";
import { harness, runWith } from "./test-support.ts";

// Switchboard, 2026-10-30 (3mz4dicaynv6b), with Tin-Tin: without the JSONL owner queue a timed-out report must not be
// lost. Transient failures retry in memory, five attempts in all, then fail loudly naming the resend.
const fast = [1, 1, 1, 1];
const timeout: CommsDelivery = { status: "failed", detail: "NOT DELIVERED: Timeout: no ratking/send:result in 30 s; is pi-ratking loaded? (no fallback)" };
const sequence = (answers: CommsDelivery[]) => {
  let calls = 0;
  return { attempt: () => Effect.sync(() => answers[Math.min(calls++, answers.length - 1)]!), calls: () => calls };
};

describe("send retry", () => {
  it("waits 2, 4, 8 and 16 s between five attempts", () => {
    expect(SEND_RETRY_DELAYS_MS).toEqual([2000, 4000, 8000, 16000]);
  });

  it("retries a transient failure until it is delivered", async () => {
    const s = sequence([timeout, { status: "failed", detail: "NOT DELIVERED: MailboxUnavailable (ratking; no fallback)" }, { status: "delivered", detail: "ratking → pilot/desk" }]);
    expect((await Effect.runPromise(withSendRetry(s.attempt, fast))).status).toBe("delivered");
    expect(s.calls()).toBe(3);
  });

  it.each(["NOT DELIVERED: UnknownName: ghost (ratking; no fallback)", "NOT DELIVERED: Retired (ratking; no fallback)", "interrupted"])("never resends %s", async detail => {
    const s = sequence([{ status: "failed", detail }]);
    expect((await Effect.runPromise(withSendRetry(s.attempt, fast))).detail).toBe(detail);
    expect(s.calls()).toBe(1);
  });

  it("gives up loudly after five attempts and names the resend", async () => {
    const s = sequence([timeout]);
    const delivery = await Effect.runPromise(withSendRetry(s.attempt, fast));
    expect(s.calls()).toBe(5);
    expect(delivery.status).toBe("failed");
    expect(delivery.detail).toBe(`${timeout.detail}; tried 5 times, so send it again with the same call`);
  });

  it("sends once with no delays, so fakes stay instant", async () => {
    const s = sequence([timeout]);
    expect(await Effect.runPromise(withSendRetry(s.attempt, []))).toEqual(timeout);
    expect(s.calls()).toBe(1);
  });

  it("a live comms retries the same request on the bus", async () => {
    const events = createEventBus();
    const bodies: string[] = [];
    events.on(RATKING_SEND, request => {
      const { requestId, body } = request as { requestId: string; body: string };
      bodies.push(body);
      // The first two sends go unanswered and time out; the third is delivered.
      if (bodies.length === 3) queueMicrotask(() => events.emit(RATKING_SEND_RESULT, { requestId, status: "delivered", to: "pilot/desk" }));
    });
    let id = 0;
    const comms = RatkingComms({ events, createId: () => String(++id), sender: () => "worker-session", target: () => ({ name: "pilot/desk", session: "desk-session" }), timeoutMs: 20, retryDelaysMs: fast });
    expect((await Effect.runPromise(comms.send("desk-session", "hello"))).status).toBe("delivered");
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
  });
});

describe("launch receipt retry", () => {
  const options = { cli: "/fake/ratking.ts", cwd: "/", to: "mail/desk", kind: "action" as const, title: "Launch w finished", body: "done", lane: "work", log: "/tmp/log", retryDelaysMs: fast };
  const run = async (replies: Array<() => ReturnType<ReturnType<typeof harness>["proc"]["run"]>>) => {
    const h = harness();
    let sends = 0;
    h.proc = { run: () => replies[Math.min(sends++, replies.length - 1)]!() };
    const result = await runWith(h, sendLaunchMail(options));
    return { result, sends };
  };
  const ok = () => Effect.succeed({ code: 0, stdout: '{"ok":true}', stderr: "" });
  const generic = () => Effect.succeed({ code: 1, stdout: "", stderr: "CliError: MailboxUnavailable" });

  it("retries a generic CLI failure until it sends", async () => {
    expect(await run([generic, generic, ok])).toEqual({ result: { sent: true }, sends: 3 });
  });

  it.each([
    ["a refusal", () => Effect.succeed({ code: 2, stdout: "", stderr: "refused" })],
    ["an uncertain send", () => Effect.succeed({ code: 3, stdout: "", stderr: "uncertain" })],
    ["a timeout", () => Effect.fail(new ProcError({ command: "env", code: null, stderr: "", message: "timed out after 30000ms" }))],
  ])("never resends %s", async (_label, reply) => {
    const { result, sends } = await run([reply as never]);
    expect(sends).toBe(1);
    expect(result.sent).toBe(false);
  });

  it("reports five tries when every attempt fails", async () => {
    const { result, sends } = await run([generic]);
    expect(sends).toBe(5);
    expect(result).toEqual({ sent: false, reason: "ratking send exited 1: CliError: MailboxUnavailable; tried 5 times" });
  });
});
