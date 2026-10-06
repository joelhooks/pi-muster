import { closeSync, constants, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { decodeDeskRouteReceipt } from "./domain.ts";
import { CommsError, type CommsDelivery } from "./runtime.ts";

export const networkReceiptPath = (home: string) => join(home, ".local/state/muster/network-route-receipts.jsonl");

/** One explicit network → intercom fallback policy for desks and owner notices. */
export function reportedNetworkSend<R>(options: {
  home: string; sender: string; to: string; id: string; at: string;
  network: Effect.Effect<CommsDelivery, never, R>;
  fallback: () => Effect.Effect<CommsDelivery, never, R>;
}) {
  return Effect.gen(function* () {
    const network = yield* options.network;
    const fallback = network.status === "failed" || network.status === "expired" ? yield* options.fallback() : undefined;
    const record = decodeDeskRouteReceipt({ id: options.id, at: options.at, to: options.to, sender: options.sender,
      path: fallback ? "intercom-fallback" : "network", network, ...(fallback ? { fallback } : {}),
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
    const delivery = fallback ? { ...fallback, detail: `intercom fallback: ${fallback.status}; network: ${network.status}${network.detail ? ` (${network.detail})` : ""}${fallback.detail ? `; fallback: ${fallback.detail}` : ""}; receipt: ${receipt}#${options.id}` } : network;
    return { ...record, receipt, delivery };
  });
}
