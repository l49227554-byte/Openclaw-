import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveChannelPluginRegistration } from "../channels/plugins/registry.js";
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingPreviewToolProgress,
} from "../channels/streaming.js";
import { resolveChannelConfigRecord } from "../config/channel-configured-shared.js";
import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import { resolveMessageActionOutcome } from "../infra/outbound/message-action-contracts.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { getRuntimeConfig } from "../infra/outbound/message.config.runtime.js";
import { normalizeMessageChannel } from "../utils/message-channel-normalize.js";
import type { TaskProgressMessageTarget } from "./task-progress-message.js";

// Runtime delivery seam for task terminal/state-change notifications.
export { sendMessage } from "../infra/outbound/message.js";

export function isTaskProgressEnabled(
  channel: string | undefined,
  accountId: string | undefined,
): boolean {
  if (!channel || !accountId) {
    return false;
  }
  // The registered channel owns account inheritance; do not recreate its merge policy here.
  const plugin = resolveChannelPluginRegistration(channel, { loadedOnly: true })?.plugin;
  const cfg = getRuntimeConfig();
  const account = asOptionalRecord(plugin?.config.resolveAccount(cfg, accountId));
  const root = resolveChannelConfigRecord(cfg, channel);
  // Top-level owners can return metadata only. Never merge or infer account overrides.
  const entry =
    asOptionalRecord(account?.config) ??
    (account && !("config" in account) && root?.accounts === undefined ? root : undefined);
  const streaming = { streaming: entry?.streaming };
  const mode = resolveChannelPreviewStreamMode(streaming, "off");
  return mode === "progress" && resolveChannelStreamingPreviewToolProgress(streaming, false, mode);
}

export async function editTaskProgressMessage(
  params: TaskProgressMessageTarget & {
    content: string;
    agentId?: string;
    assertCurrent: () => void;
  },
): Promise<void> {
  params.assertCurrent();
  const result = await runMessageAction({
    cfg: getRuntimeConfig(),
    action: "edit",
    params: {
      channel: params.channel,
      target: params.to,
      accountId: params.accountId,
      threadId: params.threadId,
      messageId: params.messageId,
      message: params.content,
    },
    agentId: params.agentId,
    requesterAccountId: params.requesterOrigin.accountId,
    // Retained originating conversation under the live progress owner, not a new inbound turn.
    // In particular, the outgoing receipt must never become a trusted currentMessageId.
    toolContext: {
      currentChannelProvider: normalizeMessageChannel(params.requesterOrigin.channel),
      currentMessagingTarget: params.requesterOrigin.to,
      currentThreadTs:
        params.requesterOrigin.threadId === undefined
          ? undefined
          : String(params.requesterOrigin.threadId),
    },
    gatewayOwnedDelivery: true,
    suppressTranscriptMirror: true,
    assertDirectAdapterHandoff: params.assertCurrent,
  });
  const outcome = resolveMessageActionOutcome(result);
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
}

export function resolveTaskControlUiSessionUrl(params: {
  sessionKey: string;
  fallbackAgentId?: string;
}): string | undefined {
  return resolveControlUiSessionUrl(getRuntimeConfig(), { ...params, exactKey: true });
}
