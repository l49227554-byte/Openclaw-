import { sha256Hex } from "./crypto-digest.js";
import { generateSecureUuid } from "./secure-random.js";
import type {
  QueuedSessionDelivery as CoreQueuedSessionDelivery,
  QueuedSessionDeliveryPayload as CoreQueuedSessionDeliveryPayload,
} from "./session-delivery-queue-codec.js";

export type {
  SessionDeliveryContext,
  SessionDeliveryRoute,
  SessionDeliverySettledOutcome,
} from "./session-delivery-queue-codec.js";

export type QueuedSessionDeliveryPayload =
  | (Extract<CoreQueuedSessionDeliveryPayload, { kind: "systemEvent" }> & {
      /** Recipient agent that exclusively owns this durable system event. */
      agentId?: string;
    })
  | Exclude<CoreQueuedSessionDeliveryPayload, { kind: "systemEvent" }>;

type SessionDeliveryStorageFields = { retainOnFailure?: true };

export type QueuedSessionDelivery =
  | (Extract<CoreQueuedSessionDelivery, { kind: "systemEvent" }> &
      SessionDeliveryStorageFields & { agentId?: string })
  | (Exclude<CoreQueuedSessionDelivery, { kind: "systemEvent" }> & SessionDeliveryStorageFields);

// Session delivery queue persists session-scoped messages until channel
// delivery acknowledges them or recovery exhausts retry policy.
export const SESSION_DELIVERY_QUEUE_NAME = "session";

export function prepareClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  now = Date.now(),
): QueuedSessionDelivery {
  return {
    ...params,
    retainOnFailure: true,
    id: buildEntryId(params.idempotencyKey),
    enqueuedAt: now,
    retryCount: 0,
    availableAt: now + Math.max(0, initialAttemptLeaseMs),
  };
}

export class SessionDeliveryDeferredError extends Error {
  override name = "SessionDeliveryDeferredError";
}

/** Signals that retry budget was already persisted before a later transition failed. */
export class SessionDeliveryRetryChargedError extends Error {
  override name = "SessionDeliveryRetryChargedError";
}

/** Signals that durable pre-delivery ownership could not be established. */
export class SessionDeliveryAttemptStartError extends Error {
  override name = "SessionDeliveryAttemptStartError";
}

/** Signals that delivery proved no external or transcript side effect committed. */
export class SessionDeliverySafeRetryError extends Error {
  override name = "SessionDeliverySafeRetryError";
}

/** Signals that recovery must settle this pending row as failed without replaying delivery. */
export class SessionDeliveryDeadLetteredError extends Error {
  override name = "SessionDeliveryDeadLetteredError";
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return sha256Hex(idempotencyKey);
}

export function prepareSessionDelivery(
  params: QueuedSessionDeliveryPayload,
): QueuedSessionDelivery {
  return {
    ...params,
    ...(params.completionRetention === "permanent" ? { retainOnFailure: true as const } : {}),
    id: buildEntryId(params.idempotencyKey),
    enqueuedAt: Date.now(),
    retryCount: 0,
  };
}

/** Signals that a delivered result still needs durable settlement finalization. */
export class SessionDeliveryAcknowledgementFinalizeError extends Error {
  constructor(id: string, options?: ErrorOptions) {
    super(`Session delivery ${id} still needs settlement finalization`, options);
    this.name = "SessionDeliveryAcknowledgementFinalizeError";
  }
}
