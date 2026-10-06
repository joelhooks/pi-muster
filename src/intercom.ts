import { Effect } from "effect";
import {
  INTERCOM_EXTENSION_REGISTER_EVENT,
  INTERCOM_EXTENSION_REGISTRY_READY_EVENT,
} from "@joelhooks/pi-bellwether/intercom";

import type { IntercomTransport, OutboxStatus } from "./runtime.ts";

/**
 * pi-intercom from inside Muster. Sends go through pi-intercom's consent-aware
 * extension outbox, so pi-intercom resolves the target and records provenance.
 * The directory registers its own namespace only to list live sessions; it
 * publishes nothing.
 */
export const OUTBOX_REQUEST_EVENT = "intercom:outbox-request";
export const OUTBOX_RESULT_EVENT = "intercom:outbox-result";
export const MUSTER_INTERCOM_NAMESPACE = "muster/directory/v1";
const OUTBOX_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 1_500;

interface EventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, listener: (payload: unknown) => void): (() => void) | void;
}

interface Channel {
  snapshot(): { connected: boolean; supported: boolean };
  listSessions(): Promise<readonly unknown[]>;
}

export interface LiveIntercom extends IntercomTransport {
  readonly dispose: () => void;
}

export function createIntercom(events: EventBus, createId: () => string): LiveIntercom {
  let channel: Channel | undefined;
  let disposed = false;
  let registered = false;
  const register = () => {
    if (disposed || registered) return;
    try {
      events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
        namespace: MUSTER_INTERCOM_NAMESPACE,
        ownerEligible: false,
        onReady(value: Channel) {
          if (disposed) return;
          channel = value;
          registered = true;
        },
        onEvent() {},
      });
    } catch {
      // A second registration in one process is refused; the first keeps working.
    }
  };
  const offReady = events.on(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, register);
  register();

  return {
    send: (to, message) =>
      Effect.callback<{ status: OutboxStatus; detail?: string; id: string }>((resume) => {
        const requestId = `muster-${createId()}`;
        let done = false;
        const finish = (status: OutboxStatus, detail?: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (typeof off === "function") off();
          resume(Effect.succeed(detail ? { status, detail, id: requestId } : { status, id: requestId }));
        };
        const off = events.on(OUTBOX_RESULT_EVENT, (payload) => {
          const result = payload as { requestId?: unknown; status?: unknown; code?: unknown; detail?: unknown };
          if (result?.requestId !== requestId) return;
          const status = result.status;
          finish(
            status === "sent" || status === "queued" || status === "rejected" || status === "blocked" || status === "failed" ? status : "failed",
            [result.code, result.detail].filter((part) => typeof part === "string").join(": ") || undefined,
          );
        });
        const timer = setTimeout(() => finish("unavailable", "no outbox result; is pi-intercom loaded?"), OUTBOX_TIMEOUT_MS);
        timer.unref?.();
        events.emit(OUTBOX_REQUEST_EVENT, {
          version: 1,
          requestId,
          extensionId: "pi-muster",
          extensionName: "Muster",
          to,
          message,
        });
        return Effect.sync(() => finish("failed", "interrupted"));
      }),
    sessions: () =>
      Effect.promise(async () => {
        const current = channel;
        if (!current) return undefined;
        const snapshot = current.snapshot();
        if (!snapshot.connected || !snapshot.supported) return undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const listed = await Promise.race([
            current.listSessions(),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), LIST_TIMEOUT_MS);
            }),
          ]);
          return listed?.flatMap((value) =>
            typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string"
              ? [(value as { id: string }).id]
              : [],
          );
        } catch {
          return undefined;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    dispose() {
      disposed = true;
      channel = undefined;
      if (typeof offReady === "function") offReady();
    },
  };
}
