import {
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  buildTelegramControlDegradation,
  readTelegramChatId,
  readTelegramPayloadButtons,
  readTelegramSendContent,
  resolveTelegramButtonsFromParams,
  resolveTelegramMarkupOnlyPresentationFallback,
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
import { resolveTelegramMessageMutationChatId } from "./message-topic-binding.js";
import { resolveTelegramToken } from "./token.js";

type EditMessageTelegram = typeof import("./send.js").editMessageTelegram;
type EditMessageReplyMarkupTelegram = typeof import("./send.js").editMessageReplyMarkupTelegram;

export async function handleTelegramEditMessageAction(params: {
  actionParams: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  options?: TelegramActionOptions;
  runtime: {
    editMessageTelegram: EditMessageTelegram;
    editMessageReplyMarkupTelegram: EditMessageReplyMarkupTelegram;
  };
}) {
  const { actionParams, cfg, accountId, options, runtime } = params;
  const chatId = readTelegramChatId(actionParams);
  const messageId = readPositiveIntegerParam(actionParams, "messageId", {
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
  let content =
    readStringParam(actionParams, "content", { allowEmpty: false }) ??
    readStringParam(actionParams, "message", { allowEmpty: false });
  // Telegram treats an explicit empty caption as a request to remove it.
  let caption = readStringParam(actionParams, "caption", { allowEmpty: true });
  const presentation = normalizeMessagePresentation(actionParams.presentation);
  const droppedControls: TelegramDroppedControl[] = [];
  const buttonOptions: TelegramButtonBuildOptions = {
    allowWebAppButtons: resolveTelegramTargetChatType(chatId ?? "") === "direct",
    onDroppedControl: (control) => droppedControls.push(control),
  };
  let buttons = presentation
    ? undefined
    : resolveTelegramButtonsFromParams(actionParams, undefined, buttonOptions);
  const interactivePresentation = selectTelegramInteractivePresentation(presentation);
  const nonInteractivePresentation = selectTelegramNonInteractivePresentation(presentation);
  if (nonInteractivePresentation) {
    const resolvedContent = readTelegramSendContent({
      args: actionParams,
      hasButtons: interactivePresentation !== undefined,
      interactive: actionParams.interactive,
      presentation: nonInteractivePresentation,
    }).content;
    if (caption != null) {
      caption = resolvedContent;
    } else {
      content = resolvedContent;
    }
  }
  const presentationControlsCanonicalized = interactivePresentation !== undefined;
  if (interactivePresentation) {
    const canonical = canonicalizeTelegramPresentationPayload(
      {
        text: caption ?? content,
        interactive: normalizeLegacyInteractiveReply(actionParams.interactive),
        presentation: interactivePresentation,
      },
      {
        allowWebAppButtons: buttonOptions.allowWebAppButtons,
        onDroppedControl: buttonOptions.onDroppedControl,
        preserveEmptyTextForControls: caption === "",
      },
    );
    buttons = readTelegramPayloadButtons(canonical);
    if (caption != null) {
      caption = canonical.text ?? caption;
    } else if (content != null) {
      content = canonical.text ?? content;
    }
  } else if (presentation) {
    buttons = resolveTelegramButtonsFromParams(actionParams, presentation, buttonOptions);
  }
  if (!presentationControlsCanonicalized && droppedControls.length > 0) {
    if (caption != null) {
      caption = appendTelegramDroppedControlFallback(caption, droppedControls);
    } else if (content != null) {
      content = appendTelegramDroppedControlFallback(content, droppedControls);
    }
  }
  const markupOnlyPresentationFallback =
    content == null && caption == null && presentationControlsCanonicalized
      ? resolveTelegramMarkupOnlyPresentationFallback({
          interactivePresentation,
          interactive: actionParams.interactive,
          buttons,
          buttonOptions,
          droppedControlCount: droppedControls.length,
        })
      : undefined;
  if (
    content == null &&
    caption == null &&
    (buttons === undefined || markupOnlyPresentationFallback?.requiresExplicitContent === true)
  ) {
    const degradation = buildTelegramControlDegradation(droppedControls, false, {
      fallbackControlCount: markupOnlyPresentationFallback?.count,
      fallbackReason: markupOnlyPresentationFallback?.reason,
      requiresExplicitContent:
        buttons === undefined || markupOnlyPresentationFallback?.requiresExplicitContent === true,
    });
    if (degradation) {
      return jsonResult({ ok: false, ...degradation });
    }
    throw new Error("content required.");
  }
  if (buttons !== undefined) {
    const inlineButtonsScope = resolveTelegramInlineButtonsScope({
      cfg,
      accountId: accountId ?? undefined,
    });
    if (inlineButtonsScope === "off") {
      throw new Error(
        'Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to "dm", "group", "all", or "allowlist".',
      );
    }
  }
  const token = resolveTelegramToken(cfg, { accountId }).token;
  if (!token) {
    throw new Error(
      "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
    );
  }
  if (content == null && caption == null && buttons !== undefined) {
    const result = await runtime.editMessageReplyMarkupTelegram(
      authorizedChatId,
      messageId,
      buttons,
      {
        cfg,
        token,
        accountId: accountId ?? undefined,
        gatewayClientScopes: options?.gatewayClientScopes,
      },
    );
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
      ...buildTelegramControlDegradation(droppedControls, false, {
        fallbackControlCount: markupOnlyPresentationFallback?.count,
        fallbackReason: markupOnlyPresentationFallback?.reason,
      }),
    });
  }
  const result = await runtime.editMessageTelegram(
    authorizedChatId,
    messageId,
    caption ?? content ?? "",
    {
      cfg,
      token,
      accountId: accountId ?? undefined,
      buttons,
      editMode: caption != null ? "caption" : "auto",
      gatewayClientScopes: options?.gatewayClientScopes,
    },
  );
  return jsonResult({
    ok: true,
    messageId: result.messageId,
    chatId: result.chatId,
    ...buildTelegramControlDegradation(droppedControls, true),
  });
}
