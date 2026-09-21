import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  SpawnSubagentAdmissionCancelledError,
  type SpawnSubagentAdmissionAuthority,
} from "../../agents/subagents/spawn/subagent-spawn-contract.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { registerContinuationDispatchClaim } from "./continuation-dispatch-claims.js";
import {
  revalidatePendingDelegateForSpawn,
  type DelegateSpawnFenceController,
} from "./delegate-store.js";

type DelegateClaim = {
  flowId?: string;
  expectedRevision?: number;
  task: string;
};

type OwnerLifecycleIdentity = Pick<SessionEntry, "lifecycleRevision" | "sessionId">;

export function createContinuationOwnerSessionLoader(
  ownerSessionKey: string,
  expectedAgentId?: string,
): {
  agentId: string;
  load: () => SessionEntry | undefined;
} {
  const cfg = getRuntimeConfig();
  const agentId = resolveSessionAgentId({
    sessionKey: ownerSessionKey,
    config: cfg,
    agentId: expectedAgentId,
  });
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return {
    agentId,
    load: () => loadSessionEntry({ agentId, storePath, sessionKey: ownerSessionKey }),
  };
}

export function registerContinuationDelegateDispatchClaim(params: {
  controller: DelegateSpawnFenceController;
  delegate: DelegateClaim;
  ownerSession: ReturnType<typeof createContinuationOwnerSessionLoader>;
  ownerSessionKey: string;
}): {
  authority: SpawnSubagentAdmissionAuthority;
  ownerAgentId: string;
  release: () => void;
} {
  const { controller, delegate, ownerSession, ownerSessionKey } = params;
  const { flowId, expectedRevision } = delegate;
  if ((flowId === undefined) !== (expectedRevision === undefined)) {
    throw new SpawnSubagentAdmissionCancelledError(
      "Continuation delegate source metadata is incomplete.",
    );
  }
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const ownerIdentity = ownerSession.load();
  if (!ownerIdentity) {
    throw new SpawnSubagentAdmissionCancelledError(
      "Continuation delegate source session owner is unavailable.",
    );
  }
  const activeClaim = registerContinuationDispatchClaim({
    sessionKey: ownerSessionKey,
    flowId,
  });
  const assertCurrent = (_boundary?: string, source: DelegateClaim | null = delegate): void => {
    if (
      activeClaim.controller.signal.aborted ||
      !activeClaim.isActive() ||
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      throw new SpawnSubagentAdmissionCancelledError("Continuation delegate admission closed.");
    }
    if (flowId !== undefined && source) {
      const fence = revalidatePendingDelegateForSpawn(source, controller);
      if (!fence.allowed) {
        throw new SpawnSubagentAdmissionCancelledError(fence.summary);
      }
    }
    if (!isSameOwnerLifecycle(ownerSession.load(), ownerIdentity)) {
      throw new SpawnSubagentAdmissionCancelledError(
        "Continuation delegate source session lifecycle changed.",
      );
    }
  };
  return {
    authority: {
      signal: activeClaim.controller.signal,
      source: {
        ownerSessionKey,
        ...(flowId !== undefined ? { flowId, expectedRevision } : {}),
      },
      assertCurrent,
    },
    ownerAgentId: ownerSession.agentId,
    release: activeClaim.release,
  };
}

function isSameOwnerLifecycle(
  current: SessionEntry | undefined,
  expected: OwnerLifecycleIdentity,
): boolean {
  return (
    current?.sessionId === expected.sessionId &&
    current.lifecycleRevision === expected.lifecycleRevision
  );
}
