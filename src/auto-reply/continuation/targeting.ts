import {
  recordDelegateArtifactDeliveryBinding,
  type DelegateArtifactRecipientProjectionV1,
} from "../../agents/delegate-artifacts.js";
import { isSessionRecipientAuthorityCurrent } from "../../config/sessions/session-accessor.js";
import type { SessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-types.js";
import { emitContinuationFanoutSpan } from "../../infra/continuation-tracer.js";
import {
  markTrustedContinuationHeartbeatWake,
  requestHeartbeatNow,
} from "../../infra/heartbeat-wake.js";
import { enqueueSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import type {
  DelegateArtifactDeliveryReceipt,
  QueuedSessionDeliveryPayload,
  SessionDeliveryContext,
} from "../../infra/session-delivery-queue-storage.js";
import {
  enqueueSystemEventRaw as enqueueSystemEvent,
  removeSystemEvents,
} from "../../infra/system-events.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { withContinuationOwner } from "./system-event-ownership.js";
import {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasCrossSessionDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
} from "./targeting-pure.js";
import type {
  ContinuationDelegateFanoutMode,
  ContinuationDelegateTargeting,
} from "./targeting-pure.js";

export {
  CONTINUATION_DELEGATE_FANOUT_MODES,
  hasCrossSessionDelegateTargeting,
  normalizeContinuationTargetKey,
  normalizeContinuationTargetKeys,
};
export function resolveContinuationReturnTargetSessionKeys(
  params: ContinuationDelegateTargeting & {
    defaultSessionKey: string;
    treeSessionKeys?: readonly string[];
    allSessionKeys?: readonly string[];
    childSessionKey?: string;
  },
): string[] {
  const defaultSessionKey = normalizeContinuationTargetKey(params.defaultSessionKey);
  const fallback = defaultSessionKey ? [defaultSessionKey] : [];

  if (params.fanoutMode === "tree") {
    const treeKeys = normalizeContinuationTargetKeys(params.treeSessionKeys);
    return treeKeys.length > 0 ? treeKeys : fallback;
  }

  if (params.fanoutMode === "all") {
    const childSessionKey = normalizeContinuationTargetKey(params.childSessionKey);
    const allKeys = normalizeContinuationTargetKeys(params.allSessionKeys).filter(
      (sessionKey) => sessionKey !== childSessionKey,
    );
    return allKeys.length > 0 ? allKeys : fallback;
  }

  const explicitKeys = normalizeContinuationTargetKeys([
    ...(params.targetSessionKey ? [params.targetSessionKey] : []),
    ...(params.targetSessionKeys ?? []),
  ]);
  return explicitKeys.length > 0 ? explicitKeys : fallback;
}

type ContinuationReturnDeliveryDeps = {
  enqueueSessionDelivery: typeof enqueueSessionDelivery;
  /** Test seam proving queued durable delivery is not acknowledged before prompt adoption. */
  ackSessionDelivery?: typeof import("../../infra/session-delivery-queue-storage.js").ackSessionDelivery;
  enqueueSystemEvent: typeof enqueueSystemEvent;
  requestHeartbeatNow: typeof requestHeartbeatNow;
  isRecipientAuthorityCurrent?: (
    sessionKey: string,
    authority: SessionRecipientAuthority,
  ) => boolean;
  removeSystemEvents?: typeof removeSystemEvents;
  recordDelegateArtifactDeliveryBinding?: typeof recordDelegateArtifactDeliveryBinding;
};

const defaultContinuationReturnDeliveryDeps: ContinuationReturnDeliveryDeps = {
  enqueueSessionDelivery,
  enqueueSystemEvent,
  requestHeartbeatNow,
  recordDelegateArtifactDeliveryBinding,
};

function resolveContinuationReturnDeliveryTarget(params: {
  sessionKey: string;
  recipientAgentIds?: ReadonlyMap<string, string>;
}): { sessionKey: string; recipientAgentId: string } {
  const explicitRecipientAgentId = params.sessionKey.startsWith("agent:")
    ? resolveAgentIdFromSessionKey(params.sessionKey)
    : undefined;
  const boundRecipientAgentId = params.recipientAgentIds?.get(params.sessionKey)?.trim();
  const normalizedBoundRecipientAgentId = boundRecipientAgentId
    ? normalizeAgentId(boundRecipientAgentId)
    : undefined;

  if (
    explicitRecipientAgentId &&
    normalizedBoundRecipientAgentId &&
    explicitRecipientAgentId !== normalizedBoundRecipientAgentId
  ) {
    throw new Error(`Continuation recipient owner mismatches target ${params.sessionKey}`);
  }

  const recipientAgentId = normalizedBoundRecipientAgentId ?? explicitRecipientAgentId;
  if (!recipientAgentId) {
    throw new Error(`Continuation recipient owner is unavailable for target ${params.sessionKey}`);
  }
  return {
    sessionKey: params.sessionKey,
    recipientAgentId,
  };
}

export async function enqueueContinuationReturnDeliveries(
  params: {
    targetSessionKeys: readonly string[];
    text: string;
    textBySessionKey?: ReadonlyMap<string, string>;
    idempotencyKeyBase: string;
    expectedSessionIds?: ReadonlyMap<string, string>;
    recipientAuthorities?: ReadonlyMap<string, SessionRecipientAuthority>;
    delegateArtifactReceipts?: ReadonlyMap<string, DelegateArtifactDeliveryReceipt>;
    delegateArtifactProjections?: ReadonlyMap<string, DelegateArtifactRecipientProjectionV1>;
    deliveryContext?: SessionDeliveryContext;
    wakeRecipients?: boolean;
    childRunId?: string;
    stateDir?: string;
    traceparent?: string;
    fanoutMode?: ContinuationDelegateFanoutMode;
    chainStepRemaining?: number;
    recipientAgentIds?: ReadonlyMap<string, string>;
    ownerAgentId?: string;
  },
  deps: ContinuationReturnDeliveryDeps = defaultContinuationReturnDeliveryDeps,
): Promise<{ enqueued: number; delivered: number; deliveryIds: string[] }> {
  if (!params.ownerAgentId) {
    throw new Error("Continuation return source owner is unavailable.");
  }
  const targetSessionKeys = normalizeContinuationTargetKeys(params.targetSessionKeys);
  const targets = targetSessionKeys.map((sessionKey) =>
    resolveContinuationReturnDeliveryTarget({
      sessionKey,
      recipientAgentIds: params.recipientAgentIds,
    }),
  );
  const deliveryIds: string[] = [];
  let delivered = 0;

  for (const { sessionKey, recipientAgentId } of targets) {
    const text = params.textBySessionKey?.get(sessionKey) ?? params.text;
    const expectedSessionId = params.expectedSessionIds?.get(sessionKey);
    const delegateArtifactReceipt = params.delegateArtifactReceipts?.get(sessionKey);
    const delegateArtifactProjection = params.delegateArtifactProjections?.get(sessionKey);
    const recipientAuthority = params.recipientAuthorities?.get(sessionKey);
    const hasManagedArtifactDelivery =
      delegateArtifactReceipt !== undefined || delegateArtifactProjection !== undefined;
    if (
      hasManagedArtifactDelivery &&
      (!delegateArtifactReceipt ||
        !delegateArtifactProjection ||
        expectedSessionId !== delegateArtifactReceipt.recipientSessionId ||
        sessionKey !== delegateArtifactReceipt.recipientSessionKey)
    ) {
      throw new Error("managed delegate artifact delivery binding mismatch");
    }
    if (recipientAuthority && hasManagedArtifactDelivery) {
      throw new Error("managed delegate artifact delivery cannot use logical recipient authority");
    }
    const recipientAuthorityCurrent = () =>
      !recipientAuthority ||
      (
        deps.isRecipientAuthorityCurrent ??
        ((key, authority) => isSessionRecipientAuthorityCurrent({ sessionKey: key }, authority))
      )(sessionKey, recipientAuthority);
    if (!recipientAuthorityCurrent()) {
      continue;
    }
    const commonPayload = {
      kind: "systemEvent" as const,
      sessionKey,
      agentId: recipientAgentId,
      text,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
      // Recipient position is not stable when a cleaned intermediate is
      // removed from a tree/all fanout. Keep retries keyed to the durable
      // recipient identity instead.
      idempotencyKey: `${params.idempotencyKeyBase}:${sessionKey}`,
    };
    const payload: QueuedSessionDeliveryPayload =
      delegateArtifactReceipt && delegateArtifactProjection
        ? {
            ...commonPayload,
            expectedSessionId: delegateArtifactReceipt.recipientSessionId,
            managedDelegateArtifactDelivery: {
              receipt: delegateArtifactReceipt,
              projection: delegateArtifactProjection,
            },
          }
        : {
            ...commonPayload,
            ...(expectedSessionId ? { expectedSessionId } : {}),
            ...(recipientAuthority ? { recipientAuthority, awaitPromptAdoption: true } : {}),
          };
    const deliveryId = await deps.enqueueSessionDelivery(payload, params.stateDir);
    if (!recipientAuthorityCurrent()) {
      continue;
    }

    const eventOptions = {
      sessionKey,
      trusted: true,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
      sessionDeliveryAckId: deliveryId,
      ...(params.stateDir ? { sessionDeliveryAckStateDir: params.stateDir } : {}),
      ...(expectedSessionId ? { expectedSessionId } : {}),
      ...(recipientAuthority
        ? {
            recipientAuthority,
            sessionDeliveryAwaitsTurnAdoption: true,
          }
        : {}),
      ...(delegateArtifactReceipt ? { delegateArtifactReceipt } : {}),
    };
    const enqueued = deps.enqueueSystemEvent(
      text,
      withContinuationOwner(eventOptions, recipientAgentId),
    );
    if (enqueued && delegateArtifactProjection && delegateArtifactReceipt) {
      deps.recordDelegateArtifactDeliveryBinding?.({
        dispatchId: delegateArtifactReceipt.dispatchId,
        recipientSessionKey: delegateArtifactReceipt.recipientSessionKey,
        recipientSessionId: delegateArtifactReceipt.recipientSessionId,
        phase: "attempt",
        now: Date.now(),
        availability: delegateArtifactProjection.arrivalContext.availability,
        ...(params.stateDir
          ? { options: { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } } }
          : {}),
      });
    }
    if (!enqueued) {
      // Idempotent delivery enqueue can return the existing durable row id for
      // the already-queued in-memory event. Do not ack here: that would delete
      // the durable backing row for the surviving queued event before the
      // prompt-drain path consumes it. The surviving event carries the ack id.
    }
    if (!recipientAuthorityCurrent()) {
      (deps.removeSystemEvents ?? removeSystemEvents)(
        sessionKey,
        (event) =>
          event.sessionDeliveryAckId === deliveryId &&
          event.sessionDeliveryAckStateDir === params.stateDir,
      );
      continue;
    }
    if (params.wakeRecipients) {
      deps.requestHeartbeatNow(
        markTrustedContinuationHeartbeatWake({
          sessionKey,
          agentId: recipientAgentId,
          reason: "delegate-return",
          parentRunId: params.childRunId,
        }),
      );
    }
    // For a queued event, do NOT ack the durable file here. The in-memory event
    // carries the ack id and the prompt-drain path acknowledges it only after
    // recipient consumption; non-attached recipients still need restart recovery
    // to replay this file.
    deliveryIds.push(deliveryId);
    delivered += 1;
  }

  if (
    (params.traceparent !== undefined || params.chainStepRemaining !== undefined) &&
    (params.fanoutMode !== undefined || targetSessionKeys.length > 1)
  ) {
    emitContinuationFanoutSpan({
      targetSessionKeys,
      deliveredCount: delivered,
      ...(params.fanoutMode ? { fanoutMode: params.fanoutMode } : {}),
      ...(params.chainStepRemaining !== undefined
        ? { chainStepRemaining: params.chainStepRemaining }
        : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
    });
  }

  return {
    enqueued: deliveryIds.length,
    delivered,
    deliveryIds,
  };
}
