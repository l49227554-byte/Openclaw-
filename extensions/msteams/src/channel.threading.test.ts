import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { msteamsPlugin } from "./channel.js";

function requireMSTeamsExtractToolSendResult() {
  const extractToolSendResult = msteamsPlugin.actions?.extractToolSendResult;
  if (!extractToolSendResult) {
    throw new Error("msteams actions.extractToolSendResult unavailable");
  }
  return extractToolSendResult;
}

describe("msteamsPlugin.threading.buildToolContext", () => {
  function callBuildToolContext(context: {
    ChatType?: string;
    To?: string;
    NativeChannelId?: string;
    ReplyToId?: string;
    MessageThreadId?: string | number;
  }) {
    const build = msteamsPlugin.threading?.buildToolContext;
    if (!build) {
      throw new Error("msteams threading.buildToolContext unavailable");
    }
    return build({
      cfg: {} as OpenClawConfig,
      accountId: undefined,
      context,
    });
  }

  it("uses NativeChannelId for channel turns so actions route via Graph team/channel ids", () => {
    // Teams channel inbound messages carry the compound Graph target
    // on NativeChannelId. buildToolContext must prefer it over the bare
    // `conversation:<id>` in To so action fallbacks route via Graph.
    const result = callBuildToolContext({
      ChatType: "channel",
      To: "conversation:19:channel-abc@thread.tacv2",
      NativeChannelId: "graph-team-1/19:channel-abc@thread.tacv2",
      ReplyToId: "reply-1",
    });
    expect(result?.currentChannelId).toBe("conversation:19:channel-abc@thread.tacv2");
    expect(result?.currentChatType).toBe("channel");
    expect(result?.currentMessagingTarget).toBe("graph-team-1/19:channel-abc@thread.tacv2");
    expect(result?.currentGraphChannelId).toBe("graph-team-1/19:channel-abc@thread.tacv2");
    expect(result?.currentThreadTs).toBe("reply-1");
    expect(result?.replyToMode).toBe("all");
  });

  it("prefers MessageThreadId (thread root) over ReplyToId (parent)", () => {
    const result = callBuildToolContext({
      ChatType: "channel",
      To: "conversation:19:channel-abc@thread.tacv2",
      MessageThreadId: "thread-root",
      ReplyToId: "nested-parent",
    });
    expect(result?.currentThreadTs).toBe("thread-root");
    expect(result?.replyToMode).toBe("all");
  });

  it("omits replyToMode when no thread context is present", () => {
    const result = callBuildToolContext({ ChatType: "direct", To: "user:aad-user-1" });
    expect(result?.currentThreadTs).toBeUndefined();
    expect(result?.replyToMode).toBeUndefined();
  });

  it("does not stamp ReplyToId as ambient thread for DM turns", () => {
    const result = callBuildToolContext({
      ChatType: "direct",
      To: "user:aad-user-1",
      ReplyToId: "quoted-parent",
    });
    expect(result?.currentThreadTs).toBeUndefined();
    expect(result?.replyToMode).toBeUndefined();
  });

  it("does not stamp ReplyToId as ambient thread for group turns", () => {
    const result = callBuildToolContext({
      ChatType: "group",
      To: "conversation:19:groupchat@thread.v2",
      ReplyToId: "quoted-parent",
    });
    expect(result?.currentThreadTs).toBeUndefined();
    expect(result?.replyToMode).toBeUndefined();
  });

  it("stamps channel ReplyToId when MessageThreadId is absent", () => {
    const result = callBuildToolContext({
      ChatType: "channel",
      To: "conversation:19:channel-abc@thread.tacv2",
      ReplyToId: "channel-parent",
    });
    expect(result?.currentThreadTs).toBe("channel-parent");
    expect(result?.replyToMode).toBe("all");
  });

  it("falls back to To for DM turns (no NativeChannelId)", () => {
    const result = callBuildToolContext({ ChatType: "direct", To: "user:aad-user-1" });
    expect(result?.currentChannelId).toBe("user:aad-user-1");
    expect(result?.currentChatType).toBe("direct");
    expect(result?.currentMessagingTarget).toBeUndefined();
    expect(result?.currentGraphChannelId).toBeUndefined();
  });

  it("falls back to To for group chat turns (no NativeChannelId)", () => {
    const result = callBuildToolContext({
      ChatType: "group",
      To: "conversation:19:groupchat@thread.v2",
    });
    expect(result?.currentChannelId).toBe("conversation:19:groupchat@thread.v2");
    expect(result?.currentChatType).toBe("group");
    expect(result?.currentMessagingTarget).toBeUndefined();
    expect(result?.currentGraphChannelId).toBeUndefined();
  });

  it("ignores NativeChannelId that does not encode a teamId/channelId pair", () => {
    const result = callBuildToolContext({
      To: "conversation:19:chat@thread.v2",
      NativeChannelId: "19:chat@thread.v2",
    });
    expect(result?.currentChannelId).toBe("conversation:19:chat@thread.v2");
    expect(result?.currentMessagingTarget).toBeUndefined();
    expect(result?.currentGraphChannelId).toBeUndefined();
  });
});

