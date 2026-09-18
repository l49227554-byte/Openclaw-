import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { recoverPendingDeliveries } from "../../infra/outbound/delivery-queue-recovery.js";
import {
  createRecoveryLog,
  loadPendingDeliveries,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import { acceptedPreparedOutboundEntries } from "../../infra/outbound/prepared-batch.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sendHandlers } from "./send.js";
import type { GatewayRequestContext } from "./types.js";

const sessionKey = "agent:main:twitch:group:room";

afterEach(() => resetPluginRuntimeStateForTest());

describe("final message-tool source reply recovery", () => {
  it.each([
    "not-sent",
    "ambiguous",
    "cancelled",
    "progress",
    "other-target",
    "other-account",
    "other-thread",
  ] as const)("keeps final source custody and recovery fenced for %s", async (mode) => {
    await withOpenClawTestState({ prefix: "source-tool-recovery-" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const cfg = { session: { store: storePath } };
      let online = false;
      let active = true;
      const delivered: string[] = [];
      const sendText = vi.fn(async ({ text }: { text: string }) => {
        if (!online && mode === "ambiguous") {
          throw new Error("ambiguous provider timeout");
        }
        if (!online) {
          throw new PlatformMessageNotDispatchedError("synthetic rate limit", {
            cause: new Error("provider refused"),
          });
        }
        delivered.push(text);
        return { channel: "twitch", messageId: `message-${delivered.length}` };
      });
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({
          id: "twitch",
          config: {
            listAccountIds: () => ["default", "secondary"],
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
        }),
        actions: { describeMessageTool: () => ({ actions: ["send"] }) },
        messaging: { targetResolver: { looksLikeId: () => true, hint: "<room>" } },
        outbound: { deliveryMode: "direct" },
        message: {
          send: {
            text: async (ctx) => {
              const result = await sendText(ctx);
              return {
                ...result,
                receipt: { platformMessageIds: [result.messageId], parts: [], sentAt: Date.now() },
              };
            },
            lifecycle: {
              beforeSendAttempt: async () => {
                if (mode === "cancelled") {
                  active = false;
                }
              },
            },
          },
        },
      };
      setActivePluginRegistry(createTestRegistry([{ pluginId: "twitch", source: "test", plugin }]));
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          sessionId: "source-session",
          status: "running",
          restartRecoveryDeliveryRunId: "live-run",
          restartRecoveryDeliverySourceRunId: "source-turn",
          updatedAt: Date.now(),
        },
      );
      const context = {
        dedupe: new Map(),
        getRuntimeConfig: () => cfg,
        validateAgentRuntimeApprovalAuthority: () => active,
      } as unknown as GatewayRequestContext;
      const invoke = async (toolCallId: string) => {
        const respond = vi.fn();
        await sendHandlers["message.action"]!({
          params: {
            channel: "twitch",
            action: "send",
            ...(mode === "other-account" ? { accountId: "secondary" } : {}),
            params: {
              to: mode === "other-target" ? "other-room" : "room",
              message: "original final reply",
              // The upstream message-tool-only route defaults source sends to
              // best effort before the Gateway admits terminal custody.
              bestEffort: true,
              ...(mode === "other-thread" ? { threadId: "other-thread" } : {}),
            },
            sessionKey,
            sessionId: "source-session",
            idempotencyKey: toolCallId,
          },
          client: {
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                sessionKey,
                messageActionContext: {
                  expiresAtMs: Date.now() + 60_000,
                  sessionId: "source-session",
                  requesterAccountId: "default",
                  sourceReplyFinal: mode !== "progress",
                  sourceReplyToolCallId: toolCallId,
                  toolContext: {
                    currentChannelProvider: "twitch",
                    currentChannelId: "room",
                    currentSourceTurnId: "source-turn",
                    ...(mode === "other-thread" ? { currentThreadTs: "source-thread" } : {}),
                  },
                },
              },
            },
          } as never,
          respond,
          context,
          req: { type: "req", id: toolCallId, method: "message.action" },
          isWebchatConnect: () => false,
        });
        return respond.mock.calls[0];
      };
      const failed = await invoke("first-tool-call");
      if (["progress", "other-target", "other-account", "other-thread"].includes(mode)) {
        // Ordinary best-effort sends return their failed attempt to the caller.
        expect(failed?.[0]).toBe(true);
        expect(failed?.[1]).toMatchObject({ deliveryStatus: "failed" });
        expect(failed?.[2]?.details).toBeUndefined();
        expect(await loadPendingDeliveries(state.stateDir)).toEqual([]);
        return;
      }
      if (mode === "cancelled") {
        expect(failed?.[2]?.message).toContain("authority is no longer active");
        expect(sendText).not.toHaveBeenCalled();
      } else {
        expect(failed?.[2]?.details).toEqual({
          code: GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED,
        });
      }
      const queued = await loadPendingDeliveries(state.stateDir);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.queuePolicy).toBe("required");
      expect(
        acceptedPreparedOutboundEntries(queued[0]!.preparedBatch).map(
          ({ payload }) => payload.text,
        ),
      ).toEqual(["original final reply"]);
      expect(queued[0]?.mirror).toMatchObject({
        expectedSessionId: "source-session",
        deliveryMirror: { final: true, sourceTurnId: "source-turn" },
      });
      if (mode !== "cancelled") {
        const repeated = await invoke("new-tool-call");
        expect(repeated?.[1]).toMatchObject({ status: "delivery_ambiguous", delivered: false });
        expect(sendText).toHaveBeenCalledOnce();
        expect(await loadPendingDeliveries(state.stateDir)).toHaveLength(1);
      }
      active = false;
      online = true;
      const log = createRecoveryLog();
      const recover = () =>
        recoverPendingDeliveries({
          cfg,
          deliver: deliverOutboundPayloads,
          log,
          stateDir: state.stateDir,
        });
      // The real recovery owner observes backoff; advance its clock, not queue state.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      try {
        const firstRecovery = await recover();
        const secondRecovery = await recover();
        expect(firstRecovery.recovered).toBe(mode === "not-sent" ? 1 : 0);
        expect(secondRecovery.recovered).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
      expect(delivered).toEqual(mode === "not-sent" ? ["original final reply"] : []);
      expect(sendText).toHaveBeenCalledTimes(
        mode === "not-sent" ? 2 : mode === "cancelled" ? 0 : 1,
      );
      expect(await loadPendingDeliveries(state.stateDir)).toEqual([]);
    });
  });
});
