// Protects scoped synthetic credentials independently of stored-profile discovery.
import { fileURLToPath } from "node:url";
import "./model-auth.synthetic.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import type { RuntimeProviderAuthLookup } from "./model-auth-runtime.js";

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginRegistrySnapshotWithMetadata: () => {
    const rootDir = fileURLToPath(new URL("../../extensions/ollama/", import.meta.url));
    return {
      source: "derived",
      snapshot: {
        plugins: [
          {
            pluginId: "ollama",
            manifestPath: fileURLToPath(
              new URL("../../extensions/ollama/openclaw.plugin.json", import.meta.url),
            ),
            manifestHash: "ollama-model-auth-fixture",
            rootDir,
            origin: "bundled",
            enabled: true,
            startup: {
              sidecar: false,
              memory: false,
              agentHarnesses: [],
            },
            compat: [],
          },
        ],
      },
      diagnostics: [],
    };
  },
  loadPluginManifestRegistryForPluginRegistry: () => ({
    diagnostics: [],
    plugins: [
      {
        origin: "bundled",
        nonSecretAuthMarkers: ["gcp-vertex-credentials", "ollama-local"],
        setup: {
          providers: [{ id: "ollama", envVars: ["OLLAMA_API_KEY"] }],
        },
      },
    ],
  }),
}));

const {
  createRuntimeProviderAuthLookup,
  resolveApiKeyForProviderCore,
  hasRuntimeAvailableProviderAuth,
  prepareRuntimeAvailableProviderAuth,
} = await import("./model-auth.js");
const { prepareSyntheticLocalProviderAuth } = await import("./model-auth-runtime.js");
const providerRuntime = await import("../plugins/provider-runtime.js");
const { clearRuntimeConfigSnapshot } = await import("../config/config.js");
const { clearRuntimeAuthProfileStoreSnapshots } =
  await import("./auth-profiles/runtime-snapshots.js");
const { setActiveDegradedSecretOwners } = await import("../secrets/runtime-degraded-state.js");

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
});