describe("msteamsPlugin.actions.extractToolSendResult", () => {
  it.each([
    {
      name: "receipt raw",
      result: {
        details: { result: { receipt: { raw: [{ conversationId: "19:channel@thread.tacv2" }] } } },
      },
    },
    {
      name: "receipt part raw",
      result: {
        details: {
          result: { receipt: { parts: [{ raw: { conversationId: "19:channel@thread.tacv2" } }] } },
        },
      },
    },
    {
      name: "direct delivery result",
      result: { details: { result: { conversationId: "19:channel@thread.tacv2" } } },
    },
  ])("canonicalizes a Graph target from $name", ({ result }) => {
    expect(
      requireMSTeamsExtractToolSendResult()({
        result,
        send: { to: "team-aad/19:channel@thread.tacv2", threadId: "thread-root" },
      }),
    ).toEqual({ to: "conversation:19:channel@thread.tacv2" });
  });

  it("canonicalizes user targets to the resolved conversation", () => {
    expect(
      requireMSTeamsExtractToolSendResult()({
        result: { details: { result: { conversationId: "19:dm@thread.v2" } } },
        send: { to: "user:aad-user-1" },
      }),
    ).toEqual({ to: "conversation:19:dm@thread.v2" });
  });

  it.each([
    undefined,
    {},
    { details: {} },
    { details: { result: {} } },
    { details: { result: { receipt: { raw: [{}] } } } },
  ])("rejects a result without an authoritative conversation id", (result) => {
    expect(
      requireMSTeamsExtractToolSendResult()({
        result,
        send: { to: "team-aad/19:channel@thread.tacv2", threadId: "thread-root" },
      }),
    ).toBeNull();
  });
});

describe("msteamsPlugin.threading.resolveAutoThreadId", () => {
  function resolveAutoThreadId(params: {
    cfg?: OpenClawConfig;
    accountId?: string;
    to?: string;
    currentGraphChannelId?: string;
  }) {
    const resolve = msteamsPlugin.threading?.resolveAutoThreadId;
    if (!resolve) {
      throw new Error("msteams threading.resolveAutoThreadId unavailable");
    }
    return resolve({
      cfg: params.cfg ?? ({} as OpenClawConfig),
      accountId: params.accountId,
      to: params.to ?? "conversation:19:channel@thread.tacv2",
      toolContext: {
        currentChannelId: "conversation:19:channel@thread.tacv2",
        currentMessagingTarget: params.currentGraphChannelId,
        currentGraphChannelId: params.currentGraphChannelId,
        currentThreadTs: "thread-root",
        replyToMode: "all",
      },
    });
  }

  it("returns ambient thread root for same conversation target", () => {
    expect(resolveAutoThreadId({})).toBe("thread-root");
  });

  it("returns undefined for a global top-level reply style", () => {
    expect(
      resolveAutoThreadId({
        cfg: { channels: { msteams: { replyStyle: "top-level" } } } as OpenClawConfig,
      }),
    ).toBeUndefined();
  });

  it("honors a named account top-level reply style", () => {
    expect(
      resolveAutoThreadId({
        accountId: "ops",
        cfg: {
          channels: {
            msteams: {
              replyStyle: "thread",
              accounts: { ops: { replyStyle: "top-level" } },
            },
          },
        } as OpenClawConfig,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when requireMention defaults the reply style to top-level", () => {
    expect(
      resolveAutoThreadId({
        cfg: { channels: { msteams: { requireMention: false } } } as OpenClawConfig,
      }),
    ).toBeUndefined();
  });

  it("honors team and channel reply style overrides", () => {
    const cfg = {
      channels: {
        msteams: {
          replyStyle: "thread",
          teams: {
            "team-1": {
              replyStyle: "top-level",
              channels: { "19:channel@thread.tacv2": { replyStyle: "thread" } },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveAutoThreadId({ cfg, currentGraphChannelId: "team-1/19:other@thread.tacv2" }),
    ).toBeUndefined();
    expect(
      resolveAutoThreadId({ cfg, currentGraphChannelId: "team-1/19:channel@thread.tacv2" }),
    ).toBe("thread-root");
  });

  it("preserves an explicit thread target under top-level reply style", () => {
    expect(
      resolveAutoThreadId({
        cfg: { channels: { msteams: { replyStyle: "top-level" } } } as OpenClawConfig,
        to: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      }),
    ).toBe("explicit-root");
  });

  it("returns undefined for a different conversation", () => {
    const resolve = msteamsPlugin.threading?.resolveAutoThreadId;
    if (!resolve) {
      throw new Error("msteams threading.resolveAutoThreadId unavailable");
    }
    expect(
      resolve({
        cfg: {} as OpenClawConfig,
        to: "conversation:19:other@thread.tacv2",
        toolContext: {
          currentChannelId: "conversation:19:channel@thread.tacv2",
          currentThreadTs: "thread-root",
          replyToMode: "all",
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for DM tool context without ambient thread", () => {
    const resolve = msteamsPlugin.threading?.resolveAutoThreadId;
    if (!resolve) {
      throw new Error("msteams threading.resolveAutoThreadId unavailable");
    }
    expect(
      resolve({
        cfg: {} as OpenClawConfig,
        to: "user:aad-user-1",
        toolContext: { currentChannelId: "user:aad-user-1" },
      }),
    ).toBeUndefined();
  });
});
