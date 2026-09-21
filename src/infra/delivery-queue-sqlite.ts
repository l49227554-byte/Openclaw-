// Stores durable delivery queue entries through their connection-bound owner.
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  deliveryQueueEntriesQuery,
  terminalizeBoundDeliveryQueueEntry,
  type DeliveryQueueReadMode,
} from "./delivery-queue-sqlite-bound.js";
import {
  inflateDeliveryQueueEntryResult,
  type DeliveryQueueEntryLoadResult,
} from "./delivery-queue-sqlite-codec.js";
import {
  completeDeliveryQueueEntryInDatabase,
  countPendingDeliveryQueueEntriesInDatabase,
  deleteDeliveryQueueEntryInDatabase,
  deliveryQueueEntryNotFoundError,
  getDeliveryQueueEntryOwnersInDatabase,
  prepareDeliveryQueueTerminalEntry,
  reserveDeliveryQueueEntryAttemptInDatabase,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
  type DeliveryQueueStoredStatus,
  type ReserveDeliveryQueueAttemptResult,
  type TerminalizePendingDeliveryQueueEntryParams as KernelTerminalizeParams,
  type TerminalizePendingDeliveryQueueEntryResult,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import {
  inferDeliveryQueueFailureRetention,
  projectDeliveryQueueTerminalEntry,
} from "./delivery-queue-sqlite.types.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "./delivery-queue-state-context.js";
import { executeDeliveryQueueOperation } from "./delivery-queue-worker-store.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "./kysely-sync.js";

export type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.types.js";
export type { DeliveryQueueEntryLoadResult } from "./delivery-queue-sqlite-codec.js";
export type {
  DeliveryQueueStoredStatus,
  ReserveDeliveryQueueAttemptResult,
  TerminalizePendingDeliveryQueueEntryResult,
} from "./delivery-queue-sqlite.kernel.js";

export type TerminalizePendingDeliveryQueueEntryParams = KernelTerminalizeParams & {
  expectedEntryJson?: string;
  lastError?: string;
};

export {
  captureDeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "./delivery-queue-state-context.js";

function openStateDatabase(stateDir?: string, context?: DeliveryQueueStateContext) {
  return openOpenClawStateDatabase({
    env: resolveDeliveryQueueStateEnv(stateDir, context),
  });
}

/** Load a single pending delivery queue entry. */
export function loadDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
): DeliveryQueueEntryState | null {
  const result = loadDeliveryQueueEntryResult(queueName, id, stateDir, mode, context);
  return result?.status === "loaded" ? result.entry : null;
}

/** Load a row without discarding corrupt JSON or its exact persisted text. */
export function loadDeliveryQueueEntryResult(
  queueName: string,
  id: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
): DeliveryQueueEntryLoadResult | null {
  const database = openStateDatabase(stateDir, context);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    deliveryQueueEntriesQuery(database, [queueName], mode).where("id", "=", id),
  );
  return row ? inflateDeliveryQueueEntryResult(row) : null;
}

/** Read row status without hiding dead-lettered entries. */
export function getDeliveryQueueEntryStatus(
  queueName: string,
  id: string,
  stateDir?: string,
): DeliveryQueueStoredStatus | undefined {
  return getDeliveryQueueEntryOwners([queueName], id, stateDir).get(queueName)?.status;
}

/** Read one exact ID across physical namespaces from a single ownership snapshot. */
export function getDeliveryQueueEntryOwners(
  queueNames: readonly string[],
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Map<string, { status: DeliveryQueueStoredStatus; settlementPending?: true }> {
  if (queueNames.length === 0) {
    return new Map();
  }
  return getDeliveryQueueEntryOwnersInDatabase(
    openStateDatabase(stateDir, context),
    queueNames,
    id,
  );
}

/** Load all pending entries for a queue namespace in database order. */
export function loadDeliveryQueueEntries(
  queueName: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
): DeliveryQueueEntryState[] {
  return loadDeliveryQueueEntryResults(queueName, stateDir, mode, context).flatMap((result) =>
    result.status === "loaded" ? [result.entry] : [],
  );
}

/** Load rows in database order while retaining corrupt row identity and bytes. */
export function loadDeliveryQueueEntryResults(
  queueName: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
): DeliveryQueueEntryLoadResult[] {
  const database = openStateDatabase(stateDir, context);
  const rows = executeSqliteQuerySync(
    database.db,
    deliveryQueueEntriesQuery(database, [queueName], mode)
      .orderBy("enqueued_at", "asc")
      .orderBy("id", "asc"),
  ).rows;
  return rows.map(inflateDeliveryQueueEntryResult);
}

/** Delete a pending delivery queue entry after successful delivery. */
export function deleteDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): void {
  deleteDeliveryQueueEntryInDatabase(openStateDatabase(stateDir, context), queueName, id);
}

/** Retain a delivered row as a durable idempotency tombstone. */
export function completeDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): void {
  completeDeliveryQueueEntryInDatabase(openStateDatabase(stateDir, context), queueName, id);
}

/** Load, transform, and persist a pending delivery queue entry. */
export function updateDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir: string | undefined,
  update: (entry: DeliveryQueueEntryState) => DeliveryQueueEntryState,
  context?: DeliveryQueueStateContext,
): void {
  updateDeliveryQueueEntryInDatabase(openStateDatabase(stateDir, context), queueName, id, update);
}

