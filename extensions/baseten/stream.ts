/** Baseten request payload policy for models with opt-in chat-template reasoning. */
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPayloadPatchStreamWrapper,
  normalizeOpenAICompatibleReasoningReplay,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { usesBasetenChatTemplateThinking } from "./models.js";

/** Adds Baseten's `chat_template_args.enable_thinking` without dropping caller args. */
export function createBasetenThinkingWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
    // Standalone completions use dispatch aliases; the source API owns wire policy.
    if (model.provider !== "baseten" || (ctx.sourceApi ?? model.api) !== "openai-completions") {
      return;
    }
    if (model.id.trim().toLowerCase() === "deepseek-ai/deepseek-v4-pro") {
      // DeepSeek reasoning defaults on when no level is supplied. Only an
      // explicit `off` may remove its required replay metadata.
      normalizeOpenAICompatibleReasoningReplay(payload, {
        thinkingEnabled: ctx.thinkingLevel !== "off",
        stripAssistantMessagesOnly: true,
        replaceNullReasoningContent: true,
      });
    }
    if (!usesBasetenChatTemplateThinking(model.id)) {
      return;
    }
    payload.chat_template_args = {
      ...asNonArrayRecord(payload.chat_template_args),
      enable_thinking: ctx.thinkingLevel !== undefined && ctx.thinkingLevel !== "off",
    };
  });
}
