// Telegram plugin module implements action runtime behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  jsonResult,
  readPositiveIntegerParam,
  readReactionParams,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
  resolvePollMaxSelections,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import {
  createTelegramActionGate,
  resolveDefaultTelegramAccountId,
  resolveTelegramPollActionGateState,
} from "./accounts.js";
import { handleTelegramEditMessageAction } from "./action-runtime-edit.js";
import {
  readTelegramChatId,
  readTelegramReplyToMessageId,
  readTelegramThreadId,
} from "./action-runtime-message.js";
import { handleTelegramSendMessageAction } from "./action-runtime-send.js";
import type { TelegramActionOptions } from "./action-runtime.types.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";
import {
  resolveTelegramConversationReadChatId,
  resolveTelegramMessageMutationChatId,
} from "./message-topic-binding.js";
import { rejectTelegramNativeButtonParams } from "./native-button-params.js";
import { resolveTelegramPollVisibility } from "./poll-visibility.js";
import { resolveTelegramReactionLevel } from "./reaction-level.js";
import {
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  getTelegramAllowedReactions,
  pinMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
} from "./send.js";
import { TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST } from "./status-reaction-variants.js";
import { getCacheStats, searchStickers } from "./sticker-cache.js";
import { parseTelegramTarget } from "./targets.js";
import { resolveTelegramToken } from "./token.js";
import { resolveTopicNameCacheScope, updateTopicName } from "./topic-name-cache.js";

export const telegramActionRuntime = {
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  getTelegramAllowedReactions,
  getCacheStats,
  pinMessageTelegram,
  reactMessageTelegram,
  searchStickers,
  sendDurableMessageBatch,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
};

const TELEGRAM_FORUM_TOPIC_ICON_COLORS = [
  0x6fb9f0, 0xffd67e, 0xcb86db, 0x8eee98, 0xff93b2, 0xfb6f5f,
] as const;
const TELEGRAM_EMOJI_LIST_LIMIT = 100;
const TELEGRAM_REACTION_HINT_LIMIT = 20;
const TELEGRAM_ACTION_ALIASES = {
  createForumTopic: "createForumTopic",
  delete: "deleteMessage",
  deleteMessage: "deleteMessage",
  edit: "editMessage",
  editForumTopic: "editForumTopic",
  editMessage: "editMessage",
  "emoji-list": "emoji-list",
  poll: "poll",
  react: "react",
  searchSticker: "searchSticker",
  send: "sendMessage",
  sendMessage: "sendMessage",
  sendSticker: "sendSticker",
  sticker: "sendSticker",
  stickerCacheStats: "stickerCacheStats",
  "sticker-search": "searchSticker",
  "topic-create": "createForumTopic",
  "topic-edit": "editForumTopic",
} as const;

type TelegramActionName = (typeof TELEGRAM_ACTION_ALIASES)[keyof typeof TELEGRAM_ACTION_ALIASES];
type TelegramForumTopicIconColor = (typeof TELEGRAM_FORUM_TOPIC_ICON_COLORS)[number];

function readTelegramForumTopicIconColor(
  params: Record<string, unknown>,
): TelegramForumTopicIconColor | undefined {
  const iconColor = readPositiveIntegerParam(params, "iconColor", {
    message: "iconColor must be one of Telegram's supported forum topic colors.",
  });
  if (iconColor == null) {
    return undefined;
  }
  if (!TELEGRAM_FORUM_TOPIC_ICON_COLORS.includes(iconColor as TelegramForumTopicIconColor)) {
    throw new Error("iconColor must be one of Telegram's supported forum topic colors.");
  }
  return iconColor as TelegramForumTopicIconColor;
}
function normalizeTelegramActionName(action: string): TelegramActionName {
  const normalized = TELEGRAM_ACTION_ALIASES[action as keyof typeof TELEGRAM_ACTION_ALIASES];
  if (!normalized) {
    throw new Error(`Unsupported Telegram action: ${action}`);
  }
  return normalized;
}

function resolveActionTopicNameCacheScope(cfg: OpenClawConfig, accountId?: string | null): string {
  const resolvedAccountId = accountId ?? resolveDefaultTelegramAccountId(cfg);
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId: resolvedAccountId }),
  });
  return resolveTopicNameCacheScope(storePath);
}

function formatTelegramDeliveryTarget(to: string, messageThreadId?: number | null): string {
  const parsed = parseTelegramTarget(to);
  const directTopicId = parsed.directMessagesTopicId;
  if (directTopicId != null) {
    return `${parsed.chatId}:direct-topic:${directTopicId}`;
  }
  const topicId = messageThreadId ?? parsed.messageThreadId;
  if (topicId == null) {
    return to;
  }
  return `${parsed.chatId}:topic:${topicId}`;
}