/** Atomically reserve one provider-delivery call before executing it. */
export function reserveDeliveryQueueEntryAttempt(
  params: {
    queueName: string;
    id: string;
    maxAttempts: number;
    stateDir?: string;
    expectedPlatformSendAttemptId?: string;
  },
  context?: DeliveryQueueStateContext,
): ReserveDeliveryQueueAttemptResult {
  if (!Number.isInteger(params.maxAttempts) || params.maxAttempts <= 0) {
    throw new Error(`Invalid delivery attempt budget: ${params.maxAttempts}`);
  }
  return runOpenClawStateWriteTransaction(
    (database) => reserveDeliveryQueueEntryAttemptInDatabase(database, params),
    {
      env: resolveDeliveryQueueStateEnv(params.stateDir, context),
    },
    {
      operationLabel: `reserve ${params.queueName} delivery attempt`,
    },
  );
}

/** Count dead-lettered entries per queue namespace for coarse health reporting. */
export async function countFailedDeliveryQueueEntries(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<Array<{ queueName: string; count: number; oldestFailedAt?: number }>> {
  return executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.countFailed",
    input: undefined,
  });
}

/** Count pending entries across an exact set of queue namespaces. */
export function countPendingDeliveryQueueEntries(
  queueNames: readonly string[],
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): number {
  if (queueNames.length === 0) {
    return 0;
  }
  return countPendingDeliveryQueueEntriesInDatabase(
    openStateDatabase(stateDir, context),
    queueNames,
  );
}

/** Inventory retired custody without opening a writer or creating state. */
export async function countPendingDeliveryQueueEntriesReadOnly(
  queueNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return (
    (await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
      (database) => countPendingDeliveryQueueEntriesInDatabase(database, queueNames),
      { env },
    )) ?? 0
  );
}

/** Physically expire age-bounded delivery queue tombstones. */
export async function pruneExpiredDeliveryQueueTombstones(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.pruneTombstones",
    input: undefined,
  });
}

/** Terminalize one pending row using its failure-retention ownership fact. */
export function moveDeliveryQueueEntryToFailed(
  queueName: string,
  id: string,
  stateDir?: string,
): void {
  const current = loadDeliveryQueueEntryResult(queueName, id, stateDir);
  if (!current || current.status !== "loaded") {
    throw deliveryQueueEntryNotFoundError(queueName, id);
  }
  const result = terminalizePendingDeliveryQueueEntry({
    queueName,
    id,
    entry: current.entry,
    expectedEntryJson: current.entryJson,
    stateDir,
  });
  if (result.status !== "terminalized") {
    throw deliveryQueueEntryNotFoundError(queueName, id);
  }
}

function prepareContinuationTerminalEntry(
  params: TerminalizePendingDeliveryQueueEntryParams & {
    expectedEntryJson?: string;
    lastError?: string;
  },
) {
  if (params.entry.id !== params.id) {
    throw new Error(`Delivery queue entry id mismatch: ${params.entry.id} != ${params.id}`);
  }
  const now = Date.now();
  const expectedJson = params.expectedEntryJson ?? JSON.stringify(params.entry);
  const retention = inferDeliveryQueueFailureRetention(params.entry, params.id, params.queueName);
  const failedEntry = retention
    ? projectDeliveryQueueTerminalEntry(params.entry, now, "failed", retention)
    : undefined;
  return {
    queueName: params.queueName,
    id: params.id,
    expectedStatus: params.expectedStatus,
    lastError: params.lastError,
    now,
    expectedJson,
    retention,
    failedEntry,
  };
}

function terminalizeContinuationEntryInDatabase(
  database: OpenClawStateDatabase,
  prepared: ReturnType<typeof prepareContinuationTerminalEntry>,
): TerminalizePendingDeliveryQueueEntryResult {
  const { queueName, id, expectedJson, failedEntry, now, expectedStatus, retention, lastError } =
    prepared;
  if (
    !terminalizeBoundDeliveryQueueEntry(
      database.db,
      queueName,
      id,
      expectedJson,
      failedEntry,
      now,
      expectedStatus ?? "pending",
      lastError,
    )
  ) {
    return { status: "not_pending" };
  }
  if (typeof retention === "object") {
    getDeliveryQueueEntryOwnersInDatabase(database, [queueName], id);
  }
  return { status: "terminalized", retained: retention !== undefined };
}

export function terminalizeInvalidDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  params: {
    queueName: string;
    id: string;
    entry: DeliveryQueueEntryState;
    expectedEntryJson: string;
    lastError: string;
  },
): TerminalizePendingDeliveryQueueEntryResult {
  return terminalizeContinuationEntryInDatabase(database, prepareContinuationTerminalEntry(params));
}

/** Atomically delete or tombstone a pending row only while its value is unchanged. */
export function terminalizePendingDeliveryQueueEntry(
  params: TerminalizePendingDeliveryQueueEntryParams & { stateDir?: string },
  context?: DeliveryQueueStateContext,
): TerminalizePendingDeliveryQueueEntryResult {
  if (params.expectedEntryJson !== undefined || params.lastError !== undefined) {
    return terminalizeContinuationEntryInDatabase(
      openStateDatabase(params.stateDir, context),
      prepareContinuationTerminalEntry(params),
    );
  }
  const prepared = prepareDeliveryQueueTerminalEntry(params);
  return terminalizePendingDeliveryQueueEntryInDatabase(
    openStateDatabase(params.stateDir, context),
    prepared,
  );
}
