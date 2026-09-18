import {
  readPositiveIntegerParam,
  readStringOrNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { DurableMessageBatchSendResult } from "openclaw/plugin-sdk/channel-outbound";
import {
  isMessagePresentationInteractiveBlock,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { TELEGRAM_CALLBACK_DATA_MAX_BYTES } from "./approval-callback-data.js";
import {
  resolveTelegramInlineButtons,
  type TelegramButtonBuildOptions,
  type TelegramDroppedControl,
} from "./button-types.js";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";

export function readTelegramThreadId(params: Record<string, unknown>) {
  return (
    readPositiveIntegerParam(params, "messageThreadId", {
      message: "messageThreadId must be a positive integer.",
    }) ??
    readPositiveIntegerParam(params, "threadId", {
      message: "threadId must be a positive integer.",
    })
  );
}

export function readTelegramChatId(params: Record<string, unknown>) {
  return (
    readStringOrNumberParam(params, "chatId") ??
    readStringOrNumberParam(params, "channelId") ??
    readStringOrNumberParam(params, "to", { required: true })
  );
}

export function readTelegramReplyToMessageId(params: Record<string, unknown>) {
  return (
    readPositiveIntegerParam(params, "replyToMessageId", {
      message: "replyToMessageId must be a positive integer.",
    }) ??
    readPositiveIntegerParam(params, "replyTo", {
      message: "replyTo must be a positive integer.",
    })
  );
}

function pushTelegramMediaUrl(mediaUrls: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  mediaUrls.push(normalized);
}

export function readTelegramSendMediaUrls(params: Record<string, unknown>) {
  const mediaUrls: string[] = [];
  const seen = new Set<string>();
  pushTelegramMediaUrl(mediaUrls, seen, params.mediaUrl);
  pushTelegramMediaUrl(mediaUrls, seen, params.media);
  pushTelegramMediaUrl(mediaUrls, seen, params.path);
  pushTelegramMediaUrl(mediaUrls, seen, params.filePath);
  pushTelegramMediaUrl(mediaUrls, seen, params.fileUrl);
  if (Array.isArray(params.mediaUrls)) {
    for (const mediaUrl of params.mediaUrls) {
      pushTelegramMediaUrl(mediaUrls, seen, mediaUrl);
    }
  }
  if (Array.isArray(params.attachments)) {
    for (const attachment of params.attachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        continue;
      }
      // SAFETY: The object and non-array guards above narrow the attachment to a record shape.
      const record = attachment as Record<string, unknown>;
      pushTelegramMediaUrl(mediaUrls, seen, record.media);
      pushTelegramMediaUrl(mediaUrls, seen, record.mediaUrl);
      pushTelegramMediaUrl(mediaUrls, seen, record.path);
      pushTelegramMediaUrl(mediaUrls, seen, record.filePath);
      pushTelegramMediaUrl(mediaUrls, seen, record.fileUrl);
      pushTelegramMediaUrl(mediaUrls, seen, record.url);
    }
  }
  return mediaUrls;
}

export function resolveTelegramButtonsFromParams(
  params: Record<string, unknown>,
  presentation = normalizeMessagePresentation(params.presentation),
  options?: TelegramButtonBuildOptions,
) {
  return resolveTelegramInlineButtons(
    {
      presentation,
      interactive: params.interactive,
    },
    options,
  );
}

export function selectTelegramInteractivePresentation(
  presentation: MessagePresentation | undefined,
): MessagePresentation | undefined {
  const blocks = presentation?.blocks.filter(isMessagePresentationInteractiveBlock) ?? [];
  return blocks.length > 0 ? { blocks } : undefined;
}

export function selectTelegramNonInteractivePresentation(
  presentation: MessagePresentation | undefined,
): MessagePresentation | undefined {
  if (!presentation) {
    return undefined;
  }
  const blocks = presentation.blocks.filter(
    (block) => !isMessagePresentationInteractiveBlock(block),
  );
  return blocks.length > 0 || presentation.title ? { ...presentation, blocks } : undefined;
}

export function readTelegramPayloadButtons(
  payload: ReplyPayload,
): ReturnType<typeof resolveTelegramButtonsFromParams> {
  const telegram = payload.channelData?.telegram;
  if (!telegram || typeof telegram !== "object" || Array.isArray(telegram)) {
    return undefined;
  }
  // SAFETY: The canonicalizer owns this shape and emits only TelegramInlineButtons.
  return (telegram as { buttons?: ReturnType<typeof resolveTelegramButtonsFromParams> }).buttons;
}

function countTelegramPresentationControls(presentation: MessagePresentation | undefined): number {
  return (
    presentation?.blocks.reduce(
      (count, block) =>
        count +
        (block.type === "buttons"
          ? block.buttons.length
          : block.type === "select"
            ? block.options.length
            : 0),
      0,
    ) ?? 0
  );
}

function countTelegramInlineButtons(
  buttons: ReturnType<typeof resolveTelegramButtonsFromParams>,
): number {
  return buttons?.reduce((count, row) => count + row.length, 0) ?? 0;
}

function countTelegramPresentationCopyTextControls(
  presentation: MessagePresentation | undefined,
): number {
  return (
    presentation?.blocks.reduce(
      (count, block) =>
        count +
        (block.type === "buttons"
          ? block.buttons.filter(
              (button) => resolveMessagePresentationButtonAction(button)?.type === "copy-text",
            ).length
          : 0),
      0,
    ) ?? 0
  );
}

function countTelegramInlineCopyTextButtons(
  buttons: ReturnType<typeof resolveTelegramButtonsFromParams>,
): number {
  return (
    buttons?.reduce(
      (count, row) => count + row.filter((button) => button.copy_text !== undefined).length,
      0,
    ) ?? 0
  );
}

export function resolveTelegramMarkupOnlyPresentationFallback(params: {
  interactivePresentation: MessagePresentation | undefined;
  interactive?: unknown;
  buttons: ReturnType<typeof resolveTelegramButtonsFromParams>;
  buttonOptions: TelegramButtonBuildOptions;
  droppedControlCount: number;
}):
  | {
      count: number;
      reason?: "presentation_action_budget_exceeded" | "presentation_keyboard_precedence";
      requiresExplicitContent: boolean;
    }
  | undefined {
  const requestedCount = countTelegramPresentationControls(params.interactivePresentation);
  if (requestedCount === 0) {
    return undefined;
  }
  const legacyButtons = resolveTelegramInlineButtons(
    {
      interactive: normalizeLegacyInteractiveReply(params.interactive),
    },
    {
      ...params.buttonOptions,
      onDroppedControl: undefined,
    },
  );
  if (countTelegramInlineButtons(legacyButtons) > 0) {
    return {
      count: requestedCount,
      reason: "presentation_keyboard_precedence",
      requiresExplicitContent:
        countTelegramPresentationCopyTextControls(params.interactivePresentation) > 0,
    };
  }
  const missingCount = Math.max(0, requestedCount - countTelegramInlineButtons(params.buttons));
  if (missingCount === 0) {
    return undefined;
  }
  return {
    count: missingCount,
    requiresExplicitContent:
      countTelegramPresentationCopyTextControls(params.interactivePresentation) >
      countTelegramInlineCopyTextButtons(params.buttons),
    ...(missingCount > params.droppedControlCount
      ? { reason: "presentation_action_budget_exceeded" as const }
      : {}),
  };
}

export function readTelegramSendContent(params: {
  args: Record<string, unknown>;
  mediaUrl?: string;
  hasButtons: boolean;
  hasLocation?: boolean;
  interactive?: unknown;
  presentation?: MessagePresentation;
}) {
  const explicitContent =
    readStringParam(params.args, "content", { allowEmpty: true }) ??
    readStringParam(params.args, "message", { allowEmpty: true }) ??
    readStringParam(params.args, "caption", { allowEmpty: true });
  const unsupportedBlocks =
    params.presentation?.blocks.filter(
      (block) => block.type === "chart" || block.type === "table",
    ) ?? [];
  const presentationText =
    explicitContent == null && params.presentation
      ? renderMessagePresentationFallbackText({ presentation: params.presentation })
      : explicitContent != null && unsupportedBlocks.length > 0
        ? renderMessagePresentationFallbackText({
            text: explicitContent,
            presentation: { ...params.presentation, blocks: unsupportedBlocks },
          })
        : undefined;
  const interactiveText =
    explicitContent == null && !params.presentation
      ? resolveTelegramInteractiveTextFallback({ interactive: params.interactive })
      : undefined;
  let content =
    (presentationText?.trim() ? presentationText : undefined) ??
    explicitContent ??
    (interactiveText?.trim() ? interactiveText : undefined);
  if ((content == null || content.trim().length === 0) && !params.mediaUrl && params.hasButtons) {
    const fallback = presentationText?.trim() ? presentationText : interactiveText;
    if (fallback?.trim()) {
      content = fallback;
    }
  }
  if (content == null && !params.mediaUrl && !params.hasButtons && !params.hasLocation) {
    throw new Error("content required.");
  }
  return {
    content: content ?? "",
    hasExplicitContent: explicitContent != null,
  };
}

export function buildTelegramControlDegradation(
  controls: readonly TelegramDroppedControl[],
  fallbackDelivered: boolean,
  options?: {
    fallbackControlCount?: number;
    fallbackReason?: "presentation_action_budget_exceeded" | "presentation_keyboard_precedence";
    requiresExplicitContent?: boolean;
  },
) {
  const controlCount = Math.max(controls.length, options?.fallbackControlCount ?? 0);
  if (controlCount === 0) {
    return undefined;
  }
  const reasons = [
    ...new Set([
      ...controls.map((control) => control.reason),
      ...(options?.fallbackReason ? [options.fallbackReason] : []),
    ]),
  ];
  const hasOverflow = reasons.includes("callback_data_too_long");
  return {
    warning: fallbackDelivered
      ? `Telegram delivered ${controlCount} unencodable control${controlCount === 1 ? "" : "s"} as readable text.`
      : `Telegram could not deliver ${controlCount} control${controlCount === 1 ? "" : "s"}.`,
    degradedDelivery: {
      droppedControls: controlCount,
      fallback: fallbackDelivered ? "text" : "not_delivered",
      reasons,
      ...(hasOverflow ? { callbackDataLimitBytes: TELEGRAM_CALLBACK_DATA_MAX_BYTES } : {}),
      guidance: options?.requiresExplicitContent
        ? "Retry with explicit content or caption so Telegram can deliver the readable fallback without replacing the existing message body."
        : hasOverflow
          ? `Shorten callback data to at most ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} UTF-8 bytes and retry if clickable controls are required.`
          : "Retry with a supported control action if clickable controls are required.",
    },
  };
}

export function normalizeTelegramDeliveryPin(params: Record<string, unknown>) {
  const delivery = params.delivery;
  let pin: unknown;
  if (delivery && typeof delivery === "object" && !Array.isArray(delivery)) {
    // SAFETY: The object and non-array guards narrow delivery to a record with an optional pin.
    pin = (delivery as { pin?: unknown }).pin;
  } else {
    pin = params.pin === true ? true : undefined;
  }
  if (pin === true) {
    return { enabled: true } as const;
  }
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
    return undefined;
  }
  // SAFETY: The object and non-array guards above narrow pin to the supported option record.
  const raw = pin as { enabled?: unknown; notify?: unknown; required?: unknown };
  if (raw.enabled !== true) {
    return undefined;
  }
  return {
    enabled: true,
    ...(raw.notify === true ? { notify: true } : {}),
    ...(raw.required === true ? { required: true } : {}),
  } as const;
}