describe("isolated synthetic provider auth", () => {
  // Regression for #110103: a gateway-isolated attempt disables auth-profile
  // fallback, but a provider whose only credential source is a plugin synthetic
  // -auth hook (GCP-ADC style) must still resolve. Before the fix the two
  // permissions were coupled, so allowAuthProfileFallback: false also silenced
  // the plugin hook and the gateway path failed with "No API key found".
  it("resolves plugin synthetic auth on an isolated attempt without profile fallback", async () => {
    const resolved = await resolveApiKeyForProviderCore({
      provider: "native-cli",
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "native-cli/demo-model",
            },
          },
        },
      },
      store: { version: 1, profiles: {} },
      // Gateway isolation: stored-profile discovery stays off, plugin synthetic
      // -auth stays on via its own decoupled flag.
      allowAuthProfileFallback: false,
      allowPluginSyntheticAuth: true,
    });

    expect(resolved).toEqual({
      apiKey: "native-cli-access-token",
      source: "Native CLI auth",
      mode: "oauth",
    });
  });

  // Back-compat guard for the same coupling: callers that disable profile
  // fallback without opting into plugin synthetic-auth keep the pre-existing
  // behavior, so only the isolated gateway path widens.
  it("keeps plugin synthetic auth off when fallback is off without the decoupled flag", async () => {
    await expect(
      resolveApiKeyForProviderCore({
        provider: "native-cli",
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "native-cli/demo-model",
              },
            },
          },
        },
        store: { version: 1, profiles: {} },
        allowAuthProfileFallback: false,
      }),
    ).rejects.toThrow('No API key found for provider "native-cli"');
  });

  // Companion to the regression above: enabling plugin synthetic-auth on a
  // gateway attempt must NOT re-open stored-profile discovery. A provider with
  // only a stored api-key profile stays unresolved when profile fallback is off,
  // even with allowPluginSyntheticAuth: true; it resolves once fallback is on.
  it("keeps stored-profile isolation when plugin synthetic auth is enabled but profile fallback is off", async () => {
    const store = {
      version: 1 as const,
      profiles: {
        "isolated-store:default": createApiKeyCredential(
          "isolated-store",
          "stored-isolated-fixture",
        ),
      },
    };

    await expect(
      resolveApiKeyForProviderCore({
        provider: "isolated-store",
        store,
        allowAuthProfileFallback: false,
        allowPluginSyntheticAuth: true,
      }),
    ).rejects.toThrow('No API key found for provider "isolated-store"');

    const resolvedWithFallback = await resolveApiKeyForProviderCore({
      provider: "isolated-store",
      store,
    });
    expect(resolvedWithFallback).toMatchObject({
      apiKey: "stored-isolated-fixture",
      source: "profile:isolated-store:default",
      mode: "api-key",
    });
  });

  // Gateway callers pass a prepared RuntimeProviderAuthLookup instead of a
  // public eligibility helper. Matching refs keep synthetic auth; other refs
  // stay on env/config resolution.
  it("scopes gateway plugin synthetic auth through prepared runtimeLookup refs", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "native-cli/demo-model",
          },
        },
      },
    };

    const resolved = await resolveApiKeyForProviderCore({
      provider: "native-cli",
      cfg,
      store: { version: 1, profiles: {} },
      allowAuthProfileFallback: false,
      allowPluginSyntheticAuth: true,
      runtimeLookup: {
        envApiKey: { skipSetupProviderFallback: true },
        syntheticAuthProviderRefs: ["native-cli"],
        syntheticAuthProviderRefsComplete: true,
      },
    });
    expect(resolved).toEqual({
      apiKey: "native-cli-access-token",
      source: "Native CLI auth",
      mode: "oauth",
    });

    await expect(
      resolveApiKeyForProviderCore({
        provider: "native-cli",
        cfg,
        store: { version: 1, profiles: {} },
        allowAuthProfileFallback: false,
        allowPluginSyntheticAuth: true,
        runtimeLookup: {
          envApiKey: { skipSetupProviderFallback: true },
          syntheticAuthProviderRefs: ["anthropic-vertex"],
          syntheticAuthProviderRefsComplete: true,
        },
      }),
    ).rejects.toThrow('No API key found for provider "native-cli"');
  });

  it("fails closed when a prepared plugin lookup is incomplete", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "native-cli/demo-model",
          },
        },
      },
    };

    await expect(
      resolveApiKeyForProviderCore({
        provider: "native-cli",
        cfg,
        store: { version: 1, profiles: {} },
        allowAuthProfileFallback: false,
        allowPluginSyntheticAuth: true,
        runtimeLookup: {
          envApiKey: { skipSetupProviderFallback: true },
          syntheticAuthProviderRefsComplete: false,
        },
      }),
    ).rejects.toThrow('No API key found for provider "native-cli"');

    await expect(
      resolveApiKeyForProviderCore({
        provider: "native-cli",
        cfg,
        store: { version: 1, profiles: {} },
        allowAuthProfileFallback: false,
        allowPluginSyntheticAuth: true,
        runtimeLookup: createRuntimeProviderAuthLookup({
          includePluginSyntheticAuth: false,
          env: {},
        }),
      }),
    ).rejects.toThrow('No API key found for provider "native-cli"');
  });
});

const pluginConfig = {
  plugins: {
    entries: {
      "plugin-web": { enabled: true, config: { webSearch: { apiKey: "plugin-fixture" } } },
    },
  },
};
const scopedLookup = (scope: Partial<RuntimeProviderAuthLookup>): RuntimeProviderAuthLookup => ({
  envApiKey: {
    aliasMap: {},
    candidateMap: {},
    authEvidenceMap: {},
    skipSetupProviderFallback: true,
  },
  ...scope,
});

