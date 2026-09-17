import { vi } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";

vi.mock("../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: () => [
    {
      pluginDir: "/bundled/anthropic-vertex",
      origin: "bundled",
      manifest: {
        id: "anthropic-vertex",
        nonSecretAuthMarkers: ["gcp-vertex-credentials"],
      },
    },
  ],
}));

vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider: () => [],
  resolveOwningPluginIdsForProviderRef: () => [],
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: () => undefined,
}));

vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

vi.mock("../plugins/provider-runtime.js", () => {
  const nativeAuth = {
    apiKey: "native-cli-access-token",
    source: "Native CLI auth",
    mode: "oauth" as const,
  };
  const providerRuntime = {
    buildProviderMissingAuthMessageWithPlugin: () => undefined,
    resolveProviderDeprecatedAuthProfileIds: () => [],
    prepareProviderExternalAuthWithPlugin: async (params: { provider: string }) =>
      params.provider === "native-cli" ? nativeAuth : undefined,
    shouldDeferProviderSyntheticProfileAuthWithPlugin: (params: {
      context?: { resolvedApiKey?: string };
    }) => params.context?.resolvedApiKey === "synthetic-defer",
    // Synthetic auth is provider-owned. Tests model local/no-key and plugin
    // config credentials without depending on real plugins.
    resolveProviderSyntheticAuthWithPlugin: (params: {
      provider: string;
      config?: {
        plugins?: {
          enabled?: boolean;
          entries?: Record<
            string,
            {
              enabled?: boolean;
              config?: {
                webSearch?: {
                  apiKey?: unknown;
                };
              };
            }
          >;
        };
        tools?: {
          web?: {
            search?: {
              grok?: {
                apiKey?: unknown;
              };
            };
          };
        };
      };
      modelApi?: string;
      context: { providerConfig?: { api?: string; baseUrl?: string; models?: unknown[] } };
    }) => {
      if (params.provider === "plugin-web") {
        if (
          params.config?.plugins?.enabled === false ||
          params.config?.plugins?.entries?.["plugin-web"]?.enabled === false
        ) {
          return undefined;
        }
        const pluginApiKey =
          params.config?.plugins?.entries?.["plugin-web"]?.config?.webSearch?.apiKey;
        if (typeof pluginApiKey === "string" && pluginApiKey.trim()) {
          return {
            apiKey: pluginApiKey.trim(),
            source: "plugins.entries.plugin-web.config.webSearch.apiKey",
            mode: "api-key" as const,
          };
        }
        if (pluginApiKey && typeof pluginApiKey === "object") {
          return {
            apiKey: NON_ENV_SECRETREF_MARKER,
            source: "plugins.entries.plugin-web.config.webSearch.apiKey",
            mode: "api-key" as const,
          };
        }
        return undefined;
      }
      const effectiveApi = params.modelApi ?? params.context.providerConfig?.api;
      if (
        effectiveApi === "ollama" &&
        (params.context.providerConfig?.baseUrl?.startsWith("http://192.168.") ||
          params.modelApi === "ollama")
      ) {
        return {
          apiKey: "ollama-local",
          source: `models.providers.${params.provider} (synthetic local key)`,
          mode: "api-key" as const,
        };
      }
      return undefined;
    },
  };
  return {
    ...providerRuntime,
    prepareProviderSyntheticAuthWithPlugin: async (
      params: Parameters<typeof providerRuntime.resolveProviderSyntheticAuthWithPlugin>[0],
    ) =>
      (await providerRuntime.prepareProviderExternalAuthWithPlugin(params)) ??
      providerRuntime.resolveProviderSyntheticAuthWithPlugin(params),
  };
});
