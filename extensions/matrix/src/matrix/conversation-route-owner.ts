import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { listMatrixAccountIds, resolveMatrixAccountConfig } from "./accounts.js";
import { resolveMatrixInboundRoute } from "./monitor/route.js";

export function resolveMatrixConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    threadId?: string;
    nativeChannelId?: string;
  };
}) {
  const { cfg, conversation } = params;
  const roomId =
    conversation.nativeChannelId?.trim() ||
    (conversation.kind === "direct" ? "" : conversation.peerId.trim());
  if (!roomId) {
    return null;
  }
  const accountId = normalizeAccountId(params.accountId);
  const accountConfig = resolveMatrixAccountConfig({ cfg, accountId });
  // A removed or disabled account can never regain a binding owner, so reject its retained
  // history here instead of reporting the missing adapter as a temporary outage below.
  if (
    cfg.channels?.matrix?.enabled === false ||
    !listMatrixAccountIds(cfg).some((id) => normalizeAccountId(id) === accountId) ||
    accountConfig.enabled === false
  ) {
    return null;
  }
  const isDirectMessage = conversation.kind === "direct";
  const result = resolveMatrixInboundRoute({
    cfg,
    accountId,
    roomId,
    senderId: conversation.peerId,
    isDirectMessage,
    threadId: conversation.threadId,
    resolveAgentRoute,
  });
  if (!result.bindingOwnerAvailable) {
    return { kind: "unavailable" as const };
  }
  if (result.pluginId) {
    return {
      kind: "plugin" as const,
      pluginId: result.pluginId,
      fallbackAgentId: result.route.agentId,
    };
  }
  return { kind: "agent" as const, agentId: result.route.agentId };
}
