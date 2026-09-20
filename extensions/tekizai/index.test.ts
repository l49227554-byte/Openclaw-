import {
  createRuntimeEnv,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import tekizaiPlugin from "./index.js";

describe("TEKIZAI provider plugin", () => {
  it("registers API-key onboarding and a Responses catalog", async () => {
    const provider = await registerSingleProviderPlugin(tekizaiPlugin);
    expect(provider.envVars).toEqual(["TEKIZAI_API_KEY"]);
    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "tekizai-api-key",
    });
    expect(choice?.method.id).toBe("api-key");
    const catalog = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });
    expect(catalog).toMatchObject({
      provider: {
        baseUrl: "https://api.tekiz.ai/v1",
        api: "openai-responses",
        models: [{ id: "auto" }, { id: "frontier" }, { id: "fusion" }],
      },
    });
  });

  it("resolves the catalog only when credentials are available", async () => {
    const provider = await registerSingleProviderPlugin(tekizaiPlugin);
    const context = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        mode: "none" as const,
        source: "none" as const,
      }),
    };
    expect(await provider.catalog?.run(context)).toBeNull();
    expect(
      await provider.catalog?.run({
        ...context,
        resolveProviderApiKey: () => ({ apiKey: "test-tekizai-key" }),
      }),
    ).toMatchObject({
      provider: {
        apiKey: "test-tekizai-key",
        api: "openai-responses",
        models: [{ id: "auto" }, { id: "frontier" }, { id: "fusion" }],
      },
    });
  });

  it.each([
    { mode: "merge" as const, modelIds: [] },
    { mode: "replace" as const, modelIds: ["auto", "frontier", "fusion"] },
  ])("onboards with catalog ownership in $mode mode", async ({ mode, modelIds }) => {
    const provider = await registerSingleProviderPlugin(tekizaiPlugin);
    const method = provider.auth.find((entry) => entry.id === "api-key");
    if (!method?.runNonInteractive) {
      throw new Error("Missing registered API-key onboarding");
    }
    const config: OpenClawConfig = { models: { mode } };
    const result = await method.runNonInteractive({
      authChoice: "tekizai-api-key",
      config,
      baseConfig: config,
      opts: {},
      runtime: createRuntimeEnv(),
      resolveApiKey: async () => ({ key: "test-tekizai-key", source: "profile" }),
      toApiKeyCredential: () => null,
    });
    expect(result?.models?.providers?.tekizai).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.tekiz.ai/v1",
    });
    expect(result?.models?.providers?.tekizai?.models.map((model) => model.id)).toEqual(modelIds);
    expect(result?.agents?.defaults?.model).toEqual({ primary: "tekizai/auto" });
    expect(result?.auth?.profiles?.["tekizai:default"]).toEqual({
      provider: "tekizai",
      mode: "api_key",
    });
    expect(config).toEqual({ models: { mode } });
  });
});
