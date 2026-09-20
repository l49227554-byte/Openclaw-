import { clearGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { maskLifecycleIdentifier } from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// A commit that keeps rejecting for the same reason never advances durable
// state, so every retry re-runs the identical rejection. The delay cap alone
// bounds the rate, not the lifetime: without an attempt bound the wake is
// retried for as long as the Gateway runs. Abandon it instead, and record why.
const MAX_PENDING_WAKE_COMMIT_FAILURES = 5;

function clearPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): void {
  for (const entry of pending.entries) {
    if (context.pendingRequesterSettleWakeCommits.get(entry) === pending) {
      context.pendingRequesterSettleWakeCommits.delete(entry);
    }
  }
}

export function getPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
): PendingRequesterSettleWakeCommit | undefined {
  const pending = context.pendingRequesterSettleWakeCommits.get(entry);
  if (pending && !pending.isCurrent(entry)) {
    // A changed row relinquishes only its own obligation. Surviving siblings
    // must keep the known outcome or replay budget ahead of transport.
    context.pendingRequesterSettleWakeCommits.delete(entry);
    return undefined;
  }
  return pending;
}

function deferWakeCommit(pending: PendingRequesterSettleWakeCommit): boolean {
  pending.failures += 1;
  pending.nextAttemptAt =
    Date.now() + Math.min(120_000, 30_000 * 2 ** Math.min(pending.failures - 1, 2));
  return pending.failures >= MAX_PENDING_WAKE_COMMIT_FAILURES;
}

/**
 * Drop a wake whose commit can never succeed. The child's own result already
 * lives on the registry row; only the requester's courtesy wake is abandoned,
 * along with the timer, gateway resolver and resumed-run bookkeeping that keep
 * the sweeper re-entering it.
 */
function abandonPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
  reason: string,
): void {
  clearPendingWakeCommit(context, pending);
  const abandoned: string[] = [];
  for (const entry of pending.entries) {
    if (context.options.runs.get(entry.runId) !== entry || !entry.requesterSettleWake) {
      continue;
    }
    entry.requesterSettleWake = undefined;
    abandoned.push(entry.runId);
    const retryTimer = context.getRequesterSettleWakeTimer(entry.runId);
    if (retryTimer) {
      clearTimeout(retryTimer.timer);
      context.deleteRequesterSettleWakeTimer(entry.runId);
    }
    clearGatewayContextResolver(entry);
    context.options.resumedRuns.delete(entry.runId);
  }
  if (abandoned.length === 0) {
    return;
  }
  // Best-effort persistence: the in-memory clear already stops the sweep loop,
  // and a throwing writer must not resurrect the failure that got us here.
  context.options.persist(...abandoned);
  // The reason belongs in the message, not only in meta: the default log
  // renderer drops warn metadata, so an operator watching this loop otherwise
  // cannot tell which settlement invariant kept rejecting.
  context.options.warn(
    `requester settle wake abandoned after ${pending.failures} settlement failures: ${reason}`,
    {
      failureCount: pending.failures,
      runIds: abandoned.map((runId) => maskLifecycleIdentifier(runId, "run")),
    },
  );
}

// Persistence failure cannot erase a transport result or its replay budget. Keep
// that exact operation in the lifecycle owner, ahead of every later transport.
export function commitRequesterWake(
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  generation: number | undefined,
  commit: (entries: readonly SubagentRunRecord[]) => boolean,
  retainOnFailure: boolean,
): void {
  const owners = entries.map((entry) => ({
    entry,
    runId: entry.runId,
    createdAt: entry.createdAt,
    taskRunId: entry.taskRunId,
    wake: entry.requesterSettleWake,
    wakeJson: JSON.stringify(entry.requesterSettleWake),
    deliveryGeneration: entry.delivery?.generation,
    generation: entry.generation,
    execution: entry.execution,
    cancellation: entry.killReconciliation,
    suppressed: entry.suppressCompletionDelivery,
  }));
  const pending: PendingRequesterSettleWakeCommit = {
    entries: [...entries],
    commit,
    failures: 0,
    nextAttemptAt: 0,
    isCurrent: (current) =>
      owners.some(
        ({
          entry,
          runId,
          createdAt,
          taskRunId,
          wake,
          wakeJson,
          deliveryGeneration,
          generation: runGeneration,
          execution,
          cancellation,
          suppressed,
        }) => {
          if (
            entry !== current ||
            context.options.runs.get(runId) !== entry ||
            entry.runId !== runId ||
            entry.createdAt !== createdAt ||
            entry.taskRunId !== taskRunId ||
            entry.generation !== runGeneration ||
            !entry.requesterSettleWake ||
            entry.requesterSettleWake.rearmGeneration !== generation ||
            context.newerGenerationOwnsSession(entry)
          ) {
            return false;
          }
          if (
            entry.requesterSettleWake === wake &&
            entry.execution === execution &&
            entry.killReconciliation === cancellation &&
            entry.suppressCompletionDelivery === suppressed
          ) {
            return true;
          }
          // Independent blocking republishes the row but does not consume its wake.
          // Keep that exact closed member in settlement: the store must validate its
          // durable state and consume the obsolete wake without rewriting its failure.
          return (
            entry.execution.status === "terminal" &&
            entry.pauseReason !== "sessions_yield" &&
            entry.suppressCompletionDelivery === true &&
            entry.delivery?.status === "failed" &&
            entry.delivery.generation === deliveryGeneration &&
            JSON.stringify(entry.requesterSettleWake) === wakeJson
          );
        },
      ),
  };
  const retain = (reason?: unknown) => {
    if (!retainOnFailure) {
      return;
    }
    const exhausted = deferWakeCommit(pending);
    for (const entry of entries) {
      if (pending.isCurrent(entry)) {
        context.pendingRequesterSettleWakeCommits.set(entry, pending);
      }
    }
    if (exhausted) {
      abandonPendingWakeCommit(context, pending, describeWakeCommitFailure(reason));
    }
  };
  try {
    // A temporarily closed Gateway can defer settlement without invalidating
    // already observed delivery. Only changed row ownership drops its fence.
    if (!commit(entries)) {
      retain();
    }
  } catch (error) {
    retain(error);
    throw error;
  }
}

// Only an Error carries a usable message; a rejected commit that returned false
// has no reason at all, and a non-Error throw must not be blind-stringified.
function describeWakeCommitFailure(reason: unknown): string {
  return reason instanceof Error ? reason.message : "requester settle wake commit was not accepted";
}

export function retryPendingWakeCommit(
  context: SubagentLifecycleWakeContext,
  pending: PendingRequesterSettleWakeCommit,
): void {
  if (pending.nextAttemptAt > Date.now()) {
    return;
  }
  try {
    const members = pending.entries.filter(
      (member) => getPendingWakeCommit(context, member) === pending,
    );
    if (pending.commit(members)) {
      clearPendingWakeCommit(context, pending);
    } else if (deferWakeCommit(pending)) {
      abandonPendingWakeCommit(context, pending, describeWakeCommitFailure(undefined));
    }
  } catch (error) {
    if (deferWakeCommit(pending)) {
      abandonPendingWakeCommit(context, pending, describeWakeCommitFailure(error));
    }
    throw error;
  }
}
