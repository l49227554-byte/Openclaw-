// Persists queued session deliveries for retry and recovery.
import type { SessionPostCompactionDelegate } from "../config/sessions/types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { sha256Hex } from "./crypto-digest.js";
import { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import type { DeliveryQueueEntryLoadResult } from "./delivery-queue-sqlite-codec.js";
import {
  getDeliveryQueueEntryStatus,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";
import { generateSecureUuid } from "./secure-random.js";
import { scrubTerminalQueuedAttachments } from "./session-delivery-queue-attachment-metadata.js";
import {
  decodeSessionDeliveryResult,
  normalizeQueuedSessionDeliveryTraceparent,
  normalizeSessionDeliveryForPersistence,
  type QueuedSessionDelivery as CoreQueuedSessionDelivery,
  type SessionDeliveryContext,
  type SessionDeliverySettledOutcome,
} from "./session-delivery-queue-codec.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  SessionDeliveryAcknowledgementFinalizeError,
  SessionDeliveryAttemptStartError,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliveryRetryChargedError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
} from "./session-delivery-queue.records.js";
import type {
  SessionDeliveryAgentRunUpdate,
  SessionDeliveryWorkerOperations,
} from "./session-delivery-queue.worker-contract.js";

export type {
  DelegateArtifactDeliveryReceipt,
  SessionDeliveryContext,
  SessionDeliveryRoute,
  SessionDeliverySettledOutcome,
} from "./session-delivery-queue-codec.js";

export {
  SESSION_DELIVERY_QUEUE_NAME,
  SessionDeliveryAcknowledgementFinalizeError,
  SessionDeliveryAttemptStartError,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliveryRetryChargedError,
  SessionDeliverySafeRetryError,
};

export type { QueuedSessionDelivery, QueuedSessionDeliveryPayload };

type SessionDeliveryQueueHandle = OpenClawStateWorkerContext | string | undefined;

function isWorkerContext(value: SessionDeliveryQueueHandle): value is OpenClawStateWorkerContext {
  return typeof value === "object" && value !== null && "admission" in value;
}

function resolveQueueContext(handle: SessionDeliveryQueueHandle): OpenClawStateWorkerContext {
  if (isWorkerContext(handle)) {
    return handle;
  }
  return captureOpenClawStateWorkerContext({
    env: handle ? { ...process.env, OPENCLAW_STATE_DIR: handle } : process.env,
  });
}

function resolveStateDir(handle: SessionDeliveryQueueHandle): string | undefined {
  if (typeof handle === "string") {
    return handle;
  }
  if (isWorkerContext(handle)) {
    return handle.environment.OPENCLAW_STATE_DIR;
  }
  return undefined;
}

function executeSessionDelivery<Key extends keyof SessionDeliveryWorkerOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: SessionDeliveryWorkerOperations[Key]["input"] },
): Promise<SessionDeliveryWorkerOperations[Key]["output"]> {
  // A settled write remains authoritative if its captured owner closes while returning the result.
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command));
}

function prepareEntry(
  entry: QueuedSessionDelivery,
  mode: "insert" | "update",
): ReturnType<typeof bindDeliveryQueueEntry> {
  // Preserve the JSON persistence boundary before the transport serializes its input.
  return bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    ...(mode === "insert" ? { insertOnly: true } : { updatePendingOnly: true }),
  });
}

async function failInvalidSessionDelivery(
  params: SessionDeliveryWorkerOperations["sessionDelivery.failInvalid"]["input"] & {
    context: OpenClawStateWorkerContext;
  },
): Promise<void> {
  await executeSessionDelivery(params.context, {
    type: "sessionDelivery.failInvalid",
    input: {
      entry: params.entry,
      error: params.error,
      entryJson: params.entryJson,
    },
  });
}

type SessionDeliveryStorageEnvelope = { retainOnFailure?: true; agentId?: string };

