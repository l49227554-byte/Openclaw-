import type { OpenClawConfig } from "../config/types.js";
import {
  normalizePluginId,
  normalizePluginsConfig,
  resolveEnableState,
  resolveSelectedContextEnginePluginIdFromConfig,
} from "../plugins/config-state.js";
import type { ContextEngineRegistration } from "../plugins/registry-contribution-types.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { pluginIdFromContextEngineOwner } from "./registry-adoption.js";

/** Applies canonical plugin policy to a registered engine without changing its engine ID. */
export function resolveEffectiveContextEngineId(
  config: OpenClawConfig | undefined,
  entries: ReadonlyMap<string, ContextEngineRegistration>,
): string {
  const plugins = normalizePluginsConfig(config?.plugins);
  const engineId = plugins.slots.contextEngine;
  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  if (!engineId || engineId === defaultEngineId) {
    return defaultEngineId;
  }
  const entry = entries.get(engineId);
  const pluginId = entry && pluginIdFromContextEngineOwner(entry.owner);
  if (pluginId) {
    // Runtime registration supplies ownership without rediscovering plugin manifests.
    // Preserve the selector so a distinct owner still requires independent approval.
    return resolveSelectedContextEnginePluginIdFromConfig(plugins, engineId, [
      { id: pluginId, contextEngineIds: [engineId] },
    ])
      ? engineId
      : defaultEngineId;
  }
  // Without a plugin owner, apply equal-ID policy to the configured candidate only.
  // Do not invent discovery metadata or suppress an enabled missing-engine diagnostic.
  const candidateId = normalizePluginId(engineId);
  return resolveEnableState(candidateId, "config", {
    ...plugins,
    contextEngineOwnerId: candidateId,
  }).enabled
    ? engineId
    : defaultEngineId;
}
