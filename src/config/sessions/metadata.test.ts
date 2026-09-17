import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { deriveSessionMetaPatch } from "./metadata.js";

function slackContext(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "slack",
    Surface: "slack",
    ChatType: "channel",
    From: "slack:channel:C1",
    GroupChannel: "#engineering",
    NativeChannelId: "C1",
    ...overrides,
  };
}

describe("deriveSessionMetaPatch Slack title ownership", () => {
  it("keeps room metadata without deriving a display name for thread sessions", () => {
    const patch = deriveSessionMetaPatch({
      ctx: slackContext({ MessageThreadId: "171234.001" }),
      sessionKey: "agent:main:slack:channel:C1:thread:171234.001",
      groupResolution: {
        channel: "slack",
        chatType: "channel",
        id: "C1",
        key: "slack:channel:C1",
      },
    });

    expect(patch).toMatchObject({ groupChannel: "#engineering" });
    expect(patch).not.toHaveProperty("displayName");
  });

  it("preserves existing naming for ordinary Slack channel sessions", () => {
    const patch = deriveSessionMetaPatch({
      ctx: slackContext(),
      sessionKey: "agent:main:slack:channel:C1",
      groupResolution: {
        channel: "slack",
        chatType: "channel",
        id: "C1",
        key: "slack:channel:C1",
      },
    });

    expect(patch?.displayName).toBe("slack:#engineering");
  });
});
