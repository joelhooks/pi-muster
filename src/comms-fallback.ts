import { closeSync, constants, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { decodeDeskRouteReceipt } from "./domain.ts";
import { CommsError, type CommsDelivery } from "./runtime.ts";

export const networkReceiptPath = (home: string) => join(home, ".local/state/muster/network-route-receipts.jsonl");

const undelivered = (delivery: CommsDelivery | undefined) => !delivery || delivery.status === "failed" || delivery.status === "expired";

/** A routed send that reached no one: the tool result must be an error, never a quiet receipt. */
export const lostDeliveryText = (detail: string | undefined) => `NOT DELIVERED: the network send and its fallback both failed; nothing reached the recipient. Do not assume it was read.${detail ? ` ${detail}` : ""}`;

/** One explicit network → fallback policy for desks and owner notices. A fallback of undefined means none ran. */
export function reportedNetworkSend<R>(options: {
  home: string; sender: string; to: string; id: string; at: string;
  network: Effect.Effect<CommsDelivery, never, R>;
  fallback: () => Effect.Effect<CommsDelivery | undefined, never, R>;
  /** Herdr types into a Muster-opened pane; intercom is the default. */
  fallbackPath?: "intercom-fallback" | "herdr-prompt";
  /** Plain words leading the returned detail, such as why a row needs a restart. */
  notice?: (fallback: CommsDelivery | undefined) => string | undefined;
}) {
  return Effect.gen(function* () {
    const network = yield* options.network;
    const fallback = network.status === "failed" || network.status === "expired" ? yield* options.fallback() : undefined;
    const path = fallback ? options.fallbackPath ?? "intercom-fallback" : "network";
    const record = decodeDeskRouteReceipt({ id: options.id, at: options.at, to: options.to, sender: options.sender,
      path, network, ...(fallback ? { fallback } : {}),
    });
    const receipt = networkReceiptPath(options.home);
    yield* Effect.try({ try: () => {
      mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
      const fd = openSync(receipt, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) throw new Error("unsafe receipt file");
        writeSync(fd, `${JSON.stringify(record)}\n`);
      } finally { closeSync(fd); }
    }, catch: () => new CommsError("NetworkComms sent but receipt write failed; do not retry blindly") });
    const label = path === "herdr-prompt" ? "herdr-prompt" : "intercom fallback";
    const routed = fallback ? { ...fallback, detail: `${label}: ${fallback.status}${fallback.id ? `; intercom id: ${fallback.id}` : ""}; network: ${network.status}${network.detail ? ` (${network.detail})` : ""}${fallback.detail ? `; ${path === "herdr-prompt" ? "herdr" : "fallback"}: ${fallback.detail}` : ""}; receipt: ${receipt}#${options.id}` } : network;
    const notice = options.notice?.(fallback);
    const delivery = notice ? { ...routed, detail: `${notice}${routed.detail ? `; ${routed.detail}` : ""}` } : routed;
    // Network failed and the fallback failed or never ran: the message is lost, and the sender must hear it.
    const lost = undelivered(network) && undelivered(fallback);
    return { ...record, receipt, delivery, lost };
  });
}
