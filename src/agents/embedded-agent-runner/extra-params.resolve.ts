/**
 * Extra-param resolution, aliasing, and payload-record helpers shared by the
 * full-agent stream wrappers (`extra-params.ts`) and by isolated/simple
 * completions (`../simple-completion-execution.ts`). Kept as a leaf module
 * (no imports back into the agent-runner/runtime graph) so isolated
 * completions can depend on this parameter-resolution contract without
 * pulling in the full agent stream-wrapper chain.
 */
import { canonicalizeMaxTokensParam } from "@openclaw/ai/transports";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { resolveModelExtraParamSources } from "../model-extra-params.js";
import {
  getModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "../provider-request-config.js";
import { log } from "./logger.js";

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 */
export function resolveExtraParams(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentId?: string;
}): Record<string, unknown> | undefined {
  const { defaultParams, modelParams, agentModelParams, agentParams } =
    resolveModelExtraParamSources({
      config: params.cfg,
      provider: params.provider,
      modelId: params.modelId,
      agentId: params.agentId,
    });
  const sources = [defaultParams, modelParams, agentModelParams, agentParams];
  const merged = Object.assign({}, ...sources);
  canonicalizeExtraParamAlias(merged, sources, ["parallel_tool_calls", "parallelToolCalls"]);
  canonicalizeExtraParamAlias(
    merged,
    [modelParams, agentModelParams, agentParams],
    ["text_verbosity", "textVerbosity"],
  );
  canonicalizeExtraParamAlias(merged, sources, ["response_format", "responseFormat"]);
  canonicalizeMaxTokensParam({ merged, sources });
  canonicalizeExtraParamAlias(
    merged,
    sources,
    ["cached_content", "cachedContent"],
    "cachedContent",
  );
  if (params.provider === "openrouter") {
    canonicalizeOpenRouterResponseCacheParams(merged, sources);
  }

  applyDefaultOpenAIGptRuntimeParams(params, merged);

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function shouldApplyDefaultOpenAIGptRuntimeParams(params: {
  provider: string;
  modelId: string;
}): boolean {
  if (params.provider !== "openai") {
    return false;
  }
  return /^gpt-5(?:[.-]|$)/i.test(params.modelId);
}

function applyDefaultOpenAIGptRuntimeParams(
  params: { provider: string; modelId: string },
  merged: Record<string, unknown>,
): void {
  if (!shouldApplyDefaultOpenAIGptRuntimeParams(params)) {
    return;
  }
  if (
    !Object.hasOwn(merged, "parallel_tool_calls") &&
    !Object.hasOwn(merged, "parallelToolCalls")
  ) {
    merged.parallel_tool_calls = true;
  }
  if (!Object.hasOwn(merged, "text_verbosity") && !Object.hasOwn(merged, "textVerbosity")) {
    merged.text_verbosity = "low";
  }
}

export function resolveAliasedParamValue(
  sources: Array<Record<string, unknown> | undefined>,
  snakeCaseKey: string,
  camelCaseKey: string,
): unknown {
  return resolveAliasedParamValueFromKeys(sources, [snakeCaseKey, camelCaseKey]);
}

export function resolveAliasedParamValueFromKeys(
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): unknown {
  let resolved: unknown = undefined;
  let seen = false;
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      if (!Object.hasOwn(source, key)) {
        continue;
      }
      resolved = source[key];
      seen = true;
      break;
    }
  }
  return seen ? resolved : undefined;
}

export function canonicalizeExtraParamAlias(
  merged: Record<string, unknown>,
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly [string, string],
  canonical = keys[0],
): void {
  const resolved = resolveAliasedParamValueFromKeys(sources, keys);
  if (resolved !== undefined) {
    merged[canonical] = resolved;
    delete merged[keys[0] === canonical ? keys[1] : keys[0]];
  }
}

function applyCanonicalAliasedParamValue(params: {
  merged: Record<string, unknown>;
  sources: Array<Record<string, unknown> | undefined>;
  keys: readonly string[];
  canonicalKey: string;
}): void {
  const resolved = resolveAliasedParamValueFromKeys(params.sources, params.keys);
  if (resolved === undefined) {
    return;
  }
  for (const key of params.keys) {
    delete params.merged[key];
  }
  params.merged[params.canonicalKey] = resolved;
}

export function canonicalizeOpenRouterResponseCacheParams(
  merged: Record<string, unknown>,
  sources: Array<Record<string, unknown> | undefined>,
): void {
  applyCanonicalAliasedParamValue({
    merged,
    sources,
    keys: ["responseCache", "response_cache"],
    canonicalKey: "responseCache",
  });
  applyCanonicalAliasedParamValue({
    merged,
    sources,
    keys: [
      "responseCacheTtlSeconds",
      "response_cache_ttl_seconds",
      "responseCacheTtl",
      "response_cache_ttl",
    ],
    canonicalKey: "responseCacheTtlSeconds",
  });
  applyCanonicalAliasedParamValue({
    merged,
    sources,
    keys: ["responseCacheClear", "response_cache_clear"],
    canonicalKey: "responseCacheClear",
  });
}

export function sanitizeExtraParamsRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
    ),
  );
}

export function shouldStripOpenAICompletionsStore(model: ProviderRuntimeModel): boolean {
  if (model.api !== "openai-completions") {
    return false;
  }
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>) // SAFETY: guarded by the `typeof model.compat === "object"` check above
      : undefined;
  const capabilities =
    getModelProviderRequestRouteFacts(model)?.capabilities ??
    resolveProviderRequestPolicyConfig({
      provider: typeof model.provider === "string" ? model.provider : undefined,
      api: model.api,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      compat,
      capability: "llm",
      transport: "stream",
    }).capabilities;
  return !capabilities.usesKnownNativeOpenAIRoute;
}

function sanitizeExtraBodyRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sanitizeExtraParamsRecord(value) ?? {}).filter(
      ([, entry]) => entry !== undefined,
    ),
  );
}

export function resolveExtraBodyRecord(
  value: unknown,
  param: "extra_body" | "chat_template_kwargs",
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    log.warn(
      `ignoring invalid ${param} param: ${typeof value === "string" ? value : typeof value}`,
    );
    return undefined;
  }
  // SAFETY: guarded by the `typeof value !== "object" || Array.isArray(value)` check above
  const record = sanitizeExtraBodyRecord(value as Record<string, unknown>);
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Resolves configured `chat_template_kwargs` / `extra_body` payload overrides from
 * model config alone (no per-request override or agent stream context). Shared by
 * the full-agent stream wrappers in `extra-params.ts` and by isolated/simple
 * completions so the two request paths cannot diverge on which configured payload
 * params apply.
 */
export function resolveConfiguredOpenAICompletionsPayloadParams(
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
): { chatTemplateKwargs?: Record<string, unknown>; extraBody?: Record<string, unknown> } {
  const extraParams = resolveExtraParams({ cfg, provider, modelId });
  const chatTemplateKwargs = resolveExtraBodyRecord(
    resolveAliasedParamValue([extraParams], "chat_template_kwargs", "chatTemplateKwargs"),
    "chat_template_kwargs",
  );
  const extraBody = resolveExtraBodyRecord(
    resolveAliasedParamValue([extraParams], "extra_body", "extraBody"),
    "extra_body",
  );
  return {
    ...(chatTemplateKwargs ? { chatTemplateKwargs } : {}),
    ...(extraBody ? { extraBody } : {}),
  };
}
