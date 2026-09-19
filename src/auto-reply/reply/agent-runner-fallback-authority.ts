import { resolveManifestModelCatalogProviderAliasMetadata } from "../../agents/embedded-agent-runner/model.manifest-alias.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyOperation, ReplyToolAuthorityRoute } from "./reply-run-registry.contracts.js";

/** Translate canonical selection/materialization facts; never infer provenance from the final hook route. */
export function recordReplyAutomaticFallbackRoute(params: {
  operation: ReplyOperation | undefined;
  provenance: ModelFallbackAttemptProvenance;
  route: ReplyToolAuthorityRoute;
  config: OpenClawConfig;
  workspaceDir?: string;
}): void {
  const { operation, provenance, route } = params;
  const requested = operation?.requestedToolAuthorityRoute;
  if (!operation) {
    return;
  }
  if (
    provenance.stage !== "fallback" ||
    provenance.selectionChanged !== false ||
    requested?.provider !== provenance.requestedProvider ||
    requested?.model !== provenance.requestedModel
  ) {
    operation.setAutomaticFallbackRoute(undefined);
    return;
  }
  // Same manifest owner and scope as final selected-model preparation. Complete
  // transport aliases stay distinct; ambiguous claims cannot authorize promotion.
  const canonical = resolveManifestModelCatalogProviderAliasMetadata({
    provider: route.provider,
    modelId: route.model,
    cfg: params.config,
    workspaceDir: params.workspaceDir,
  });
  operation.setAutomaticFallbackRoute(
    canonical.ambiguous ? undefined : { provider: canonical.provider, model: route.model },
  );
}
