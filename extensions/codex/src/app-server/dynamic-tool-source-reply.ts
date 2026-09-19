import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  type MessagingToolSend,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexDynamicToolCallParams } from "./protocol.js";

const EXPLICIT_MESSAGE_PROVIDER_KEYS = ["channel", "provider"];
const EXPLICIT_MESSAGE_TARGET_KEYS = ["target", "to", "channelId"];
const EXPLICIT_MESSAGE_THREAD_KEYS = ["threadId", "thread_id", "messageThreadId", "topicId"];
const EXPLICIT_MESSAGE_REPLY_KEYS = ["replyTo", "replyToId", "replyToIdFull"];

type CodexSourceReplyRouteContext = {
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentMessageId?: string | number;
  currentThreadId?: string;
};

function normalizeRouteToken(value: string | number | undefined): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function sourceRouteTokens(hookContext: CodexSourceReplyRouteContext | undefined): Set<string> {
  const tokens = new Set<string>();
  const currentTarget = normalizeRouteToken(hookContext?.currentMessagingTarget);
  const currentChannel = normalizeRouteToken(hookContext?.currentChannelId);
  const currentProvider = normalizeRouteToken(hookContext?.currentChannelProvider);
  if (currentTarget) {
    tokens.add(currentTarget);
  }
  if (currentChannel) {
    tokens.add(currentChannel);
  }
  const channelPrefixIndex = currentChannel?.indexOf(":") ?? -1;
  if (channelPrefixIndex >= 0 && currentChannel) {
    const unprefixedChannel = currentChannel.slice(channelPrefixIndex + 1);
    if (unprefixedChannel) {
      tokens.add(unprefixedChannel);
      for (const segment of unprefixedChannel.split(/[;,]/u)) {
        const token = normalizeRouteToken(segment);
        if (token) {
          tokens.add(token);
        }
      }
    }
  }
  if (currentProvider && currentChannel?.startsWith(`${currentProvider}:`)) {
    const unprefixedChannel = currentChannel.slice(currentProvider.length + 1);
    if (unprefixedChannel) {
      tokens.add(unprefixedChannel);
    }
  }
  return tokens;
}

function routeTokenMatchesSource(
  token: string | undefined,
  hookContext: CodexSourceReplyRouteContext | undefined,
): boolean {
  const normalized = normalizeRouteToken(token);
  return normalized !== undefined && sourceRouteTokens(hookContext).has(normalized);
}

function routeProviderMatchesSource(
  provider: string | undefined,
  hookContext: CodexSourceReplyRouteContext | undefined,
): boolean {
  const normalized = normalizeRouteToken(provider);
  if (!normalized) {
    return false;
  }
  const currentProvider = normalizeRouteToken(hookContext?.currentChannelProvider);
  const currentChannel = normalizeRouteToken(hookContext?.currentChannelId);
  return currentProvider === normalized || currentChannel?.startsWith(`${normalized}:`) === true;
}

function routeTokenMatchesCurrentMessage(
  token: string | number | undefined,
  hookContext: CodexSourceReplyRouteContext | undefined,
): boolean {
  const normalized = normalizeRouteToken(token);
  return (
    normalized !== undefined && normalized === normalizeRouteToken(hookContext?.currentMessageId)
  );
}

function readRouteToken(record: Record<string, unknown>, key: string): string | number | undefined {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function explicitRouteTokensMismatchCurrent(
  args: Record<string, unknown>,
  keys: readonly string[],
  currentToken: string | number | undefined,
): boolean {
  const normalizedCurrent = normalizeRouteToken(currentToken);
  if (!normalizedCurrent) {
    return false;
  }
  return keys.some((key) => {
    const normalized = normalizeRouteToken(readRouteToken(args, key));
    return normalized !== undefined && normalized !== normalizedCurrent;
  });
}

function explicitThreadRouteTargetsNonSource(
  args: Record<string, unknown>,
  hookContext: CodexSourceReplyRouteContext | undefined,
  messagingTarget: MessagingToolSend | undefined,
): boolean {
  const normalizedCurrentThread = normalizeRouteToken(hookContext?.currentThreadId);
  const explicitThreadTokens = [
    ...EXPLICIT_MESSAGE_THREAD_KEYS.map((key) => normalizeRouteToken(readRouteToken(args, key))),
    normalizeRouteToken(messagingTarget?.threadId),
  ].filter((value): value is string => value !== undefined);

  if (explicitThreadTokens.length === 0) {
    return false;
  }
  return (
    normalizedCurrentThread === undefined ||
    explicitThreadTokens.some((value) => value !== normalizedCurrentThread)
  );
}

function replyReceiptMatchesCurrentMessage(
  value: unknown,
  hookContext: CodexSourceReplyRouteContext | undefined,
  depth = 0,
): boolean {
  if (depth > 4 || value === null) {
    return false;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || !["{", "["].includes(trimmed[0] ?? "")) {
      return false;
    }
    try {
      return replyReceiptMatchesCurrentMessage(JSON.parse(trimmed), hookContext, depth + 1);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => replyReceiptMatchesCurrentMessage(item, hookContext, depth + 1));
  }
  const record = asOptionalRecord(value);
  if (!record) {
    return false;
  }
  for (const key of ["repliedTo", "replyTo", "replyToId", "replyToIdFull"]) {
    if (
      routeTokenMatchesCurrentMessage(
        typeof record[key] === "string" ? record[key] : undefined,
        hookContext,
      )
    ) {
      return true;
    }
  }
  for (const key of [
    "content",
    "details",
    "payload",
    "receipt",
    "result",
    "results",
    "sendResult",
    "text",
  ]) {
    if (replyReceiptMatchesCurrentMessage(record[key], hookContext, depth + 1)) {
      return true;
    }
  }
  return false;
}

