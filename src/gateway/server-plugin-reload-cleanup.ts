import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import { createHookRunner } from "../plugins/hooks.js";
import { withPluginHostCleanupTimeout } from "../plugins/host-hook-cleanup-timeout.js";
import type { PluginHostCleanupResult } from "../plugins/host-hook-cleanup.types.js";
import { withPluginHttpRouteRegistry } from "../plugins/http-registry.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  type PluginServicesHandle,
} from "../plugins/services.js";

/** Owns resource handoff and rejected-registration cleanup for one reload transaction. */
export function createPluginReloadCleanup({
  previousRegistry,
  changedPluginIds,
  port,
  pluginWorkspaceDir,
  getCron,
  log,
  recordCleanup,
}: {
  previousRegistry: PluginRegistry;
  changedPluginIds: ReadonlySet<string>;
  port: number;
  pluginWorkspaceDir: string | undefined;
  getCron: () => PluginHookGatewayCronService;
  log: ReturnType<typeof createSubsystemLogger>;
  recordCleanup: (result: PluginHostCleanupResult) => void;
}) {
  const attempt = async (errors: unknown[], run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  const drainInstances = async (
    registry: PluginRegistry,
    pluginIds: ReadonlySet<string>,
    includeConsumers = true,
  ) => {
    for (const record of registry.plugins) {
      if (!pluginIds.has(record.id)) {
        continue;
      }
      const result = await withPluginHostCleanupTimeout(`plugin ${record.id} admitted work`, () =>
        getPluginInstance(record)?.drain({ includeConsumers }),
      );
      if (result?.errors.length) {
        throw new AggregateError(result.errors, `Plugin ${record.id} work did not drain`);
      }
    }
  };
  const disposeInstances = async (registry: PluginRegistry, pluginIds: ReadonlySet<string>) => {
    const failures: unknown[] = [];
    for (const record of registry.plugins) {
      if (!pluginIds.has(record.id)) {
        continue;
      }
      await attempt(failures, async () => {
        const result = await withPluginHostCleanupTimeout(`plugin ${record.id} resources`, () =>
          getPluginInstance(record)?.dispose(),
        );
        failures.push(...(result?.errors ?? []));
      });
    }
    if (failures.length) {
      throw new AggregateError(failures, "Plugin resource cleanup failed");
    }
  };
  const runLifecycleHooks = async (
    registry: PluginRegistry,
    start: boolean,
    config: OpenClawConfig,
  ) => {
    const hooks = createHookRunner(
      {
        ...registry,
        typedHooks: registry.typedHooks.filter((hook) => changedPluginIds.has(hook.pluginId)),
      },
      {
        logger: log,
        catchErrors: false,
        voidHookTimeoutMsByHook: {
          gateway_start: PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
          gateway_stop: PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        },
      },
    );
    const context = {
      port,
      config,
      workspaceDir: pluginWorkspaceDir,
      getCron,
    };
    await withPluginHttpRouteRegistry(registry, () =>
      start
        ? hooks.runGatewayStart({ port }, context)
        : hooks.runGatewayStop({ reason: "plugin replacement" }, context),
    );
  };
  const prepareRegistrationFailureCleanup =
    (config: OpenClawConfig) =>
    (registry: PluginRegistry, record: PluginRegistry["plugins"][number]) => {
      const stopHooks = registry.typedHooks.filter(
        (hook) => hook.pluginId === record.id && hook.hookName === "gateway_stop",
      );
      if (stopHooks.length) {
        // Failed contributions disappear synchronously; declared cleanup remains with
        // the instance until its asynchronous disposal settles.
        const cleanupRegistry = { ...registry, typedHooks: stopHooks };
        getPluginInstance(record)?.lifecycle.onDispose(() =>
          runLifecycleHooks(cleanupRegistry, false, config),
        );
      }
    };
  const retireUnpublished = async (
    registry: PluginRegistry,
    config: OpenClawConfig,
    services: PluginServicesHandle | undefined,
  ) => {
    const errors: unknown[] = [];
    for (const record of registry.plugins) {
      if (!previousRegistry.plugins.includes(record)) {
        // Disposal joins admitted consumers before running the legacy stop hook,
        // including when the caller's bounded cleanup observation times out.
        prepareRegistrationFailureCleanup(config)(registry, record);
        getPluginInstance(record)?.quiesce();
      }
    }
    await attempt(errors, async () => {
      await services?.stop({
        strict: true,
        deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        pluginIds: changedPluginIds,
      });
    });
    await attempt(errors, async () => {
      const result = await withPluginHostCleanupTimeout("unpublished plugin resources", () =>
        disposePluginRegistryInstances(registry, previousRegistry),
      );
      recordCleanup(result);
      errors.push(...result.failures.map((entry) => entry.error));
    });
    if (errors.length) {
      throw new AggregateError(errors, "Unpublished plugin resource cleanup failed");
    }
  };
  return {
    drainInstances,
    disposeInstances,
    runLifecycleHooks,
    prepareRegistrationFailureCleanup,
    retireUnpublished,
  };
}

/** Keeps cleanup warnings bounded in receipts while retaining full diagnostic logs. */
export function createPluginReloadDiagnostics(log: ReturnType<typeof createSubsystemLogger>) {
  const warnings = new Set<string>();
  const recordWarning = (warning: string) => {
    // Keep tool/RPC results bounded; complete cleanup diagnostics remain in the log.
    if (warnings.size < 8) {
      warnings.add(truncateUtf16Safe(warning, 240));
    } else {
      warnings.add("Additional plugin cleanup warnings were recorded in the Gateway log.");
    }
  };
  const recordCleanup = (result: PluginHostCleanupResult) => {
    for (const pluginId of result.deferredPluginIds ?? []) {
      const warning = `Plugin ${pluginId} cleanup is deferred until its admitted work finishes.`;
      log.info(warning);
      recordWarning(warning);
    }
    for (const failure of result.failures) {
      recordWarning(
        `Plugin ${failure.pluginId} cleanup failed (${failure.hookId}): ${formatErrorMessage(failure.error)}`,
      );
    }
  };
  const cleanup = async (label: string, run: () => void | Promise<void>) => {
    try {
      await run();
    } catch (error) {
      const warning = `${label}: ${formatErrorMessage(error)}`;
      log.warn(warning);
      recordWarning(warning);
    }
  };
  return { warnings, recordWarning, recordCleanup, cleanup };
}