describe("prepared synthetic-auth readiness", () => {
  it.each([
    { name: "missing refs", scope: {} },
    { name: "missing completeness", scope: { syntheticAuthProviderRefs: ["plugin-web"] } },
    {
      name: "incomplete refs",
      scope: {
        syntheticAuthProviderRefs: ["plugin-web"],
        syntheticAuthProviderRefsComplete: false,
      },
    },
    {
      name: "empty refs",
      scope: { syntheticAuthProviderRefs: [], syntheticAuthProviderRefsComplete: true },
    },
    {
      name: "another provider",
      scope: { syntheticAuthProviderRefs: ["unrelated"], syntheticAuthProviderRefsComplete: true },
    },
  ])("rejects $name before invoking either plugin hook", async ({ scope }) => {
    const prepare = vi.spyOn(providerRuntime, "prepareProviderSyntheticAuthWithPlugin");
    const resolve = vi.spyOn(providerRuntime, "resolveProviderSyntheticAuthWithPlugin");
    const params = {
      provider: "plugin-web",
      cfg: pluginConfig,
      env: {},
      runtimeLookup: scopedLookup(scope),
    };
    expect(hasRuntimeAvailableProviderAuth(params)).toBe(false);
    await expect(prepareRuntimeAvailableProviderAuth(params)).resolves.toBe(false);
    await expect(prepareSyntheticLocalProviderAuth(params)).resolves.toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["plugin-web", "plugin-api"])(
    "allows the prepared %s ref in both readiness paths",
    async (ref) => {
      const params = {
        provider: "plugin-web",
        modelApi: "plugin-api",
        cfg: pluginConfig,
        env: {},
        runtimeLookup: scopedLookup({
          syntheticAuthProviderRefs: [ref],
          syntheticAuthProviderRefsComplete: true,
        }),
      };
      expect(hasRuntimeAvailableProviderAuth(params)).toBe(true);
      await expect(prepareRuntimeAvailableProviderAuth(params)).resolves.toBe(true);
    },
  );

  it("preserves unrestricted ordinary readiness only when no lookup was supplied", async () => {
    const params = { provider: "plugin-web", cfg: pluginConfig, env: {} };
    expect(hasRuntimeAvailableProviderAuth(params)).toBe(true);
    await expect(prepareRuntimeAvailableProviderAuth(params)).resolves.toBe(true);
  });

  it("forwards the cancellation signal and preserves the provider rejection", async () => {
    const controller = new AbortController();
    const reason = new Error("synthetic auth cancelled");
    let capturedSignal: AbortSignal | undefined;
    const prepare = vi
      .spyOn(providerRuntime, "prepareProviderSyntheticAuthWithPlugin")
      .mockImplementationOnce(async (params) => {
        capturedSignal = params.signal;
        controller.abort(reason);
        throw reason;
      });
    await expect(
      prepareRuntimeAvailableProviderAuth({
        provider: "plugin-web",
        cfg: pluginConfig,
        env: {},
        signal: controller.signal,
        runtimeLookup: scopedLookup({
          syntheticAuthProviderRefs: ["plugin-web"],
          syntheticAuthProviderRefsComplete: true,
        }),
      }),
    ).rejects.toBe(reason);
    expect(capturedSignal).toBe(controller.signal);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("consumes a completed absent result without retrying the synchronous hook", async () => {
    const prepare = vi
      .spyOn(providerRuntime, "prepareProviderSyntheticAuthWithPlugin")
      .mockResolvedValueOnce(undefined);
    const resolve = vi.spyOn(providerRuntime, "resolveProviderSyntheticAuthWithPlugin");
    await expect(
      prepareSyntheticLocalProviderAuth({
        provider: "plugin-web",
        cfg: pluginConfig,
        env: {},
        runtimeLookup: scopedLookup({
          syntheticAuthProviderRefs: ["plugin-web"],
          syntheticAuthProviderRefsComplete: true,
        }),
      }),
    ).resolves.toBeNull();
    expect(prepare).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
  });
});