function hasExplicitNonSourceMessageRoute(
  args: Record<string, unknown>,
  hookContext: CodexSourceReplyRouteContext | undefined,
  messagingTarget: MessagingToolSend | undefined,
): boolean {
  const currentProvider = normalizeRouteToken(hookContext?.currentChannelProvider);
  for (const key of EXPLICIT_MESSAGE_PROVIDER_KEYS) {
    const provider = normalizeRouteToken(typeof args[key] === "string" ? args[key] : undefined);
    if (
      provider &&
      currentProvider !== provider &&
      !routeProviderMatchesSource(provider, hookContext)
    ) {
      return true;
    }
  }
  const targetValues = [
    ...EXPLICIT_MESSAGE_TARGET_KEYS.map((key) =>
      typeof args[key] === "string" ? args[key] : undefined,
    ),
    ...(Array.isArray(args.targets)
      ? args.targets.map((value) => (typeof value === "string" ? value : undefined))
      : []),
  ].filter((value): value is string => normalizeRouteToken(value) !== undefined);
  if (explicitThreadRouteTargetsNonSource(args, hookContext, messagingTarget)) {
    return true;
  }
  if (
    explicitRouteTokensMismatchCurrent(
      args,
      EXPLICIT_MESSAGE_REPLY_KEYS,
      hookContext?.currentMessageId,
    )
  ) {
    return true;
  }
  if (
    messagingTarget?.to !== undefined &&
    !routeTokenMatchesSource(messagingTarget.to, hookContext)
  ) {
    return true;
  }
  if (messagingTarget?.to !== undefined) {
    return false;
  }
  if (targetValues.length === 0) {
    return false;
  }
  return targetValues.some((value) => !routeTokenMatchesSource(value, hookContext));
}

export function canProduceFinalSourceReplyDelivery(call: CodexDynamicToolCallParams): boolean {
  // before_tool_call may rewrite finality, so the original arguments cannot
  // safely narrow which message calls can produce an authoritative receipt.
  return call.tool === "message";
}

export function confirmsMessageToolSourceReply(params: {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  hookResult: unknown;
  isError: boolean;
  hookContext?: CodexSourceReplyRouteContext;
  messagingTarget?: MessagingToolSend;
  allowToolTermination?: boolean;
}): boolean {
  if (
    params.hookContext?.sourceReplyDeliveryMode !== "message_tool_only" ||
    params.toolName !== "message"
  ) {
    return false;
  }
  const blocksSourceReply = hasExplicitNonSourceMessageRoute(
    params.args,
    params.hookContext,
    params.messagingTarget,
  );
  const deliveredSourceReply = isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.hookContext.sourceReplyDeliveryMode,
    toolName: params.toolName,
    args: params.args,
    result: params.result,
    hookResult: params.hookResult,
    isError: params.isError,
    allowExplicitSourceRoute: !blocksSourceReply,
  });
  const receiptConfirmedSourceReply =
    normalizeRouteToken(typeof params.args.action === "string" ? params.args.action : undefined) ===
      "reply" &&
    !params.isError &&
    !blocksSourceReply &&
    isDeliveredMessagingToolResult(params) &&
    (replyReceiptMatchesCurrentMessage(params.result, params.hookContext) ||
      replyReceiptMatchesCurrentMessage(params.hookResult, params.hookContext));
  const resultRecord = asOptionalRecord(params.result);
  const hookResultRecord = asOptionalRecord(params.hookResult);
  const toolConfirmedSourceReply =
    params.allowToolTermination === true &&
    !params.isError &&
    (resultRecord?.terminate === true || hookResultRecord?.terminate === true);
  return deliveredSourceReply || receiptConfirmedSourceReply || toolConfirmedSourceReply;
}