function splitSessionDeliveryStorageEnvelope(entry: DeliveryQueueEntryState): {
  coreEntry: DeliveryQueueEntryState;
  envelope: SessionDeliveryStorageEnvelope;
} {
  const kind = "kind" in entry ? entry.kind : undefined;
  const agentId = "agentId" in entry ? entry.agentId : undefined;
  const coreEntry: Record<string, unknown> = { ...entry };
  const envelope: SessionDeliveryStorageEnvelope = {};
  if (kind === "systemEvent" && typeof agentId === "string" && agentId.trim().length > 0) {
    envelope.agentId = agentId;
    delete coreEntry.agentId;
  } else if (kind === "systemEvent" && agentId === undefined) {
    delete coreEntry.agentId;
  }
  if (entry.retainOnFailure === true) {
    envelope.retainOnFailure = true;
    delete coreEntry.retainOnFailure;
  } else if (entry.retainOnFailure === undefined) {
    delete coreEntry.retainOnFailure;
  }
  // SAFETY: coreEntry only ever drops the two optional agentId/retainOnFailure keys from a spread of entry, so it stays a valid DeliveryQueueEntryState.
  return { coreEntry: coreEntry as DeliveryQueueEntryState, envelope };
}

function normalizeSessionDeliveryForStorage(entry: QueuedSessionDelivery): QueuedSessionDelivery {
  const { coreEntry, envelope } = splitSessionDeliveryStorageEnvelope(entry);
  // SAFETY: callers only ever pass a coreEntry split from a QueuedSessionDelivery, so it always has the kind/sessionKey shape of CoreQueuedSessionDelivery.
  const normalized = normalizeSessionDeliveryForPersistence(coreEntry as CoreQueuedSessionDelivery);
  return { ...normalized, ...envelope };
}

function decodeStoredSessionDeliveryResult(result: DeliveryQueueEntryLoadResult) {
  if (result.status === "corrupt") {
    return decodeSessionDeliveryResult(result);
  }
  const { coreEntry, envelope } = splitSessionDeliveryStorageEnvelope(result.entry);
  const decoded = decodeSessionDeliveryResult({ ...result, entry: coreEntry });
  return decoded.status === "loaded"
    ? { status: "loaded" as const, entry: { ...decoded.entry, ...envelope } }
    : decoded;
}

// Strip trailing whitespace per line and at end-of-string before hashing the
// idempotency key, so same-intent keys that differ only by trailing whitespace
// produce the same sha256 taskHash and the replay-dedupe path stays robust.
function canonicalizeIdempotencyKey(key: string): string {
  return key.replace(/[ \t\r\f\v]+(?=\n|$)/g, "").replace(/\s+$/, "");
}

export function prepareClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  now = Date.now(),
): QueuedSessionDelivery {
  const payload = normalizeQueuedSessionDeliveryTraceparent(params);
  return normalizeSessionDeliveryForStorage({
    ...payload,
    retainOnFailure: true,
    id: buildEntryId(payload.idempotencyKey),
    enqueuedAt: now,
    retryCount: 0,
    availableAt: now + Math.max(0, initialAttemptLeaseMs),
  });
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return sha256Hex(canonicalizeIdempotencyKey(idempotencyKey));
}

function buildPostCompactionDelegateIdempotencyKey(params: {
  sessionKey: string;
  delegate: SessionPostCompactionDelegate;
  sequence: number;
  compactionCount?: number;
}): string {
  const taskHash = sha256Hex(params.delegate.task).slice(0, 16);
  return [
    "post-compaction-delegate",
    params.sessionKey,
    String(params.compactionCount ?? "unknown"),
    String(params.delegate.firstArmedAt ?? params.delegate.createdAt),
    String(params.sequence),
    taskHash,
  ].join(":");
}

