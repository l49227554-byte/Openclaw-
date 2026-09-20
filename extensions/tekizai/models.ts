// TEKIZAI model catalog defines the stable routing profiles exposed to OpenClaw.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const TEKIZAI_BASE_URL = "https://api.tekiz.ai/v1";
export const TEKIZAI_DEFAULT_MODEL_ID = "auto";
export const TEKIZAI_DEFAULT_MODEL_REF = `tekizai/${TEKIZAI_DEFAULT_MODEL_ID}`;

const TEKIZAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// Routing profiles can select different upstream models. Use a conservative
// completion budget rather than treating the context window as an output limit.
const TEKIZAI_DEFAULT_MAX_TOKENS = 4096;

export const TEKIZAI_MODEL_CATALOG = [
  {
    id: "auto",
    name: "TEKIZAI Auto",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: TEKIZAI_DEFAULT_MAX_TOKENS,
  },
  {
    id: "frontier",
    name: "TEKIZAI Frontier",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: TEKIZAI_DEFAULT_MAX_TOKENS,
  },
  {
    id: "fusion",
    name: "TEKIZAI Fusion",
    reasoning: true,
    input: ["text"],
    contextWindow: 262144,
    maxTokens: TEKIZAI_DEFAULT_MAX_TOKENS,
  },
] as const;

type TekizaiCatalogEntry = (typeof TEKIZAI_MODEL_CATALOG)[number];

export function buildTekizaiModelDefinition(entry: TekizaiCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: { ...TEKIZAI_DEFAULT_COST },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