async function describeTelegramAllowedReactionSample(params: {
  chatId: string | number;
  cfg: OpenClawConfig;
  token: string;
  accountId?: string;
}): Promise<string> {
  const reactions = await telegramActionRuntime
    .getTelegramAllowedReactions(params.chatId, {
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    })
    .catch(() => undefined);
  if (reactions === undefined) {
    return "";
  }
  const allowed =
    reactions ??
    TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST.map((emoji) => ({ type: "emoji" as const, emoji }));
  // Preserve portable alternatives when Telegram returns custom reactions first.
  const emojis = allowed
    .filter((reaction) => reaction.type === "emoji")
    .slice(0, TELEGRAM_REACTION_HINT_LIMIT)
    .map((reaction) => reaction.emoji);
  const customIds = allowed
    .filter((reaction) => reaction.type === "custom_emoji")
    .slice(0, TELEGRAM_REACTION_HINT_LIMIT - emojis.length)
    .map((reaction) => reaction.custom_emoji_id);
  const customSample = customIds.length ? `numeric custom IDs ${customIds.join(", ")}` : "";
  const sample = [emojis.join(" "), customSample].filter(Boolean).join("; ");
  return sample ? ` This chat allows: ${sample}.` : "";
}

export async function handleTelegramAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  options?: TelegramActionOptions,
): Promise<AgentToolResult<unknown>> {
  rejectTelegramNativeButtonParams(params);
  const { action, accountId } = {
    action: normalizeTelegramActionName(readStringParam(params, "action", { required: true })),
    accountId: readStringParam(params, "accountId"),
  };
  const isActionEnabled = createTelegramActionGate({
    cfg,
    accountId,
  });
  const notifyVisibleOutboundSuccess = (to: string, messageThreadId?: number | null) => {
    telegramInboundEventDelivery.notify({
      sessionKey: options?.sessionKey ?? undefined,
      to: formatTelegramDeliveryTarget(to, messageThreadId),
      accountId,
      inboundEventKind: options?.inboundEventKind,
    });
  };

  if (action === "emoji-list") {
    if (!isActionEnabled("reactions")) {
      throw new Error("Telegram reactions are disabled via actions.reactions.");
    }
    const chatId = resolveTelegramConversationReadChatId({
      chatId:
        readStringOrNumberParam(params, "chatId") ??
        readStringOrNumberParam(params, "channelId") ??
        readStringOrNumberParam(params, "to"),
      cfg,
      accountId,
      context: options,
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const limit = Math.min(
      readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      }) ?? TELEGRAM_EMOJI_LIST_LIMIT,
      TELEGRAM_EMOJI_LIST_LIMIT,
    );
    const allowed = await telegramActionRuntime.getTelegramAllowedReactions(chatId, {
      cfg,
      token,
      accountId: accountId ?? undefined,
    });
    const reactions =
      allowed ??
      TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST.map((emoji) => ({ type: "emoji" as const, emoji }));
    return jsonResult({
      ok: true,
      emojis: reactions
        .slice(0, limit)
        .map((reaction) =>
          reaction.type === "emoji"
            ? { name: reaction.emoji, identifier: reaction.emoji }
            : { identifier: reaction.custom_emoji_id, type: "custom_emoji" },
        ),
      ...(allowed === null ? { note: "All standard Telegram reactions are allowed." } : {}),
    });
  }

  if (action === "react") {
    // All react failures return soft results (jsonResult with ok:false) instead
    // of throwing, because hard tool errors can trigger model re-generation
    // loops and duplicate content.
    const reactionLevelInfo = resolveTelegramReactionLevel({
      cfg,
      accountId: accountId ?? undefined,
    });
    if (!reactionLevelInfo.agentReactionsEnabled) {
      return jsonResult({
        ok: false,
        reason: "disabled",
        hint: `Telegram agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). Do not retry.`,
      });
    }
    if (!isActionEnabled("reactions")) {
      return jsonResult({
        ok: false,
        reason: "disabled",
        hint: "Telegram reactions are disabled via actions.reactions. Do not retry.",
      });
    }
    const chatId = readTelegramChatId(params);
    let explicitMessageId: number | undefined;
    try {
      explicitMessageId = readPositiveIntegerParam(params, "messageId", {
        message: "messageId must be a positive integer.",
      });
    } catch {
      return jsonResult({
        ok: false,
        reason: "missing_message_id",
        hint: "Telegram reaction requires a valid messageId (or inbound context fallback). Do not retry.",
      });
    }
    const messageId = explicitMessageId ?? resolveReactionMessageId({ args: params });
    if (typeof messageId !== "number" || !Number.isFinite(messageId) || messageId <= 0) {
      return jsonResult({
        ok: false,
        reason: "missing_message_id",
        hint: "Telegram reaction requires a valid messageId (or inbound context fallback). Do not retry.",
      });
    }
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a Telegram reaction.",
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      return jsonResult({
        ok: false,
        reason: "missing_token",
        hint: "Telegram bot token missing. Do not retry.",
      });
    }
    let reactionResult: Awaited<ReturnType<typeof telegramActionRuntime.reactMessageTelegram>>;
    let authorizedChatId: string | number = chatId ?? "";
    try {
      authorizedChatId = await resolveTelegramMessageMutationChatId({
        chatId: chatId ?? "",
        messageId,
        cfg,
        accountId,
        context: options,
      });
      reactionResult = await telegramActionRuntime.reactMessageTelegram(
        authorizedChatId,
        messageId ?? 0,
        emoji ?? "",
        {
          cfg,
          token,
          remove,
          accountId: accountId ?? undefined,
          gatewayClientScopes: options?.gatewayClientScopes,
        },
      );
    } catch (err) {
      const isInvalid = String(err).includes("REACTION_INVALID");
      return jsonResult({
        ok: false,
        reason: isInvalid ? "REACTION_INVALID" : "error",
        emoji,
        hint: isInvalid
          ? `This reaction is unavailable.${await describeTelegramAllowedReactionSample({
              chatId: authorizedChatId,
              cfg,
              token,
              accountId: accountId ?? undefined,
            })}`
          : "Reaction failed. Do not retry.",
      });
    }
    if (!reactionResult.ok) {
      const allowedHint = await describeTelegramAllowedReactionSample({
        chatId: authorizedChatId,
        cfg,
        token,
        accountId: accountId ?? undefined,
      });
      return jsonResult({
        ok: false,
        warning: `${reactionResult.warning}${allowedHint}`,
        ...(remove || isEmpty ? { removed: true } : { added: emoji }),
      });
    }
    if (!remove && !isEmpty) {
      return jsonResult({ ok: true, added: emoji });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "sendMessage") {
    if (!isActionEnabled("sendMessage")) {
      throw new Error("Telegram sendMessage is disabled.");
    }
    return handleTelegramSendMessageAction({
      actionParams: params,
      cfg,
      accountId,
      options,
      runtime: telegramActionRuntime,
      notifyVisibleOutboundSuccess,
    });
  }

  if (action === "poll") {
    const pollActionState = resolveTelegramPollActionGateState(isActionEnabled);
    if (!pollActionState.sendMessageEnabled) {
      throw new Error("Telegram sendMessage is disabled.");
    }
    if (!pollActionState.pollEnabled) {
      throw new Error("Telegram polls are disabled.");
    }
    const to = readStringParam(params, "to", { required: true });
    const question =
      readStringParam(params, "question") ??
      readStringParam(params, "pollQuestion", { required: true });
    const answers =
      readStringArrayParam(params, "answers") ??
      readStringArrayParam(params, "pollOption", { required: true });
    const allowMultiselect =
      readBooleanParam(params, "allowMultiselect") ?? readBooleanParam(params, "pollMulti");
    const durationSeconds =
      readPositiveIntegerParam(params, "durationSeconds", {
        message: "durationSeconds must be a positive integer.",
      }) ??
      readPositiveIntegerParam(params, "pollDurationSeconds", {
        message: "pollDurationSeconds must be a positive integer.",
      });
    const durationHours =
      readPositiveIntegerParam(params, "durationHours", {
        message: "durationHours must be a positive integer.",
      }) ??
      readPositiveIntegerParam(params, "pollDurationHours", {
        message: "pollDurationHours must be a positive integer.",
      });
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const isAnonymous =
      readBooleanParam(params, "isAnonymous") ??
      resolveTelegramPollVisibility({
        pollAnonymous: readBooleanParam(params, "pollAnonymous"),
        pollPublic: readBooleanParam(params, "pollPublic"),
      });
    const silent = readBooleanParam(params, "silent");
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.sendPollTelegram(
      to,
      {
        question,
        options: answers,
        maxSelections: resolvePollMaxSelections(answers.length, allowMultiselect ?? false),
        durationSeconds: durationSeconds ?? undefined,
        durationHours: durationHours ?? undefined,
      },
      {
        cfg,
        token,
        accountId: accountId ?? undefined,
        replyToMessageId: replyToMessageId ?? undefined,
        messageThreadId: messageThreadId ?? undefined,
        isAnonymous: isAnonymous ?? undefined,
        silent: silent ?? undefined,
        gatewayClientScopes: options?.gatewayClientScopes,
      },
    );
    notifyVisibleOutboundSuccess(to, messageThreadId);
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
      pollId: result.pollId,
      ...(result.pollAnswerRouting ? { pollAnswerRouting: result.pollAnswerRouting } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    });
  }

  if (action === "deleteMessage") {
    if (!isActionEnabled("deleteMessage")) {
      throw new Error("Telegram deleteMessage is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const messageId = readPositiveIntegerParam(params, "messageId", {
      message: "messageId must be a positive integer.",
    });
    if (messageId === undefined) {
      throw new Error("messageId required");
    }
    const authorizedChatId = await resolveTelegramMessageMutationChatId({
      chatId: chatId ?? "",
      messageId,
      cfg,
      accountId,
      context: options,
    });
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.deleteMessageTelegram(
      authorizedChatId,
      messageId ?? 0,
      {
        cfg,
        token,
        accountId: accountId ?? undefined,
        gatewayClientScopes: options?.gatewayClientScopes,
      },
    );
    if (!result.ok) {
      return jsonResult({ ok: false, deleted: false, warning: result.warning });
    }
    return jsonResult({ ok: true, deleted: true });
  }

  if (action === "editMessage") {
    if (!isActionEnabled("editMessage")) {
      throw new Error("Telegram editMessage is disabled.");
    }
    return handleTelegramEditMessageAction({
      actionParams: params,
      cfg,
      accountId,
      options,
      runtime: telegramActionRuntime,
    });
  }

  if (action === "sendSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(
        "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
      );
    }
    const to =
      readStringParam(params, "to") ?? readStringParam(params, "target", { required: true });
    const fileId =
      readStringParam(params, "fileId") ?? readStringArrayParam(params, "stickerId")?.[0];
    if (!fileId) {
      throw new Error("fileId is required.");
    }
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.sendStickerTelegram(to, fileId, {
      cfg,
      token,
      accountId: accountId ?? undefined,
      replyToMessageId: replyToMessageId ?? undefined,
      messageThreadId: messageThreadId ?? undefined,
      gatewayClientScopes: options?.gatewayClientScopes,
    });
    notifyVisibleOutboundSuccess(to, messageThreadId);
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  }

  if (action === "searchSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(
        "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
      );
    }
    const query = readStringParam(params, "query", { required: true });
    const limit =
      readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      }) ?? 5;
    const results = await telegramActionRuntime.searchStickers(query, limit);
    return jsonResult({
      ok: true,
      count: results.length,
      stickers: results.map((s) => ({
        fileId: s.fileId,
        emoji: s.emoji,
        description: s.description,
        setName: s.setName,
      })),
    });
  }

  if (action === "stickerCacheStats") {
    const stats = await telegramActionRuntime.getCacheStats();
    return jsonResult({ ok: true, ...stats });
  }

  if (action === "createForumTopic") {
    if (!isActionEnabled("createForumTopic")) {
      throw new Error("Telegram createForumTopic is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const name =
      readStringParam(params, "name") ??
      readStringParam(params, "threadName", { required: true, label: "name" });
    const iconColor = readTelegramForumTopicIconColor(params);
    const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.createForumTopicTelegram(chatId ?? "", name, {
      cfg,
      token,
      accountId: accountId ?? undefined,
      iconColor,
      iconCustomEmojiId: iconCustomEmojiId ?? undefined,
      gatewayClientScopes: options?.gatewayClientScopes,
    });
    if (result.topicId != null && result.chatId) {
      await updateTopicName(
        result.chatId,
        result.topicId,
        {
          name,
          ...(iconColor != null ? { iconColor } : {}),
          ...(iconCustomEmojiId ? { iconCustomEmojiId } : {}),
        },
        resolveActionTopicNameCacheScope(cfg, accountId),
      ).catch(() => {});
    }
    return jsonResult({
      ok: true,
      topicId: result.topicId,
      name: result.name,
      chatId: result.chatId,
    });
  }

  if (action === "editForumTopic") {
    if (!isActionEnabled("editForumTopic")) {
      throw new Error("Telegram editForumTopic is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const messageThreadId = readTelegramThreadId(params);
    if (typeof messageThreadId !== "number") {
      throw new Error("messageThreadId or threadId is required.");
    }
    const name = readStringParam(params, "name") ?? readStringParam(params, "threadName");
    const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.editForumTopicTelegram(
      chatId ?? "",
      messageThreadId,
      {
        cfg,
        token,
        accountId: accountId ?? undefined,
        name: name ?? undefined,
        iconCustomEmojiId: iconCustomEmojiId ?? undefined,
        gatewayClientScopes: options?.gatewayClientScopes,
      },
    );
    if (result.chatId) {
      const patch: { name?: string; iconCustomEmojiId?: string } = {};
      if (name) {
        patch.name = name;
      }
      if (iconCustomEmojiId) {
        patch.iconCustomEmojiId = iconCustomEmojiId;
      }
      if (Object.keys(patch).length > 0) {
        await updateTopicName(
          result.chatId,
          result.messageThreadId,
          patch,
          resolveActionTopicNameCacheScope(cfg, accountId),
        ).catch(() => {});
      }
    }
    return jsonResult(result);
  }

  throw new Error(`Unsupported Telegram action: ${String(action)}`);
}
