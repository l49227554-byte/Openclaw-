/** Shared helpers for plugin status tests and installed-index fixture setup. */
import path from "node:path";
import { extractErrorCode, readErrorName } from "@openclaw/normalization-core/error-coercion";
import type { PluginRecord } from "./registry.js";
export function createPluginRecord(
  overrides: Partial<PluginRecord> & Pick<PluginRecord, "id">,
): PluginRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    name: overrides.name ?? id,
    description: overrides.description ?? "",
    source: overrides.source ?? `/tmp/${id}/index.ts`,
    origin: overrides.origin ?? "workspace",
    enabled: overrides.enabled ?? true,
    explicitlyEnabled: overrides.explicitlyEnabled ?? overrides.enabled ?? true,
    activated: overrides.activated ?? overrides.enabled ?? true,
    activationSource:
      overrides.activationSource ?? ((overrides.enabled ?? true) ? "explicit" : "disabled"),
    activationReason: overrides.activationReason,
    status: overrides.status ?? "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    contextEngineIds: [],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
    ...rest,
  };
}

export function summarizeClassifierErrors(errors: readonly unknown[]) {
  const errorNames = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "AggregateError",
    "StartupMaintenanceRequiredError",
    "SqliteCoordinatorError",
    "OpenClawStateOwnershipMetadataError",
    "OpenClawStateExternalOwnershipError",
  ]);
  const errorCodes = new Set([
    "EACCES",
    "ENOENT",
    "EBUSY",
    "ERR_SQLITE_ERROR",
    "SQLITE_BUSY",
    "SQLITE_LOCKED",
    "PLUGIN_CACHE_FACT_INVALIDATED",
    "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    "gateway.maintenance_required",
  ]);
  const repositoryPrefix = `${path.resolve(import.meta.dirname, "../..")}${path.sep}`;
  return errors.slice(0, 10).map((failure) => {
    const errorName = readErrorName(failure);
    const code = extractErrorCode(failure);
    return {
      name: errorNames.has(errorName) ? errorName : "<other name>",
      code: code && errorCodes.has(code) ? code : "<other or absent code>",
      sourceFrames:
        failure instanceof Error
          ? (failure.stack ?? "")
              .split("\n")
              .filter((line) => /^\s+at /.test(line))
              .flatMap((line) => {
                const offset = line.indexOf(repositoryPrefix);
                const frame = offset < 0 ? "" : line.slice(offset + repositoryPrefix.length);
                const source = frame.match(
                  /^(?:src|packages|extensions)\/[A-Za-z0-9_./-]+\.(?:ts|js|mts|mjs):\d+:\d+(?=\)?$)/,
                );
                return source ? [source[0]] : [];
              })
              .slice(0, 4)
          : [],
    };
  });
}
