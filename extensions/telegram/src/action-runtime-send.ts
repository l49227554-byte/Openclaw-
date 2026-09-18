import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import { normalizeOutboundLocation } from "openclaw/plugin-sdk/channel-inbound";
import { buildOutboundSessionContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isMessagePresentationInteractiveBlock,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  buildTelegramActionSendPayload,
  buildTelegramControlDegradation,
  getLastDurableTelegramActionResult,
  normalizeTelegramDeliveryPin,
  readTelegramPayloadButtons,
  readTelegramReplyToMessageId,
  readTelegramSendContent,
  readTelegramSendMediaUrls,
  readTelegramThreadId,
  resolveTelegramButtonsFromParams,
  selectTelegramInteractivePresentation,
  selectTelegramNonInteractivePresentation,
} from "./action-runtime-message.js";
import type { TelegramActionOptions } from "./action-runtime.types.js";
import {
  appendTelegramDroppedControlFallback,
  type TelegramButtonBuildOptions,
  type TelegramDroppedControl,
} from "./button-types.js";
import {
  resolveTelegramInlineButtonsScope,
  resolveTelegramTargetChatType,
} from "./inline-buttons.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import { normalizeTelegramOutboundTarget } from "./targets.js";
import { resolveTelegramToken } from "./token.js";

type SendDurableMessageBatch =
  typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch;

