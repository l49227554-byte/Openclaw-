// Matrix tests cover emote outbound behavior through the message action helpers.
import { describe, expect, it, vi } from "vitest";
import * as sendModule from "../send.js";
import { sendMatrixMessage } from "./messages.js";

const MATRIX_ACTION_TEST_CFG = {
  channels: {
    matrix: {},
  },
};

describe("matrix message actions emote outbound", () => {
  it("forwards emote intent through the shared Matrix send helper", async () => {
    const sendSpy = vi.spyOn(sendModule, "sendMessageMatrix").mockResolvedValue({
      messageId: "$sent",
      roomId: "!room:example.org",
    } as never);

    try {
      await sendMatrixMessage("!room:example.org", "waves", {
        cfg: MATRIX_ACTION_TEST_CFG,
        emote: true,
      });

      expect(sendSpy.mock.calls[0]?.[2]).toMatchObject({ emote: true });
    } finally {
      sendSpy.mockRestore();
    }
  });
});
