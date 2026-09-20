// TEKIZAI plugin entrypoint registers the OpenAI Responses integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyTekizaiConnectionConfig, TEKIZAI_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildTekizaiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "tekizai";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "TEKIZAI Provider",
  description: "Bundled TEKIZAI provider plugin",
  manifest,
  provider: {
    label: "TEKIZAI",
    docsPath: "/providers/tekizai",
    manifestAuth: {
      defaultModel: TEKIZAI_DEFAULT_MODEL_REF,
      applyConfig: applyTekizaiConnectionConfig,
    },
    catalog: {
      buildProvider: buildTekizaiProvider,
      buildStaticProvider: buildTekizaiProvider,
      allowExplicitBaseUrl: true,
    },
  },
});
