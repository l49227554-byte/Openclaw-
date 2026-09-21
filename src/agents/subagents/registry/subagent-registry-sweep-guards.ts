import { hasLiveOrRecentlyDispatchedContinuationWork } from "../../../auto-reply/continuation/work-store.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function hasContinuationWorkForSweepEntry(entry: SubagentRunRecord): boolean {
  if (hasLiveOrRecentlyDispatchedContinuationWork(entry.childSessionKey)) {
    return true;
  }
  if (!entry.collect || !entry.groupId) {
    return false;
  }
  return [...subagentRuns.values()].some(
    (candidate) =>
      candidate.collect === true &&
      candidate.groupId === entry.groupId &&
      candidate.swarmRequesterSessionKey === entry.swarmRequesterSessionKey &&
      hasLiveOrRecentlyDispatchedContinuationWork(candidate.childSessionKey),
  );
}
