import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding.types.js";
import { isPluginOwnedBindingMetadata } from "../../plugins/conversation-binding-metadata.js";
import {
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db-registry.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionStoreTarget } from "./targets.js";

export function resolveCleanupSqlitePath(target: SessionStoreTarget): string {
  return resolveSqliteTargetFromSessionStorePath(target.storePath, { agentId: target.agentId })
    .path;
}

export function isConfiguredCleanupStore(cfg: OpenClawConfig, target: SessionStoreTarget): boolean {
  const agentId = normalizeAgentId(target.agentId);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return isSameOpenClawAgentDatabasePath(
    resolveCleanupSqlitePath(target),
    resolveCleanupSqlitePath({ agentId, storePath }),
  );
}

// Binding routing, not the config's legacy default, owns unscoped sentinels.
// Opaque/plugin targets and records without a provable owner remain untouched.
export function isConfiguredBindingTarget(
  cfg: OpenClawConfig,
  target: SessionStoreTarget,
  binding: SessionBindingRecord,
): boolean {
  if (isPluginOwnedBindingMetadata(binding.metadata)) {
    return false;
  }
  const sessionKey = binding.targetSessionKey;
  const agentId =
    parseAgentSessionKey(sessionKey)?.agentId ??
    (isUnscopedSessionKeySentinel(sessionKey)
      ? normalizeOptionalString(binding.metadata?.agentId)
      : undefined);
  if (!agentId) {
    return false;
  }
  return (
    normalizeAgentId(target.agentId) === normalizeAgentId(agentId) &&
    isConfiguredCleanupStore(cfg, target)
  );
}
