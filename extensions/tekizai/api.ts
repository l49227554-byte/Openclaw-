// TEKIZAI API module exposes the plugin public contract.
export { applyTekizaiConnectionConfig } from "./onboard.js";
export {
  buildTekizaiModelDefinition,
  TEKIZAI_BASE_URL,
  TEKIZAI_DEFAULT_MODEL_ID,
  TEKIZAI_DEFAULT_MODEL_REF,
  TEKIZAI_MODEL_CATALOG,
} from "./models.js";
export { buildTekizaiProvider } from "./provider-catalog.js";
