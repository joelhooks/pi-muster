import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardedLoad } from "../src/reload-stale.ts";

/** No Effect or Bellwether may evaluate before the process dependency stamp passes. */
export default async function muster(pi: ExtensionAPI) {
  await guardedLoad({
    pi,
    root: fileURLToPath(new URL("..", import.meta.url)),
    load: () => import("../src/extension-main.ts"),
  });
}
