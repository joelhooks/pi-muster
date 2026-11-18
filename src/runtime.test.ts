import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createEmitPaneClose, noEmitPaneClose, stopChild } from "./runtime.ts";

it.each([true, false])("sends TERM first and reaps a child (cooperates: %s)", async cooperates => {
  const child = spawn(process.execPath, ["-e", `process.on('SIGTERM', () => {
    process.stdout.write('TERM', () => { if (${cooperates}) process.exit(0); });
  });
  process.stdout.write('ready');
  setInterval(() => {}, 50);`], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close").then(() => {});
  const [ready] = await once(child.stdout!, "data");
  expect(String(ready)).toBe("ready");
  let seen = "";
  child.stdout!.on("data", chunk => { seen += String(chunk); });
  await stopChild(child, closed);
  expect(seen).toBe("TERM");
  expect(child.signalCode).toBe(cooperates ? null : "SIGKILL");
});

const notice = { paneId: "p1", terminalId: "t1", reason: "agent_close worker" };

describe("pane-close bus capability", () => {
  it("distinguishes an empty acknowledgement from no listener", () => {
    const emit = createEmitPaneClose({ emit: (event, payload) => {
      expect(event).toBe("bellwether/pane-close/v1");
      expect(payload).toMatchObject(notice);
      if (typeof payload === "object" && payload !== null && "reply" in payload && typeof payload.reply === "function") {
        payload.reply({ retired: [] });
      }
    } });
    expect(emit(notice)).toEqual([]);
    expect(createEmitPaneClose({ emit: () => {} })(notice)).toBeUndefined();
    expect(noEmitPaneClose(notice)).toBeUndefined();
  });

  it.each([null, {}, { retired: ["valid", 1] }, { retired: "watch" }])("ignores malformed replies: %j", value => {
    const emit = createEmitPaneClose({ emit: (_event, payload) => {
      if (typeof payload === "object" && payload !== null && "reply" in payload && typeof payload.reply === "function") payload.reply(value);
    } });
    expect(emit(notice)).toBeUndefined();
  });
});
