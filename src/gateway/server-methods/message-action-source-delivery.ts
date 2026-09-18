import type { MessageActionParams } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  beginTerminalSourceReplyDelivery,
  isExactCurrentSourceConversation,
} from "../../infra/outbound/source-reply-mirror.js";
import type { resolveTrustedMessageActionToolContext } from "./message-action-context.js";

/** Prepares source receipts and the one allowed live-run-to-queue handoff. */
export async function prepareMessageActionSourceReply(params: {
  request: MessageActionParams;
  trustedContext: Extract<ReturnType<typeof resolveTrustedMessageActionToolContext>, { ok: true }>;
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId?: string;
  sessionKey?: string;
  canonicalAction: boolean;
  assertDirectAdapterHandoff?: () => void;
}) {
  const { request, trustedContext, agentId } = params;
  const mirror = {
    action: request.action,
    channel: params.channel,
    actionParams: request.params,
    cfg: params.cfg,
    accountId: params.accountId,
    currentAccountId: trustedContext.requesterAccountId,
    sessionKey: trustedContext.sourceReplySessionKey ?? params.sessionKey,
    sessionId: trustedContext.sessionId,
    agentId,
    toolContext: trustedContext.toolContext,
    replyToIsExplicit: request.reply?.source === "explicit",
    idempotencyKey: request.idempotencyKey,
    toolCallId: trustedContext.sourceReplyToolCallId,
    ...(trustedContext.sourceReplyFinal !== undefined
      ? { sourceReplyFinal: trustedContext.sourceReplyFinal }
      : {}),
  };
  const terminalStart =
    trustedContext.sourceReplyFinal === true
      ? await beginTerminalSourceReplyDelivery(mirror)
      : undefined;
  const receipt = terminalStart && !("outcome" in terminalStart) ? terminalStart : undefined;
  // Only a terminal canonical send to the exact admitted source may outlive
  // its tool call. Native actions and other targets retain ephemeral authority.
  if (
    !params.canonicalAction ||
    request.action !== "send" ||
    trustedContext.runtimeAgentId === undefined ||
    !receipt ||
    !isExactCurrentSourceConversation(mirror)
  ) {
    return { mirror, terminalStart, handoff: undefined };
  }
  const deliveryAbort = new AbortController();
  const assertDeliveryAuthority = () => {
    try {
      params.assertDirectAdapterHandoff?.();
    } catch (error) {
      // If custody was admitted but dispatch has not begun, cancellation
      // retires the existing queue ownership before recovery can send.
      deliveryAbort.abort(error);
      throw error;
    }
  };
  return {
    mirror,
    terminalStart,
    handoff: {
      actionContext: {
        onPlatformSendDispatch: async () => assertDeliveryAuthority(),
        assertDirectAdapterHandoff: assertDeliveryAuthority,
        abortSignal: deliveryAbort.signal,
        skipQueue: false,
      },
      deliveryContext: {
        requireQueuePersistence: true,
        deliveryIntentId: `source-reply:${receipt.sessionId}:${receipt.sourceTurnId}`,
        transcriptMirror: {
          sessionKey: receipt.sessionKey,
          expectedSessionId: receipt.sessionId,
          agentId,
          idempotencyKey: `${request.idempotencyKey}:terminal-receipt:${receipt.sourceTurnId}`,
          deliveryMirror: {
            kind: "message-tool-source-reply" as const,
            final: true,
            toolCallId: receipt.toolCallId,
            sourceTurnId: receipt.sourceTurnId,
          },
        },
      },
    },
  };
}
