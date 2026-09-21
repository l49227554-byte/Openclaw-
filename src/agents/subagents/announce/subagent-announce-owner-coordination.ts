import { loadRequesterSessionEntry, loadSessionEntryByKey } from "./subagent-announce-delivery.js";

type ContinuationEntry = {
  inputTokens?: number;
  outputTokens?: number;
};

export function createOwnerBoundContinuationEntryLoader<T extends ContinuationEntry>(params: {
  childSessionKey: string;
  childAgentId?: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  loadOwned: (sessionKey: string, agentId?: string) => T | undefined;
  loadFallback: (sessionKey: string, options?: { refresh?: boolean }) => T | undefined;
}): (sessionKey: string, options?: { refresh?: boolean }) => T | undefined {
  return (sessionKey, options) =>
    sessionKey === params.childSessionKey
      ? params.loadOwned(sessionKey, params.childAgentId)
      : sessionKey === params.requesterSessionKey
        ? params.loadOwned(sessionKey, params.requesterAgentId)
        : params.loadFallback(sessionKey, options);
}

export function createSubagentAnnounceEntryReaders() {
  const sessionEntryCache = new Map<string, ReturnType<typeof loadSessionEntryByKey>>();
  const requesterEntryCache = new Map<
    string,
    Map<string, ReturnType<typeof loadRequesterSessionEntry>>
  >();
  const readSessionEntryByKey = (sessionKey: string, options?: { refresh?: boolean }) => {
    if (options?.refresh || !sessionEntryCache.has(sessionKey)) {
      sessionEntryCache.set(sessionKey, loadSessionEntryByKey(sessionKey));
    }
    return sessionEntryCache.get(sessionKey);
  };
  const readRequesterSessionEntry = (
    sessionKey: string,
    agentId?: string,
    options?: { refresh?: boolean },
  ) => {
    let entriesByAgent = requesterEntryCache.get(sessionKey);
    if (!entriesByAgent) {
      entriesByAgent = new Map();
      requesterEntryCache.set(sessionKey, entriesByAgent);
    }
    const ownerKey = agentId ?? "";
    if (options?.refresh || !entriesByAgent.has(ownerKey)) {
      entriesByAgent.set(ownerKey, loadRequesterSessionEntry(sessionKey, agentId));
    }
    return entriesByAgent.get(ownerKey)!;
  };
  const invalidateSessionEntry = (sessionKey: string) => {
    sessionEntryCache.delete(sessionKey);
    requesterEntryCache.delete(sessionKey);
  };
  return { invalidateSessionEntry, readRequesterSessionEntry, readSessionEntryByKey };
}

export function formatSubagentAnnounceOwnerFailure(params: {
  childSessionKey: string;
  childAgentId?: string;
  requesterAgentId?: string;
  failureStage: string;
  error: unknown;
}): string {
  const originSession = params.childSessionKey.startsWith("agent:") ? "agent-scoped" : "unscoped";
  const childOwnerSource = params.childAgentId ? "persisted" : "derived";
  const ownerReceipt = params.childAgentId ? "present" : "absent";
  const requesterOwnerSource = params.requesterAgentId ? "persisted" : "derived";
  return `Subagent announce failed: stage=${params.failureStage} originSession=${originSession} childOwnerSource=${childOwnerSource} ownerReceipt=${ownerReceipt} requesterOwnerSource=${requesterOwnerSource} ${String(params.error)}`;
}
