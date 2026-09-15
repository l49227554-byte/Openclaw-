import {
  AgentSelectionRequiredError,
  resolveSessionAgentIdStrict,
} from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db-registry.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionStoreTarget } from "./targets.js";

export function resolveCleanupSqlitePath(target: SessionStoreTarget): string {
  return resolveSqliteTargetFromSessionStorePath(target.storePath, { agentId: target.agentId })
    .path;
}

// Bindings address the configured session store, not an arbitrary --store locator.
// A bare key is not sufficient authority to clear a different agent's route.
export function isConfiguredBindingTarget(
  cfg: OpenClawConfig,
  target: SessionStoreTarget,
  sessionKey: string,
): boolean {
  let agentId: string;
  try {
    agentId = resolveSessionAgentIdStrict({ config: cfg, sessionKey });
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return false;
    }
    throw error;
  }
  if (normalizeAgentId(target.agentId) !== agentId) {
    return false;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return isSameOpenClawAgentDatabasePath(
    resolveCleanupSqlitePath(target),
    resolveCleanupSqlitePath({ agentId, storePath }),
  );
}
