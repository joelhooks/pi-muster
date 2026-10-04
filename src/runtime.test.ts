import { describe, expect, it } from "vitest";
import { createEmitPaneClose, noEmitPaneClose } from "./runtime.ts";

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
