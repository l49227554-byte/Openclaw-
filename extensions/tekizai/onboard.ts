// TEKIZAI onboarding applies the provider connection and default model preset.
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  buildTekizaiModelDefinition,
  TEKIZAI_BASE_URL,
  TEKIZAI_DEFAULT_MODEL_REF,
  TEKIZAI_MODEL_CATALOG,
} from "./models.js";

export { TEKIZAI_DEFAULT_MODEL_REF };

const tekizaiPreset = {
  primaryModelRef: TEKIZAI_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "tekizai",
    api: "openai-responses",
    baseUrl: TEKIZAI_BASE_URL,
    catalogModels: () => TEKIZAI_MODEL_CATALOG.map(buildTekizaiModelDefinition),
    aliases: [{ modelRef: TEKIZAI_DEFAULT_MODEL_REF, alias: "TEKIZAI Auto" }],
  }),
} satisfies Parameters<typeof createProviderConnectionPresetAppliers<[]>>[0];

export const { applyConfig: applyTekizaiConnectionConfig } =
  createProviderConnectionPresetAppliers(tekizaiPreset);
