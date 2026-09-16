import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import { modelKey } from "./model-ref-shared.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import { resolveProviderModelMaterializationAuthMode } from "./provider-model-route-auth.js";

/** Bind runtime selection and its commit check to the current published model owner. */
export async function preparePublishedModelRuntimeChoice(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  runtimeId: string;
  sessionEntry?: Pick<
    SessionEntry,
    "authProfileOverride" | "authProfileOverrideSource" | "providerOverride" | "modelProvider"
  >;
}): Promise<
  { kind: "unavailable"; message: string } | { kind: "ready"; validate: () => string | undefined }
> {
  const { getPublishedPreparedModelCatalogOwnerSnapshot, materializePreparedModelCatalogOwner } =
    await import("./prepared-model-catalog.js");
  const { getPreparedModelRuntimeAuthStore } = await import("./prepared-model-runtime-auth.js");
  const { createModelCatalogDecisions } = await import("./model-catalog-decisions.js");
  const published = getPublishedPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
  });
  const unavailable = `Runtime "${params.runtimeId}" is not available for ${params.provider}/${params.model}. Refresh the model catalog and choose again.`;
  if (!published) {
    return { kind: "unavailable", message: unavailable };
  }
  const owner = materializePreparedModelCatalogOwner(published);
  const authStore = getPreparedModelRuntimeAuthStore(owner);
  if (!authStore) {
    return { kind: "unavailable", message: unavailable };
  }
  const decisions = createModelCatalogDecisions({
    cfg: owner.config,
    agentId: owner.agentId ?? params.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    snapshot: owner.modelCatalog,
    metadataSnapshot: owner.metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: owner.authModes,
    pluginRegistry: owner.pluginRegistry,
    observationConfig: owner.observationConfig,
    isCurrent: owner.isCurrent,
    preferredProfileId: params.sessionEntry?.authProfileOverride,
    pinnedProfileId:
      params.sessionEntry?.authProfileOverrideSource === "user"
        ? params.sessionEntry.authProfileOverride
        : undefined,
    profileProvider: params.sessionEntry?.providerOverride ?? params.sessionEntry?.modelProvider,
  });
  // A provider can publish two literal rows that share one display key (ids `m`
  // and `p/m` both render as `p/m`), so the requested row is resolved by catalog
  // identity before the display key matches an alias of a sibling row.
  let entry =
    findModelInCatalog(decisions.snapshot.entries, params.provider, params.model) ??
    decisions.snapshot.entries.find(
      (row) => modelKey(row.provider, row.id) === modelKey(params.provider, params.model),
    );
  if (!entry) {
    // Explicit selections may be outside finite browse inventory. The normal
    // resolver still owns the requested model's provider and physical route.
    const { resolveModelAsync } = await import("./embedded-agent-runner/model.js");
    const { modelCatalogRowToEntry } = await import("./model-catalog-entry.js");
    const selectedAuth = await decisions.evaluateEntry(
      { provider: params.provider, id: params.model },
      undefined,
      params.runtimeId,
    );
    const authProfileMode = resolveProviderModelMaterializationAuthMode(
      selectedAuth.selectedAuthMode,
    );
    if (selectedAuth.availability !== true || !authProfileMode) {
      return { kind: "unavailable", message: unavailable };
    }
    const resolved = await resolveModelAsync(
      params.provider,
      params.model,
      owner.agentDir,
      owner.config,
      {
        agentId: owner.agentId ?? params.agentId,
        workspaceDir: owner.workspaceDir,
        preparedModelRuntime: owner,
        agentRuntimeId: params.runtimeId,
        allowBundledStaticCatalogFallback: true,
        // Discovery must retain the prepared account instead of rereading live auth stores.
        authProfileMode,
        ...(selectedAuth.selectedProfileId
          ? { authProfileId: selectedAuth.selectedProfileId }
          : {}),
      },
    );
    if (!resolved.model) {
      return { kind: "unavailable", message: unavailable };
    }
    entry = modelCatalogRowToEntry(resolved.model);
  }
  // Route variants are published under the same identity key as their entry, so
  // a sibling row's runtimes stay out of the selected row's candidate set.
  const variantKeyOf = createModelCatalogIdentityKeyResolver();
  const entryKey = variantKeyOf(entry);
  const variants = decisions.snapshot.routeVariants.filter((row) => variantKeyOf(row) === entryKey);
  const choices = await decisions.runtimeChoices(entry, variants.length ? variants : [entry]);
  if (!choices?.includes(params.runtimeId)) {
    return { kind: "unavailable", message: unavailable };
  }
  const host = await decisions.evaluateEntry(
    entry,
    variants.length ? variants : [entry],
    params.runtimeId,
  );
  const validate = () =>
    decisions.isCurrent() &&
    decisions.evaluateNative(entry, host, params.runtimeId).availability === true
      ? undefined
      : unavailable;

  return { kind: "ready", validate };
}
