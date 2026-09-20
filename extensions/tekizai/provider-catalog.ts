// TEKIZAI provider catalog supplies the fixed routing-profile catalog.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildTekizaiModelDefinition, TEKIZAI_BASE_URL, TEKIZAI_MODEL_CATALOG } from "./models.js";

export function buildTekizaiProvider(): ModelProviderConfig {
  return {
    baseUrl: TEKIZAI_BASE_URL,
    api: "openai-responses",
    models: TEKIZAI_MODEL_CATALOG.map(buildTekizaiModelDefinition),
  };
}
