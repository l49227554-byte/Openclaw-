/** Executes an already-prepared model without importing model/auth preparation. */
import { reasoningTagTextPolicy } from "@openclaw/ai/internal/openai";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import {
  prepareHeadersForSimpleCompletion,
  prepareModelForSimpleCompletion,
} from "@openclaw/ai/transports";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bindModelLlmRuntime,
  getModelCompletionOwner,
  getModelCompletionTransport,
  getModelLlmRuntime,
} from "../llm/model-runtime-binding.js";
import { completeSimple } from "../llm/stream.js";
import type { AssistantMessage, Model, SimpleStreamOptions } from "../llm/types.js";
import {
  resolveConfiguredOpenAICompletionsPayloadParams,
  shouldStripOpenAICompletionsStore,
} from "./embedded-agent-runner/extra-params.resolve.js";
import type { ResolvedProviderAuth } from "./model-auth.js";

type SimpleCompletionModelOptions = {
  headers?: Record<string, string>;
  sessionId?: string;
  maxTokens?: number;
  temperature?: number;
  serviceTier?: SimpleStreamOptions["serviceTier"];
  reasoning?: ThinkLevel;
  strictReasoningTags?: boolean;
  signal?: AbortSignal;
};

type PreparedCompletionParams = {
  assertCurrent?: () => void;
  model: Model;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof completeSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
};

export async function completeWithPreparedSimpleCompletionModel(
  params: PreparedCompletionParams,
): Promise<AssistantMessage> {
  const owner = getModelCompletionOwner(params.model);
  if (!owner) {
    return await completePreparedModel(params);
  }
  return await owner.run(() =>
    completePreparedModel({
      ...params,
      assertCurrent: () => {
        owner.assertCurrent();
        params.assertCurrent?.();
      },
    }),
  );
}

/**
 * Simple/isolated completions bypass the full agent stream-wrapper chain, so
 * configured `chat_template_kwargs` / `extra_body` never reached the wire on
 * this path. Reuse the same config resolution the agent path uses and patch
 * the outgoing payload directly via `onPayload`.
 *
 * Takes the logical (pre-transport) model, not the prepared transport model:
 * transport preparation can rewrite `model.api` to an internal dispatch
 * alias, which would make the `openai-completions` check below miss
 * managed proxy/TLS/local-service and provider-wrapper routes.
 */
function buildConfiguredOpenAICompletionsOnPayload(
  model: Model,
  cfg: OpenClawConfig | undefined,
): SimpleStreamOptions["onPayload"] | undefined {
  if (model.api !== "openai-completions") {
    return undefined;
  }
  const { chatTemplateKwargs, extraBody } = resolveConfiguredOpenAICompletionsPayloadParams(
    cfg,
    model.provider,
    model.id,
  );
  if (!chatTemplateKwargs && !extraBody) {
    return undefined;
  }
  const stripStore = extraBody ? shouldStripOpenAICompletionsStore(model) : false;
  return (payload) => {
    if (!payload || typeof payload !== "object") {
      return payload;
    }
    // SAFETY: guarded by the `typeof payload === "object"` check above
    const payloadObj = payload as Record<string, unknown>;
    if (chatTemplateKwargs) {
      const existing = payloadObj.chat_template_kwargs;
      payloadObj.chat_template_kwargs =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>), ...chatTemplateKwargs } // SAFETY: guarded by the typeof/Array.isArray check above
          : chatTemplateKwargs;
    }
    if (extraBody) {
      Object.assign(payloadObj, extraBody);
      if (stripStore) {
        delete payloadObj.store;
      }
    }
    return payloadObj;
  };
}

async function completePreparedModel(params: PreparedCompletionParams): Promise<AssistantMessage> {
  // Direct SDK calls prepare transport hooks before entering the stream facade.
  await import("./ai-transport-runtime-host.js");
  params.assertCurrent?.();
  params.options?.signal?.throwIfAborted();
  const runtime = getModelLlmRuntime(params.model);
  let completionModel =
    getModelCompletionTransport(params.model) ??
    prepareModelForSimpleCompletion({
      // Direct SDK callers that did not use the preparation helper keep the shipped
      // process-default behavior; all prepared host paths carry their lifecycle owner.
      apiRegistry: runtime?.registry ?? defaultApiRegistry,
      model: params.model,
      cfg: params.cfg,
    });
  if (runtime) {
    completionModel = bindModelLlmRuntime(completionModel, runtime);
  }
  const { reasoning: rawReasoning, strictReasoningTags, ...options } = params.options ?? {};
  const reasoning =
    rawReasoning === "adaptive" ? "medium" : rawReasoning === "ultra" ? "max" : rawReasoning;
  const headers = prepareHeadersForSimpleCompletion(completionModel, options);
  const onPayload = buildConfiguredOpenAICompletionsOnPayload(params.model, params.cfg);
  const completionOptions: SimpleStreamOptions = {
    ...options,
    ...(reasoning ? { reasoning } : {}),
    apiKey: params.auth.apiKey,
    ...(headers ? { headers } : {}),
    ...(onPayload ? { onPayload } : {}),
  };
  if (strictReasoningTags) {
    reasoningTagTextPolicy.markStrict(completionOptions);
  }
  return await completeSimple(
    completionModel,
    params.context,
    completionOptions,
    params.assertCurrent,
  );
}