export function buildTelegramActionSendPayload(params: {
  content: string;
  mediaUrls: string[];
  asVoice?: boolean;
  asVideoNote?: boolean;
  location?: ReplyPayload["location"];
  pin?: ReturnType<typeof normalizeTelegramDeliveryPin>;
  buttons?: ReturnType<typeof resolveTelegramButtonsFromParams>;
  quoteText?: string;
}): ReplyPayload {
  const telegramData =
    params.buttons || params.quoteText
      ? {
          ...(params.buttons ? { buttons: params.buttons } : {}),
          ...(params.quoteText ? { quoteText: params.quoteText } : {}),
        }
      : undefined;
  return {
    text: params.content,
    ...(params.mediaUrls.length > 0 ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.asVoice === true ? { audioAsVoice: true } : {}),
    ...(params.asVideoNote === true ? { videoAsNote: true } : {}),
    ...(params.location ? { location: params.location } : {}),
    ...(params.pin ? { delivery: { pin: params.pin } } : {}),
    ...(telegramData ? { channelData: { telegram: telegramData } } : {}),
  };
}

export function getLastDurableTelegramActionResult(
  result: Extract<DurableMessageBatchSendResult, { status: "sent" }>,
) {
  const lastResult = result.results.at(-1);
  const receipt = result.receipt;
  return {
    messageId:
      lastResult?.messageId ??
      receipt.primaryPlatformMessageId ??
      receipt.platformMessageIds.at(-1),
    chatId: lastResult?.target?.kind === "chat" ? lastResult.target.id : undefined,
    receipt: { threadId: receipt.threadId, replyToId: receipt.replyToId },
  };
}
