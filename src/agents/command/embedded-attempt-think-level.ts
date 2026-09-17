import type { ThinkLevel } from "../../auto-reply/thinking.shared.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { findModelInCatalog } from "../model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  resolveConfiguredThinkingDefault,
  resolveThinkingSelection,
} from "../model-thinking-default.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import {
  needsThinkHydration,
  normalizeThinkingCatalogProviders,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";

export type EmbeddedAttemptThinkLevel = {
  agentRuntime: string;
  thinkLevel: ThinkLevel;
  thinkingCatalog: ModelCatalogEntry[] | undefined;
};

/** Resolve per-candidate runtime and thinking so fallbacks do not reuse a frozen primary catalog. */
export async function resolveEmbeddedAttemptThinkLevel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  workspaceDir: string;
  pluginsEnabled: boolean;
  thinkingCatalog: ModelCatalogEntry[] | undefined;
  immutableThinkLevel?: ThinkLevel;
  defaultProvider: string;
  defaultModel: string;
  modelManifestContext: ModelManifestNormalizationContext;
}): Promise<EmbeddedAttemptThinkLevel> {
  const agentRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
  });
  const configuredThinkLevel =
    params.immutableThinkLevel ??
    resolveConfiguredThinkingDefault({
      cfg: params.cfg,
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
    });
  let thinkingCatalog = params.thinkingCatalog;
  if (
    params.pluginsEnabled &&
    (configuredThinkLevel !== "off" || agentRuntime !== "openclaw") &&
    needsThinkHydration(params.thinkingCatalog, params.provider, params.model, agentRuntime)
  ) {
    const { loadProviderScopedThinkingCatalog } = await import("../model-catalog.runtime.js");
    const runtimeCatalog = normalizeThinkingCatalogProviders(
      await loadProviderScopedThinkingCatalog({
        config: params.cfg,
        provider: params.provider,
        model: params.model,
        agentRuntime,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
      }),
    );
    if (findModelInCatalog(runtimeCatalog, params.provider, params.model)) {
      thinkingCatalog = createModelVisibilityPolicy({
        cfg: params.cfg,
        catalog: runtimeCatalog,
        defaultProvider: params.defaultProvider,
        defaultModel: { provider: params.defaultProvider, model: params.defaultModel },
        agentId: params.agentId,
        allowManifestNormalization: true,
        allowPluginNormalization: true,
        ...params.modelManifestContext,
      }).catalog;
    }
  }
  return {
    agentRuntime,
    thinkLevel: resolveThinkingSelection({
      cfg: params.cfg,
      agentId: params.agentId,
      provider: params.provider,
      model: params.model,
      level: configuredThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime,
    }).level,
    thinkingCatalog,
  };
}
