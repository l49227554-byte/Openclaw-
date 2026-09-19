import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import type {
  SubagentCompletionDeliveryState,
  SubagentRunReadRecord,
} from "./subagent-registry-read.types.js";
import type {
  SubagentCompletionState,
  SubagentRunMaintenanceRecord,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export function projectSubagentRunForSessionList(entry: SubagentRunRecord): SubagentRunReadRecord {
  return {
    runId: entry.runId,
    ...(entry.pauseReason ? { pauseReason: entry.pauseReason } : {}),
    ...(entry.swarmRunId ? { swarmRunId: entry.swarmRunId } : {}),
    childSessionKey: entry.childSessionKey,
    ...(entry.controllerSessionKey ? { controllerSessionKey: entry.controllerSessionKey } : {}),
    requesterSessionKey: entry.requesterSessionKey,
    ...(entry.collect
      ? {
          collect: true,
          groupId: entry.groupId,
          swarmRequesterSessionKey: entry.swarmRequesterSessionKey,
        }
      : {}),
    ...(entry.collectorCompletion
      ? { collectorCompletion: { status: entry.collectorCompletion.status } }
      : {}),
    ...(entry.requesterAgentId ? { requesterAgentId: entry.requesterAgentId } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
    createdAt: entry.createdAt,
    execution: {
      status: entry.execution.status,
      ...(entry.execution.startedAt !== undefined ? { startedAt: entry.execution.startedAt } : {}),
      ...(entry.execution.endedAt !== undefined ? { endedAt: entry.execution.endedAt } : {}),
      ...(entry.execution.outcome ? { outcome: { status: entry.execution.outcome.status } } : {}),
    },
    ...(entry.sessionStartedAt !== undefined ? { sessionStartedAt: entry.sessionStartedAt } : {}),
    ...(entry.accumulatedRuntimeMs !== undefined
      ? { accumulatedRuntimeMs: entry.accumulatedRuntimeMs }
      : {}),
    ...(entry.runTimeoutSeconds !== undefined
      ? { runTimeoutSeconds: entry.runTimeoutSeconds }
      : {}),
    ...(entry.endedReason ? { endedReason: entry.endedReason } : {}),
    ...(entry.cleanupCompletedAt !== undefined
      ? { cleanupCompletedAt: entry.cleanupCompletedAt }
      : {}),
    ...(entry.delivery
      ? {
          delivery: {
            status: entry.delivery.status,
            ...(entry.delivery.suspendedAt !== undefined
              ? { suspendedAt: entry.delivery.suspendedAt }
              : {}),
          },
        }
      : {}),
  };
}

/** Copy only protection facts; live memory retains its existing, unnormalized semantics. */
export function projectSubagentRunForMaintenance(
  entry: SubagentRunRecord,
): SubagentRunMaintenanceRecord {
  return {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    createdAt: entry.createdAt,
    cleanupCompletedAt: entry.cleanupCompletedAt,
    expectsCompletionMessage: entry.expectsCompletionMessage,
    killIntent: entry.killIntent ? { ...entry.killIntent } : entry.killIntent,
    killReconciliation: entry.killReconciliation
      ? { ...entry.killReconciliation }
      : entry.killReconciliation,
    execution: { status: entry.execution.status, endedAt: entry.execution.endedAt },
    delivery: entry.delivery
      ? { status: entry.delivery.status, suspendedAt: entry.delivery.suspendedAt }
      : undefined,
  };
}

export function normalizeSubagentRunState(entry: SubagentRunRecord): SubagentRunRecord {
  const taskRunId = typeof entry.taskRunId === "string" ? entry.taskRunId.trim() : "";
  entry.taskRunId = taskRunId || undefined;
  const requesterTurnRunId =
    typeof entry.requesterTurnRunId === "string" ? entry.requesterTurnRunId.trim() : "";
  entry.requesterTurnRunId = requesterTurnRunId || undefined;
  entry.requesterTurnYielded =
    requesterTurnRunId && entry.requesterTurnYielded === true ? true : undefined;
  entry.retireAfterRequesterTurn =
    requesterTurnRunId && entry.retireAfterRequesterTurn === true ? true : undefined;
  entry.generation =
    typeof entry.generation === "number" &&
    Number.isSafeInteger(entry.generation) &&
    entry.generation > 0
      ? entry.generation
      : undefined;
  entry.deleteCleanupDispatchedAt = Number.isFinite(entry.deleteCleanupDispatchedAt)
    ? entry.deleteCleanupDispatchedAt
    : undefined;
  entry.suppressCompletionDelivery = entry.suppressCompletionDelivery === true ? true : undefined;
  entry.terminalOwner =
    entry.terminalOwner === "interrupted-recovery" &&
    Number.isFinite(entry.execution.endedAt) &&
    entry.execution.outcome?.status === "error" &&
    entry.endedReason === "subagent-error" &&
    entry.pauseReason !== "sessions_yield"
      ? "interrupted-recovery"
      : undefined;
  if (entry.completion) {
    entry.completion.terminalReply = normalizeAgentRunTerminalReplySnapshot(
      entry.completion.terminalReply,
    );
  }
  const killReconciliation = entry.killReconciliation;
  if (
    !killReconciliation ||
    typeof killReconciliation !== "object" ||
    !Number.isFinite(killReconciliation.killedAt)
  ) {
    delete entry.killReconciliation;
  } else {
    entry.killReconciliation = {
      killedAt: killReconciliation.killedAt,
      taskCancellationAccepted:
        killReconciliation.taskCancellationAccepted === true ? true : undefined,
      suppressTaskDelivery: killReconciliation.suppressTaskDelivery === true ? true : undefined,
      supersededAt: Number.isFinite(killReconciliation.supersededAt)
        ? killReconciliation.supersededAt
        : undefined,
    };
  }
  const killIntent = entry.killIntent;
  if (
    !killIntent ||
    typeof killIntent !== "object" ||
    !Number.isFinite(killIntent.requestedAt) ||
    typeof killIntent.reason !== "string" ||
    !killIntent.reason.trim()
  ) {
    delete entry.killIntent;
  } else {
    entry.killIntent = {
      requestedAt: killIntent.requestedAt,
      reason: killIntent.reason.trim(),
      lifecycleGeneration:
        typeof killIntent.lifecycleGeneration === "string" && killIntent.lifecycleGeneration.trim()
          ? killIntent.lifecycleGeneration.trim()
          : undefined,
      sessionId:
        typeof killIntent.sessionId === "string" && killIntent.sessionId.trim()
          ? killIntent.sessionId.trim()
          : undefined,
      sessionLifecycleRevision:
        typeof killIntent.sessionLifecycleRevision === "string" &&
        killIntent.sessionLifecycleRevision.trim()
          ? killIntent.sessionLifecycleRevision.trim()
          : undefined,
      suppressTaskDelivery: killIntent.suppressTaskDelivery === true ? true : undefined,
    };
  }
  // cleanupHandled is an in-process lock; after restart, unfinished cleanup must
  // retry unless durable cleanup completion was recorded.
  if (
    entry.cleanupHandled === true &&
    typeof entry.cleanupCompletedAt !== "number" &&
    entry.delivery?.status !== "discarded"
  ) {
    entry.cleanupHandled = false;
  }
  return entry;
}

/** Ensures a run has a nested completion state object. */
export function ensureCompletionState(entry: SubagentRunRecord): SubagentCompletionState {
  entry.completion ??= {
    required: entry.expectsCompletionMessage === true,
  };
  return entry.completion;
}

/** Ensures a run has a nested delivery state object. */
export function ensureDeliveryState(entry: SubagentRunRecord): SubagentCompletionDeliveryState {
  entry.delivery ??= {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
  return entry.delivery;
}

/** Resets delivery state to its initial status for the run's completion requirement. */
export function clearDeliveryState(entry: SubagentRunRecord): void {
  entry.delivery = {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
}

/** Returns true when delivery is suspended with a durable timestamp. */
export function isDeliverySuspended(entry: Pick<SubagentRunRecord, "delivery">): boolean {
  return entry.delivery?.status === "suspended" && typeof entry.delivery.suspendedAt === "number";
}

/** A finished requester without its required message receipt must not execute again implicitly. */
export function isCompletedRequesterDeliveryBlocked(
  entry: Pick<SubagentRunRecord, "delivery">,
): boolean {
  return (
    isDeliverySuspended(entry) &&
    entry.delivery?.suspendedReason === "permanent_failure" &&
    entry.delivery.lastDropReason === "message_tool_delivery_missing"
  );
}

/** Returns true when required delivery still owns the row after its child session is gone. */
export function hasRetainedRequiredCompletionDelivery(
  entry: Pick<
    SubagentRunRecord,
    "completion" | "delivery" | "expectsCompletionMessage" | "suppressCompletionDelivery"
  >,
): boolean {
  const delivery = entry.delivery;
  if (
    entry.expectsCompletionMessage !== true ||
    entry.suppressCompletionDelivery === true ||
    entry.completion?.required !== true ||
    !delivery?.payload
  ) {
    return false;
  }
  if (isDeliverySuspended(entry)) {
    return true;
  }
  if (delivery.status === "in_progress") {
    // The correlated session queue owns this delivery and resumes it separately.
    return true;
  }
  return (
    delivery.status === "pending" &&
    delivery.disposition !== "ambiguous" &&
    delivery.disposition !== "intentional_non_delivery" &&
    delivery.disposition !== "permanent_failure"
  );
}

/** Reads the current delivery attempt count. */
export function getDeliveryAttemptCount(entry: SubagentRunRecord): number {
  return entry.delivery?.attemptCount ?? 0;
}

/** Reads the non-empty last delivery error. */
export function getDeliveryLastError(entry: SubagentRunRecord): string | undefined {
  const error = entry.delivery?.lastError;
  return typeof error === "string" && error.trim() ? error : undefined;
}

// ----------------------------------------------------------------------------
// Durable at-most-once fallback claim
// ----------------------------------------------------------------------------
//
// These helpers implement a per-run, per-generation claim that the message-tool
// fallback acquires immediately before invoking runSubagentAnnounceFlow. The
// claim is persisted through delivery.fallbackClaim (a JSON field carried by
// the existing payload_json column, no schema change required). The contract:
//
// - acquireFallbackClaim: returns the claim only if the entry's existing claim
//   (a) is absent, (b) belongs to the same process, or (c) is bound to an
//   older delivery.generation that a redrive has now incremented. In every
//   other case the caller is a duplicate, a concurrent rival, or a stale
//   observer and must NOT send. Persistence happens before the outbound call.
// - releaseFallbackClaim: terminal failure path. Clears the claim and persists.
// - commitDeliveredFallback: terminal success path. Clears the claim, sets
//   status = "delivered", and persists before the existing delivered
//   transition runs (it does not run the existing transition itself).
// - closeAmbiguousFallback: tombstone for a claimed delivery whose send
//   outcome cannot be proven after interruption. Reuses the existing closed
//   shape status = "suspended" + disposition = "intentional_non_delivery" and
//   retains the claim so restart recovery never re-acquires it.
//
// Tradeoff: a crash between acquireFallbackClaim and the outbound send loses
// the notification. The alternative (resending on restart) is duplicate
// outbound delivery, which is the failure mode this contract exists to
// prevent. The retained claim is the durable receipt that closes the entry.

export type FallbackClaimOwnerIdentity = string;

export function generateFallbackClaimOwner(): FallbackClaimOwnerIdentity {
  return `pid:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}

/** Fresh per-acquire token. Distinguishes overlapping same-process callers. */
export function generateFallbackClaimToken(): string {
  return `tok:${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export type FallbackClaimAcquireResult =
  | {
      acquired: true;
      claim: NonNullable<NonNullable<SubagentRunRecord["delivery"]>["fallbackClaim"]>;
    }
  | { acquired: false; reason: "claimed_by_other" };

/**
 * Attempts to acquire the durable fallback claim for one delivery generation.
 *
 * - If no claim exists, claims and persists a fresh token, returns
 *   { acquired: true }.
 * - If a claim exists for the same process, generation, AND token, this is a
 *   same-process retry of the same in-flight call; returns { acquired: true }
 *   with the existing claim without re-persisting.
 * - If a claim exists with a different owner OR a different token at the same
 *   generation, this is a concurrent caller; returns
 *   { acquired: false, reason: "claimed_by_other" } without mutating state.
 */
export function acquireFallbackClaim(
  entry: SubagentRunRecord,
  params: {
    owner: FallbackClaimOwnerIdentity;
    token: string;
    generation: number;
    idempotencyKey: string;
    persist: (runId: string) => void;
    now?: () => number;
  },
): FallbackClaimAcquireResult {
  const now = params.now ?? Date.now;
  const existing = entry.delivery?.fallbackClaim;
  if (existing && existing.generation === params.generation) {
    const sameInFlightRetry = existing.owner === params.owner && existing.token === params.token;
    if (!sameInFlightRetry) {
      return { acquired: false, reason: "claimed_by_other" };
    }
    return { acquired: true, claim: existing };
  }
  const claim = {
    owner: params.owner,
    claimedAt: now(),
    generation: params.generation,
    idempotencyKey: params.idempotencyKey,
    token: params.token,
  };
  const delivery = ensureDeliveryState(entry);
  delivery.fallbackClaim = claim;
  params.persist(entry.runId);
  return { acquired: true, claim };
}

/** Returns the in-flight token of the currently-held claim, or undefined. */
export function getFallbackClaimToken(entry: SubagentRunRecord): string | undefined {
  return entry.delivery?.fallbackClaim?.token;
}

/**
 * Clears the durable fallback claim and persists. Used on terminal failure.
 * Token-aware: refuses to release a claim owned by a different in-flight call.
 */
export function releaseFallbackClaim(
  entry: SubagentRunRecord,
  params: { token: string; persist: (runId: string) => void },
): void {
  const existing = entry.delivery?.fallbackClaim;
  if (!existing) {
    return;
  }
  if (existing.token !== params.token) {
    return;
  }
  entry.delivery.fallbackClaim = undefined;
  params.persist(entry.runId);
}

/**
 * Closes an entry whose send outcome cannot be proven after interruption.
 * Token-aware: refuses to overwrite a claim owned by a different in-flight
 * call. Retains the tombstone when the token matches, so restart recovery
 * never re-acquires it.
 */
export function closeAmbiguousFallback(
  entry: SubagentRunRecord,
  params: {
    token: string;
    reason: string;
    persist: (runId: string) => void;
    now?: () => number;
  },
): void {
  const existing = entry.delivery?.fallbackClaim;
  if (!existing || existing.token !== params.token) {
    return;
  }
  const now = params.now ?? Date.now;
  const delivery = ensureDeliveryState(entry);
  delivery.status = "suspended";
  delivery.disposition = "intentional_non_delivery";
  delivery.suspendedAt = now();
  delivery.suspendedReason = "permanent_failure";
  delivery.lastError = `ambiguous_after_claim: ${params.reason}`;
  // fallbackClaim is intentionally retained: the tombstone prevents a future
  // restart replay from acquiring the same delivery.generation.
  params.persist(entry.runId);
}

/**
 * Terminal success path: clears the claim, sets status = "delivered", and
 * persists before the existing delivered transition runs. Token-aware: only
 * commits when the in-memory claim still belongs to this caller. On persist
 * failure the in-memory mutation is rolled back so the next caller sees the
 * pre-commit authoritative state.
 *
 * Does not run the delivered transition itself; the caller routes through
 * finalizeSubagentCleanup.
 */
export function commitDeliveredFallback(
  entry: SubagentRunRecord,
  params: {
    token: string;
    deliveredAt: number;
    announcedAt?: number;
    persist: (runId: string) => void;
  },
): boolean {
  const existing = entry.delivery?.fallbackClaim;
  if (!existing || existing.token !== params.token) {
    return false;
  }
  const delivery = ensureDeliveryState(entry);
  const previousStatus = delivery.status;
  const previousDisposition = delivery.disposition;
  const previousDeliveredAt = delivery.deliveredAt;
  const previousAnnouncedAt = delivery.announcedAt;
  const previousLastDropReason = delivery.lastDropReason;
  delivery.status = "delivered";
  delivery.disposition = "delivered";
  delivery.deliveredAt = params.deliveredAt;
  delivery.announcedAt = params.announcedAt ?? params.deliveredAt;
  delivery.lastDropReason = undefined;
  delivery.fallbackClaim = undefined;
  try {
    params.persist(entry.runId);
  } catch (error) {
    // Roll back the in-memory mutation so a restart sees the pre-commit
    // authoritative state rather than a phantom delivered entry that has no
    // durable persisted row.
    delivery.status = previousStatus;
    delivery.disposition = previousDisposition;
    delivery.deliveredAt = previousDeliveredAt;
    delivery.announcedAt = previousAnnouncedAt;
    delivery.lastDropReason = previousLastDropReason;
    delivery.fallbackClaim = existing;
    throw error;
  }
  return true;
}

/**
 * Returns true when an entry's persisted claim belongs to a different process
 * for the same delivery generation. Restart recovery uses this to skip
 * redriving a tombstoned entry.
 */
export function isFallbackClaimedByOtherProcess(
  entry: SubagentRunRecord,
  params: { owner: FallbackClaimOwnerIdentity },
): boolean {
  const claim = entry.delivery?.fallbackClaim;
  return (
    !!claim &&
    claim.generation === (entry.delivery?.generation ?? 0) &&
    claim.owner !== params.owner
  );
}
