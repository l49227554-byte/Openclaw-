import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import type { MessageActionResult, ResolvedActionContext } from "./message-action-contracts.js";
import { annotateSourceDelivery } from "./message-action-execution.js";
import { runMessageAction } from "./message-action-runner.js";

const channel = "accepted-results";
const toolContext = {
  currentChannelProvider: channel,
  currentChannelId: "room-1",
  currentThreadTs: "thread-1",
};
const authorization = { requesterAccountId: "default", toolContext };
const sessionKey = `agent:main:${channel}:direct:room-1`;
const acceptedPayload = { ok: true, messageId: "accepted-1" };
const closed = new Error("delivery caller closed");

function registerPlugin(overrides: Partial<ChannelPlugin> = {}): ChannelPlugin {
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: channel }),
    messaging: { targetResolver: { looksLikeId: () => true } },
    outbound: {
      deliveryMode: "direct",
      sendText: async () => {
        throw new Error("expected native action dispatch");
      },
    },
    ...overrides,
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: channel, plugin, source: "test", origin: "bundled" }]),
  );
  return plugin;
}

describe("accepted results through registered message actions", () => {
  let tempHome: TempHomeEnv;
  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-accepted-results-");
  });
  afterEach(() => resetPluginRuntimeStateForTest());
  afterAll(async () => tempHome.restore());

  it.each(["plugin", "core"] as const)(
    "retains an accepted %s send when its caller closes before annotation",
    async (mode) => {
      let active = true;
      const submitted: string[] = [];
      const onPlatformSendDispatch = vi.fn(async () => {});
      const assertCurrent = () => {
        if (!active) {
          throw closed;
        }
      };
      const plugin = registerPlugin(
        mode === "plugin"
          ? {
              actions: {
                describeMessageTool: () => ({ actions: ["send"] }),
                handleAction: async (ctx) => {
                  ctx.assertDirectAdapterHandoff?.();
                  await ctx.onPlatformSendDispatch?.();
                  submitted.push("accepted-1");
                  active = false;
                  return jsonResult(acceptedPayload);
                },
              },
            }
          : {
              outbound: {
                deliveryMode: "direct",
                sendText: async (ctx) => {
                  ctx.assertDirectAdapterHandoff?.();
                  await ctx.onPlatformSendDispatch?.();
                  submitted.push("accepted-1");
                  active = false;
                  return { channel, messageId: "accepted-1" };
                },
              },
            },
      );

      const result = await runMessageAction({
        cfg: {},
        action: "send",
        params: { channel: plugin.id, target: "room-1", message: "accepted reply" },
        messageActionAuthorization: authorization,
        sessionKey,
        defaultAccountId: "default",
        assertDirectAdapterHandoff: assertCurrent,
        onPlatformSendDispatch,
        skipQueue: true,
        suppressTranscriptMirror: true,
      });

      expect(result).toMatchObject({ kind: "send", handledBy: mode, dryRun: false });
      expect(submitted).toEqual(["accepted-1"]);
      expect(result.payload).not.toHaveProperty("sourceReplyRoute");
      if (result.kind !== "send") {
        throw new Error("Expected send result");
      }
      if (mode === "plugin") {
        expect(result.payload).toBe(acceptedPayload);
        expect(result.toolResult?.details).toBe(acceptedPayload);
      } else {
        expect(result.sendResult).toMatchObject({
          deliveryStatus: "sent",
          result: { messageId: "accepted-1" },
        });
      }
    },
  );

  it.each([
    "before lookup",
    "during lookup",
    "lookup failure",
    "current",
    "aborted before lookup",
    "aborted during lookup",
  ] as const)("preserves an accepted thread reply (%s)", async (scenario) => {
    let active = true;
    const caller = new AbortController();
    const matchesCurrentConversationAsync = vi.fn(async () => {
      if (scenario === "lookup failure") {
        throw new Error("source lookup unavailable");
      }
      if (scenario === "during lookup") {
        active = false;
      }
      if (scenario === "aborted during lookup") {
        caller.abort(closed);
      }
      return true;
    });
    const handleAction = vi.fn(async () => {
      if (scenario === "before lookup") {
        active = false;
      }
      if (scenario === "aborted before lookup") {
        caller.abort(closed);
      }
      return jsonResult(acceptedPayload);
    });
    registerPlugin({
      actions: {
        describeMessageTool: () => ({ actions: ["thread-reply"] }),
        messageActionTargetAliases: {
          "thread-reply": { aliases: ["threadId"], matchesCurrentConversationAsync },
        },
        handleAction,
      },
    });

    const result = await runMessageAction({
      cfg: {},
      action: "thread-reply",
      params: { channel, target: "room-1", threadId: "thread-1", message: "accepted reply" },
      conversationReadOrigin: "direct-operator",
      messageActionAuthorization: authorization,
      sessionKey,
      defaultAccountId: "default",
      abortSignal: caller.signal,
      assertDirectAdapterHandoff: scenario.startsWith("aborted")
        ? undefined
        : () => {
            if (!active) {
              throw closed;
            }
          },
    });

    expect(handleAction).toHaveBeenCalledOnce();
    expect(matchesCurrentConversationAsync).toHaveBeenCalledTimes(
      scenario === "before lookup" || scenario === "aborted before lookup" ? 0 : 1,
    );
    if (scenario === "current") {
      expect(result.payload).toMatchObject({
        ...acceptedPayload,
        sourceReplyRoute: "current-source",
      });
    } else {
      expect(result.payload).toBe(acceptedPayload);
      expect(result).toHaveProperty("toolResult.details", acceptedPayload);
      expect(result.payload).not.toHaveProperty("sourceReplyRoute");
    }
  });

  it.each([
    { name: "unidentified", payload: {} },
    { name: "unconfirmed ID", payload: { messageId: "unconfirmed-1" } },
    { name: "unknown ID", payload: { ok: true, messageId: "unknown" } },
    { name: "rejected with an ID", payload: { ok: false, messageId: "rejected-1" } },
    {
      name: "nested rejection",
      payload: { ok: true, result: { ok: false, messageId: "rejected-1" } },
    },
    {
      name: "nested error",
      payload: { ok: true, result: { error: "rejected", messageId: "rejected-1" } },
    },
    {
      name: "error status",
      payload: { ok: true, result: { status: "error", messageId: "rejected-1" } },
    },
    {
      name: "incomplete status",
      payload: { ok: true, result: { status: "incomplete", messageId: "part-1" } },
    },
    {
      name: "partial delivery",
      payload: {
        ok: false,
        sentBeforeError: true,
        messageId: "part-1",
        error: "second part failed",
      },
    },
    {
      name: "partial status",
      payload: { ok: true, deliveryStatus: "partial_failed", messageId: "part-1" },
    },
    { name: "tool error", payload: acceptedPayload, toolError: true },
    {
      name: "conflicting error status",
      payload: { ...acceptedPayload, deliveryStatus: "sent", status: "error" },
    },
    {
      name: "conflicting incomplete status",
      payload: { ...acceptedPayload, deliveryStatus: "sent", status: "incomplete" },
    },
    {
      name: "conflicting failed status",
      payload: { ...acceptedPayload, deliveryStatus: "sent", status: "failed" },
    },
    { name: "tool failure status", payload: acceptedPayload, toolStatus: "failed" },
    { name: "tool partial status", payload: acceptedPayload, toolStatus: "partial_failed" },
    { name: "tool partial delivery", payload: acceptedPayload, toolPartial: true },
    { name: "tool dry run", payload: acceptedPayload, toolDryRun: true },
    { name: "dry run", payload: acceptedPayload, dryRun: true },
    { name: "read", payload: acceptedPayload, action: "read" as const },
  ])("keeps $name strict when annotation loses authority", async (testCase) => {
    const plugin = registerPlugin();
    const result: MessageActionResult = {
      ...(testCase.action === "read"
        ? { kind: "action", action: "read" }
        : { kind: "send", action: "send", to: "room-1" }),
      channel,
      handledBy: "plugin",
      payload: testCase.payload,
      toolResult: {
        ...jsonResult(testCase.payload),
        ...(testCase.toolError ? { isError: true } : {}),
        ...(testCase.toolStatus ? { status: testCase.toolStatus } : {}),
        ...(testCase.toolPartial ? { sentBeforeError: true } : {}),
        ...(testCase.toolDryRun ? { dryRun: true } : {}),
      },
      dryRun: testCase.dryRun ?? false,
    };
    const ctx: ResolvedActionContext = {
      cfg: {},
      params: { to: "room-1" },
      channel,
      channelPlugin: plugin,
      mediaAccess: { localRoots: [] },
      dryRun: result.dryRun,
      input: {
        cfg: {},
        action: result.action,
        params: {},
        messageActionAuthorization: authorization,
        assertDirectAdapterHandoff: () => {
          throw closed;
        },
      },
    };

    await expect(annotateSourceDelivery(result, ctx, false)).rejects.toBe(closed);
    expect(result.payload).toBe(testCase.payload);
    expect(result.payload).not.toHaveProperty("sourceReplyRoute");
  });
});