export function buildPostCompactionDelegateDeliveryPayload(params: {
  sessionKey: string;
  sourceSessionId?: string;
  sourceLifecycleRevision?: string;
  delegate: SessionPostCompactionDelegate;
  sequence: number;
  compactionCount?: number;
  deliveryContext?: SessionDeliveryContext;
  idempotencyKey?: string;
}): QueuedSessionDeliveryPayload {
  return {
    kind: "postCompactionDelegate",
    sessionKey: params.sessionKey,
    ...(params.sourceSessionId ? { sourceSessionId: params.sourceSessionId } : {}),
    ...(params.sourceLifecycleRevision
      ? { sourceLifecycleRevision: params.sourceLifecycleRevision }
      : {}),
    task: params.delegate.task,
    createdAt: params.delegate.createdAt,
    firstArmedAt: params.delegate.firstArmedAt ?? params.delegate.createdAt,
    ...(params.delegate.silent != null ? { silent: params.delegate.silent } : {}),
    ...(params.delegate.silentWake != null ? { silentWake: params.delegate.silentWake } : {}),
    ...(params.delegate.targetSessionKey
      ? { targetSessionKey: params.delegate.targetSessionKey }
      : {}),
    ...(params.delegate.targetSessionKeys && params.delegate.targetSessionKeys.length > 0
      ? { targetSessionKeys: params.delegate.targetSessionKeys }
      : {}),
    ...(params.delegate.fanoutMode ? { fanoutMode: params.delegate.fanoutMode } : {}),
    ...(params.delegate.recipientAuthorityBinding
      ? { recipientAuthorityBinding: params.delegate.recipientAuthorityBinding }
      : {}),
    ...(params.delegate.returnOptions ? { returnOptions: params.delegate.returnOptions } : {}),
    ...(params.delegate.recipientContext
      ? { recipientContext: params.delegate.recipientContext }
      : {}),
    ...(params.delegate.model ? { model: params.delegate.model } : {}),
    ...(params.delegate.attachments && params.delegate.attachments.length > 0
      ? { attachments: params.delegate.attachments }
      : {}),
    ...(params.delegate.attachAs ? { attachAs: params.delegate.attachAs } : {}),
    ...(params.delegate.traceparentProvenance === "internal" && params.delegate.traceparent
      ? {
          traceparent: params.delegate.traceparent,
          traceparentProvenance: "internal" as const,
        }
      : {}),
    ...(params.delegate.flowId ? { sourceFlowId: params.delegate.flowId } : {}),
    ...(params.delegate.expectedRevision !== undefined
      ? { sourceExpectedRevision: params.delegate.expectedRevision }
      : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    idempotencyKey:
      params.idempotencyKey ??
      buildPostCompactionDelegateIdempotencyKey({
        sessionKey: params.sessionKey,
        delegate: params.delegate,
        sequence: params.sequence,
        compactionCount: params.compactionCount,
      }),
  };
}

/** Enqueue a session delivery and return its durable id. */
export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  handle?: SessionDeliveryQueueHandle,
): Promise<string> {
  return (await enqueueSessionDeliveryWithStatus(params, handle)).id;
}

/**
 * Enqueue outcome for callers that must distinguish "this row is now mine to
 * drive" from "a completed tombstone already settled this idempotency key".
 *
 * `enqueueSessionDelivery` only returns the deterministic id, so a caller that
 * also owns an in-memory fast path cannot tell whether it created work or hit a
 * tombstone — and would emit a duplicate notice for an outcome already
 * delivered.
 */
type SessionDeliveryEnqueueResult = {
  id: string;
  /** `completed` means a tombstone settled this key; no new work was created. */
  status: "pending" | "completed" | "unknown";
};

export async function enqueueSessionDeliveryWithStatus(
  params: QueuedSessionDeliveryPayload,
  handle?: SessionDeliveryQueueHandle,
): Promise<SessionDeliveryEnqueueResult> {
  const payload = normalizeQueuedSessionDeliveryTraceparent(params);
  const id = buildEntryId(payload.idempotencyKey);
  const entry = normalizeSessionDeliveryForStorage({
    ...payload,
    ...(payload.completionRetention === "permanent" ? { retainOnFailure: true as const } : {}),
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  });
  const context = resolveQueueContext(handle);
  const stateDir = resolveStateDir(handle);
  await executeSessionDelivery(context, {
    type: "sessionDelivery.enqueue",
    input: prepareEntry(entry, "insert"),
  });
  let status: SessionDeliveryEnqueueResult["status"];
  try {
    const current = getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id, stateDir);
    status = current === "completed" ? "completed" : current === "pending" ? "pending" : "unknown";
  } catch {
    status = "unknown";
  }
  return { id, status };
}

