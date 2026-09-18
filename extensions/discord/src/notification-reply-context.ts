// Discord plugin module remembers host notifications so replies to them keep the quoted text.
import { listMessageReceiptPlatformIds } from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveDiscordAccount } from "./accounts.js";
import { getOptionalDiscordRuntime } from "./runtime.js";

const DISCORD_NOTIFICATION_REPLY_CONTEXT_NAMESPACE = "notification-reply-context";
const DISCORD_NOTIFICATION_REPLY_CONTEXT_MAX_ENTRIES = 10_000;

type DiscordDeliveryResults = Parameters<
  NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>
>[0]["results"];

const reportNotificationReplyContextError = createPluginStateErrorReporter(
  getOptionalDiscordRuntime,
  "discord",
  "notification-reply-context",
  "Discord notification reply context state failed",
);

function openDiscordNotificationReplyContextStore() {
  return getOptionalDiscordRuntime()?.state.openKeyedStore<true>({
    namespace: DISCORD_NOTIFICATION_REPLY_CONTEXT_NAMESPACE,
    maxEntries: DISCORD_NOTIFICATION_REPLY_CONTEXT_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
  });
}

function resolveNotificationReplyContextKey(
  accountId: string | null | undefined,
  messageId: string,
) {
  return `${normalizeAccountId(accountId)}:${messageId}`;
}

/** Records every platform message that carried a host notification payload. */
export async function recordDiscordNotificationReplyContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  results: DiscordDeliveryResults;
}): Promise<void> {
  const messageIds = new Set<string>();
  for (const result of params.results) {
    if (result.channel !== "discord" || result.outcome === "not_sent") {
      continue;
    }
    if (result.messageId) {
      messageIds.add(result.messageId);
    }
    // Chunked sends split one notification across several Discord messages.
    for (const platformMessageId of result.receipt
      ? listMessageReceiptPlatformIds(result.receipt)
      : []) {
      messageIds.add(platformMessageId);
    }
  }
  if (messageIds.size === 0) {
    return;
  }
  try {
    // Key by the resolved account so default-account sends match the monitor's account id.
    const { accountId } = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
    const store = openDiscordNotificationReplyContextStore();
    for (const messageId of messageIds) {
      await store?.register(resolveNotificationReplyContextKey(accountId, messageId), true);
    }
  } catch (error) {
    reportNotificationReplyContextError(error);
  }
}

/** Unknown or unreadable provenance keeps the default self-quote suppression. */
export async function isDiscordNotificationReplyTarget(params: {
  accountId?: string | null;
  messageId: string;
}): Promise<boolean> {
  try {
    const store = openDiscordNotificationReplyContextStore();
    return (
      (await store?.lookup(
        resolveNotificationReplyContextKey(params.accountId, params.messageId),
      )) === true
    );
  } catch (error) {
    reportNotificationReplyContextError(error);
    return false;
  }
}