export async function handleTelegramSendMessageAction(params: {
  actionParams: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  options?: TelegramActionOptions;
  runtime: { sendDurableMessageBatch: SendDurableMessageBatch };
  notifyVisibleOutboundSuccess: (to: string, messageThreadId?: number | null) => void;
}) {
  const { actionParams, cfg, accountId, options, runtime, notifyVisibleOutboundSuccess } = params;
  const to = normalizeTelegramOutboundTarget(
    readStringParam(actionParams, "to", { required: true }),
  );
  const mediaUrls = readTelegramSendMediaUrls(actionParams);
  const firstMediaUrl = mediaUrls[0];
  const location = normalizeOutboundLocation(actionParams.location);
  const presentation = normalizeMessagePresentation(actionParams.presentation);
  const droppedControls: TelegramDroppedControl[] = [];
  const buttonOptions: TelegramButtonBuildOptions = {
    allowWebAppButtons: resolveTelegramTargetChatType(to) === "direct",
    onDroppedControl: (control) => droppedControls.push(control),
  };
  let buttons = presentation
    ? undefined
    : resolveTelegramButtonsFromParams(actionParams, undefined, buttonOptions);
  const interactivePresentation = selectTelegramInteractivePresentation(presentation);
  const nonInteractivePresentation = selectTelegramNonInteractivePresentation(presentation);
  const resolvedContent = readTelegramSendContent({
    args: actionParams,
    mediaUrl: firstMediaUrl,
    hasButtons:
      (Array.isArray(buttons) && buttons.length > 0) || interactivePresentation !== undefined,
    hasLocation: Boolean(location),
    interactive: actionParams.interactive,
    presentation: nonInteractivePresentation,
  });
  let content = resolvedContent.content;
  // Keep authored/chart fallback policy here, but route portable controls
  // through Telegram's canonical capability and shared-budget adapter.
  const presentationControlsCanonicalized = interactivePresentation !== undefined;
  if (interactivePresentation) {
    const canonical = canonicalizeTelegramPresentationPayload(
      {
        text: content,
        interactive: normalizeLegacyInteractiveReply(actionParams.interactive),
        presentation: interactivePresentation,
      },
      {
        allowWebAppButtons: buttonOptions.allowWebAppButtons,
        onDroppedControl: buttonOptions.onDroppedControl,
      },
    );
    buttons = readTelegramPayloadButtons(canonical);
    content = canonical.text ?? content;
  } else if (presentation) {
    buttons = resolveTelegramButtonsFromParams(actionParams, presentation, buttonOptions);
  }
  if (
    !presentationControlsCanonicalized &&
    droppedControls.length > 0 &&
    resolvedContent.hasExplicitContent
  ) {
    content = appendTelegramDroppedControlFallback(content, droppedControls);
  }
  const droppedControlFallback = appendTelegramDroppedControlFallback("", droppedControls);
  const hasOnlyDroppedControlFallback =
    !resolvedContent.hasExplicitContent &&
    droppedControlFallback.length > 0 &&
    (presentation
      ? presentation.blocks.every(isMessagePresentationInteractiveBlock)
      : content.trim() === droppedControlFallback.trim());
  const asVideoNote = readBooleanParam(actionParams, "asVideoNote") ?? false;
  if (
    location &&
    ((content.trim() && !hasOnlyDroppedControlFallback) || mediaUrls.length > 0 || asVideoNote)
  ) {
    throw new Error("Telegram location sends cannot be combined with message text or media.");
  }
  if (asVideoNote && mediaUrls.length !== 1) {
    throw new Error("Telegram video notes require exactly one media attachment.");
  }
  if (buttons) {
    const inlineButtonsScope = resolveTelegramInlineButtonsScope({
      cfg,
      accountId: accountId ?? undefined,
    });
    if (inlineButtonsScope === "off") {
      throw new Error(
        'Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to "dm", "group", "all", or "allowlist".',
      );
    }
    if (inlineButtonsScope === "dm" || inlineButtonsScope === "group") {
      const targetType = resolveTelegramTargetChatType(to);
      if (targetType === "unknown") {
        throw new Error(
          `Telegram inline buttons require a numeric chat id when inlineButtons="${inlineButtonsScope}".`,
        );
      }
      if (inlineButtonsScope === "dm" && targetType !== "direct") {
        throw new Error('Telegram inline buttons are limited to DMs when inlineButtons="dm".');
      }
      if (inlineButtonsScope === "group" && targetType !== "group") {
        throw new Error(
          'Telegram inline buttons are limited to groups when inlineButtons="group".',
        );
      }
    }
  }
  const replyToMessageId = readTelegramReplyToMessageId(actionParams);
  const messageThreadId = readTelegramThreadId(actionParams);
  const quoteText = readStringParam(actionParams, "quoteText", { trim: false });
  const token = resolveTelegramToken(cfg, { accountId }).token;
  if (!token) {
    throw new Error(
      "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
    );
  }
  const sendOptions = {
    cfg,
    accountId: accountId ?? undefined,
    gatewayClientScopes: options?.gatewayClientScopes,
    replyToMessageId: replyToMessageId ?? undefined,
    messageThreadId: messageThreadId ?? undefined,
    quoteText: quoteText ?? undefined,
    asVoice: readBooleanParam(actionParams, "asVoice"),
    asVideoNote,
    silent: readBooleanParam(actionParams, "silent"),
    forceDocument:
      readBooleanParam(actionParams, "forceDocument") ??
      readBooleanParam(actionParams, "asDocument") ??
      false,
  };
  const payload = buildTelegramActionSendPayload({
    content,
    mediaUrls,
    asVoice: sendOptions.asVoice,
    asVideoNote: sendOptions.asVideoNote,
    location,
    pin: normalizeTelegramDeliveryPin(actionParams),
    buttons,
    quoteText,
  });
  const mediaAccess =
    options?.mediaAccess ??
    (options?.mediaLocalRoots || options?.mediaReadFile
      ? {
          ...(options.mediaLocalRoots ? { localRoots: options.mediaLocalRoots } : {}),
          ...(options.mediaReadFile ? { readFile: options.mediaReadFile } : {}),
        }
      : undefined);
  const outboundSession = buildOutboundSessionContext({
    cfg,
    sessionKey: options?.sessionKey,
    requesterAccountId: accountId,
  });
  const durableResult = await runtime.sendDurableMessageBatch({
    cfg,
    channel: "telegram",
    to,
    accountId: accountId ?? undefined,
    payloads: [payload],
    ...(options?.reply
      ? { reply: options.reply }
      : { replyToId: replyToMessageId == null ? undefined : String(replyToMessageId) }),
    threadId: messageThreadId,
    forceDocument: sendOptions.forceDocument,
    silent: sendOptions.silent,
    durability: "required",
    gatewayClientScopes: options?.gatewayClientScopes,
    deliveryRetryOwner: options?.deliveryRetryOwner,
    onPlatformSendDispatch: options?.onPlatformSendDispatch,
    assertDirectAdapterHandoff: options?.assertDirectAdapterHandoff,
    skipQueue: options?.skipQueue,
    ...(mediaAccess ? { mediaAccess } : {}),
    ...(outboundSession ? { session: outboundSession } : {}),
  });
  if (durableResult.status === "failed" || durableResult.status === "partial_failed") {
    throw durableResult.error;
  }
  if (durableResult.status === "suppressed") {
    const mayHaveReachedRecipient =
      durableResult.reason === "adapter_returned_no_identity" ||
      durableResult.payloadOutcomes?.some((outcome) =>
        outcome.status === "failed"
          ? outcome.sentBeforeError
          : outcome.status === "sent" || outcome.reason === "adapter_returned_no_identity",
      );
    if (mayHaveReachedRecipient) {
      throw new Error("Telegram sendMessage was suppressed before delivery.");
    }
    // Hook diagnostics remain private; only the durable owner's bounded reason crosses here.
    return jsonResult({ status: "suppressed", reason: durableResult.reason });
  }
  const result = getLastDurableTelegramActionResult(durableResult);
  notifyVisibleOutboundSuccess(to, messageThreadId);
  return jsonResult({
    ok: true,
    messageId: result.messageId,
    chatId: result.chatId,
    receipt: result.receipt,
    ...buildTelegramControlDegradation(droppedControls, Boolean(content.trim())),
  });
}