/** Enqueue a post-compaction delegate through the shared durable queue. */
export async function enqueuePostCompactionDelegateDelivery(
  params: {
    sessionKey: string;
    sourceSessionId?: string;
    sourceLifecycleRevision?: string;
    delegate: SessionPostCompactionDelegate;
    sequence: number;
    compactionCount?: number;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
  },
  handle?: SessionDeliveryQueueHandle,
): Promise<string> {
  return await enqueueSessionDelivery(buildPostCompactionDelegateDeliveryPayload(params), handle);
}

/** Enqueue and lease the first attempt to one caller before recovery can see it as eligible. */
export async function enqueueClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  handle?: SessionDeliveryQueueHandle,
): Promise<SessionDeliveryWorkerOperations["sessionDelivery.enqueueClaimed"]["output"]> {
  return executeSessionDelivery(resolveQueueContext(handle), {
    type: "sessionDelivery.enqueueClaimed",
    input: prepareEntry(prepareClaimedSessionDelivery(params, initialAttemptLeaseMs), "insert"),
  });
}

/** Release the initial-attempt lease so runtime recovery can retry immediately. */
export async function releaseSessionDeliveryClaim(
  id: string,
  handle?: SessionDeliveryQueueHandle,
): Promise<void> {
  return executeSessionDelivery(resolveQueueContext(handle), {
    type: "sessionDelivery.releaseClaim",
    input: { id },
  });
}

/** Defer a currently owned delivery without consuming its retry budget. */
export async function deferSessionDelivery(
  id: string,
  delayMs: number,
  handle?: SessionDeliveryQueueHandle,
): Promise<void> {
  return executeSessionDelivery(resolveQueueContext(handle), {
    type: "sessionDelivery.defer",
    input: { id, delayMs },
  });
}

/** Advance only after a completed agent turn proves a fresh run is safe. */
export async function advanceSessionDeliveryAgentRun(
  id: string,
  updates?: SessionDeliveryAgentRunUpdate,
  handle?: SessionDeliveryQueueHandle,
): Promise<void> {
  return executeSessionDelivery(resolveQueueContext(handle), {
    type: "sessionDelivery.advanceAgentRun",
    input: { id, updates },
  });
}

/** Preserve one prepared artifact before transcript persistence or retry transitions. */
export async function mergeSessionDeliveryPreparedMediaBlocks(
  id: string,
  mediaUrl: string,
  blocks: Array<Record<string, unknown>>,
  handle?: SessionDeliveryQueueHandle,
): Promise<Array<Record<string, unknown>>> {
  const result = await executeSessionDelivery(resolveQueueContext(handle), {
    type: "sessionDelivery.mergePreparedMedia",
    input: { id, mediaUrl, blocksJson: JSON.stringify(blocks) },
  });
  return result.source === "input" ? blocks : result.blocks;
}

/** Mark an agent turn before it can commit transcript or channel side effects. */
export async function markSessionDeliveryAttemptStarted(
  entry: QueuedSessionDelivery,
  handle?: SessionDeliveryQueueHandle,
): Promise<void> {
  try {
    await executeSessionDelivery(resolveQueueContext(handle), {
      type: "sessionDelivery.markAttemptStarted",
      input: prepareEntry(
        { ...entry, deliveryStartedAt: entry.deliveryStartedAt ?? Date.now() },
        "update",
      ),
    });
  } catch (error) {
    throw new SessionDeliveryAttemptStartError(
      `Session delivery ${entry.id} could not persist attempt ownership`,
      { cause: error },
    );
  }
}

