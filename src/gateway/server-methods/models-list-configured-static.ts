import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import { resolveModelCatalogIdentityKey } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

/** Configured dynamic-catalog providers that omit explicit model inventory. */
export function listConfiguredRuntimeDiscoveryProviderIds(
  cfg: OpenClawConfig,
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">,
): Set<string> {
  const ids = new Set<string>();
  const providers = cfg.models?.providers;
  if (!providers || typeof providers !== "object" || !metadataSnapshot) {
    return ids;
  }
  const dynamicProviders = new Set<string>();
  for (const plugin of metadataSnapshot.plugins) {
    for (const [providerRaw, mode] of Object.entries(plugin.modelCatalog?.discovery ?? {})) {
      const providerId = normalizeProviderId(providerRaw);
      if (providerId && (mode === "runtime" || mode === "refreshable")) {
        dynamicProviders.add(providerId);
      }
    }
  }
  for (const [providerRaw, provider] of Object.entries(providers)) {
    const providerId = normalizeProviderId(providerRaw);
    if (providerId && dynamicProviders.has(providerId) && !Array.isArray(provider?.models)) {
      ids.add(providerId);
    }
  }
  return ids;
}

export function includeConfiguredStaticCatalogEntries(params: {
  cfg: OpenClawConfig;
  agentId: string;
  snapshot: ModelCatalogSnapshot;
  defaultModel?: string;
  metadataSnapshot: PluginMetadataSnapshot;
  enabled: boolean;
}): ModelCatalogEntry[] {
  if (!params.enabled || !params.snapshot.staticEntries?.length) {
    return [...params.snapshot.entries];
  }
  const policy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog: [...params.snapshot.entries],
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: params.metadataSnapshot,
  });
  const configuredKeys = new Set(
    [...policy.configuredKeys].map((key) => {
      const separator = key.indexOf("/");
      return separator > 0
        ? resolveModelCatalogIdentityKey({
            provider: key.slice(0, separator),
            id: key.slice(separator + 1),
          })
        : key;
    }),
  );
  const catalog = [...params.snapshot.entries];
  const seen = new Set(catalog.map(resolveModelCatalogIdentityKey));
  for (const entry of params.snapshot.staticEntries) {
    const key = resolveModelCatalogIdentityKey(entry);
    if (!seen.has(key) && configuredKeys.has(key)) {
      seen.add(key);
      catalog.push(entry);
    }
  }
  return catalog;
}
