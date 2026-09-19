import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { ActiveMemoryEscalationProvider } from "./registry-contribution-types.js";
import { requireActivePluginRegistry } from "./runtime.js";

/** Resolves a provider from the active plugin generation. */
export function getActiveMemoryEscalationProvider(
  id: string,
): ActiveMemoryEscalationProvider | undefined {
  const normalizedId = normalizeOptionalString(id);
  if (!normalizedId) {
    return undefined;
  }
  const registry = requireActivePluginRegistry();
  const registration = registry.activeMemoryEscalationProviders.get(normalizedId);
  if (!registration) {
    return undefined;
  }
  const record = registry.plugins.find((entry) => entry.id === registration.pluginId);
  const instance = record && getPluginInstance(record);
  return instance?.wrap(registration.provider) ?? registration.provider;
}