/** Persist terminal delivery state while retaining settlement cleanup metadata. */
export async function markSessionDeliverySettlement(
  entry: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
  handle?: SessionDeliveryQueueHandle,
): Promise<void> {
  const settledEntry = scrubTerminalQueuedAttachments(entry);
  try {
    await executeSessionDelivery(resolveQueueContext(handle), {
      type: "sessionDelivery.markSettlement",
      input: prepareEntry(
        {
          ...settledEntry,
          settlementOutcome: outcome,
          ...(outcome === "recovered"
            ? { acknowledgedAt: settledEntry.acknowledgedAt ?? Date.now() }
            : {}),
        },
        "update",
      ),
    });
  } catch (error) {
    throw new SessionDeliveryAcknowledgementFinalizeError(entry.id, { cause: error });
  }
}

/** Replace a settled pending row with its completed idempotency tombstone. */
export async function completeSessionDelivery(
  id: string,
  handle?: SessionDeliveryQueueHandle,
): Promise<void> {
  try {
    await executeSessionDelivery(resolveQueueContext(handle), {
      type: "sessionDelivery.complete",
      input: { id },
    });
  } catch (error) {
    throw new SessionDeliveryAcknowledgementFinalizeError(id, { cause: error });
  }
}

/** Acknowledge a delivered row and retain its completed idempotency tombstone. */
export async function ackSessionDelivery(
  id: string,
  handle?: SessionDeliveryQueueHandle,
): Promise<void> {
  const entry = await loadPendingSessionDelivery(id, handle);
  const stateDir = resolveStateDir(handle);
  if (!entry) {
    if (getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id, stateDir) === "completed") {
      return;
    }
    throw new SessionDeliveryAcknowledgementFinalizeError(id);
  }
  await markSessionDeliverySettlement(entry, "recovered", handle);
  await completeSessionDelivery(id, handle);
}

/** Record a failed delivery attempt and increment retry metadata. */
export async function failSessionDelivery(
  id: string,
  error: string,
  handle?: SessionDeliveryQueueHandle,
  options?: { releaseAttemptOwnership?: boolean },
): Promise<void> {
  await executeSessionDelivery(resolveQueueContext(handle), {
    type: "sessionDelivery.fail",
    input: { id, error, ...options },
  });
}

/** Load one pending session delivery by durable id. */
export async function loadPendingSessionDelivery(
  id: string,
  handle?: SessionDeliveryQueueHandle,
): Promise<QueuedSessionDelivery | null> {
  const context = resolveQueueContext(handle);
  const result = await executeSessionDelivery(context, {
    type: "sessionDelivery.load",
    input: { id },
  });
  context.admission.assertCurrent();
  if (!result) {
    return null;
  }
  const decoded = decodeStoredSessionDeliveryResult(result);
  if (decoded.status === "invalid") {
    await failInvalidSessionDelivery({ ...decoded, context });
    context.admission.assertCurrent();
    return null;
  }
  return decoded.entry;
}

/** Load all pending session deliveries in retry order. */
export async function loadPendingSessionDeliveries(
  handle?: SessionDeliveryQueueHandle,
): Promise<QueuedSessionDelivery[]> {
  const context = resolveQueueContext(handle);
  const results = await executeSessionDelivery(context, {
    type: "sessionDelivery.list",
    input: undefined,
  });
  context.admission.assertCurrent();
  const entries: QueuedSessionDelivery[] = [];
  for (const result of results) {
    const decoded = decodeStoredSessionDeliveryResult(result);
    if (decoded.status === "invalid") {
      await failInvalidSessionDelivery({ ...decoded, context });
      continue;
    }
    entries.push(decoded.entry);
  }
  context.admission.assertCurrent();
  return entries;
}

/** Move an exhausted session delivery out of the pending queue. */
export async function moveSessionDeliveryToFailed(
  id: string,
  handle?: SessionDeliveryQueueHandle,
): Promise<void> {
  const context = resolveQueueContext(handle);
  try {
    await executeSessionDelivery(context, {
      type: "sessionDelivery.moveToFailed",
      input: { id },
    });
  } catch (error) {
    try {
      if (
        getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id, resolveStateDir(handle)) ===
        "failed"
      ) {
        return;
      }
    } catch {
      // Preserve the original transition failure when durable state is unreadable.
    }
    throw error;
  }
}
