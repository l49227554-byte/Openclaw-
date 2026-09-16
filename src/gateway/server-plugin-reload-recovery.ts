import type { PluginRuntimeRecovery } from "../plugins/loader-types.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { capturePluginRuntimeRecovery } from "../plugins/plugin-runtime-artifact-binding.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";

/** Owns one operation's old source, excluding runtimes retired before it began. */
export function createPluginReloadRecovery(
  previousRegistry: PluginRegistry,
  preparePlugins: typeof prepareGatewayPluginLoad,
) {
  const moduleRecoveries = new Map<string, PluginRuntimeRecovery>();
  const previouslyRetiredIds = new Set(
    previousRegistry.plugins
      .filter((record) => getPluginInstance(record)?.disposing)
      .map((record) => record.id),
  );
  const previousHookIds = new Set<string>();
  return {
    get previousHookIds(): ReadonlySet<string> {
      return previousHookIds;
    },
    capture(pluginIds: ReadonlySet<string>) {
      for (const record of previousRegistry.plugins) {
        if (pluginIds.has(record.id) && !previouslyRetiredIds.has(record.id)) {
          previousHookIds.add(record.id);
          const recovery = capturePluginRuntimeRecovery(record);
          if (recovery) {
            moduleRecoveries.set(record.id, recovery);
          }
        }
      }
    },
    prepare(
      params: Omit<Parameters<typeof preparePlugins>[0], "pluginIds" | "moduleRecoveries">,
      cause: unknown,
    ) {
      const recoveryParams = {
        ...params,
        // Earlier failures already released these snapshots. Restore the healthy
        // subset without pretending current disk bytes are the retired code.
        pluginIds: previousRegistry.plugins
          .filter((record) => !previouslyRetiredIds.has(record.id))
          .map((record) => record.id),
        moduleRecoveries,
      };
      if (previouslyRetiredIds.size) {
        const plan = preparePlugins({ ...recoveryParams, loadModules: false });
        plan.retireGatewayRuntimeBindings();
        // The loader can add dependencies outside the requested scope. Validate
        // its actual plan before any unavailable owner could run from disk.
        const unavailable = plan.pluginRegistry.plugins.filter(
          (record) =>
            previouslyRetiredIds.has(record.id) && record.enabled && record.status === "loaded",
        );
        if (unavailable.length) {
          throw new Error(
            `Plugin recovery requires previously retired runtimes without captured source: ${unavailable.map((record) => record.id).join(", ")}`,
            { cause },
          );
        }
      }
      return preparePlugins(recoveryParams);
    },
    dispose() {
      for (const recovery of moduleRecoveries.values()) {
        recovery.module.dispose();
      }
      moduleRecoveries.clear();
    },
  };
}
