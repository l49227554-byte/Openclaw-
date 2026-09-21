// Persists managed task-flow records through the OpenClaw SQLite state database.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { TaskFlowSyncInput } from "./task-flow-registry.records.js";
import {
  deleteTaskFlowRowInDatabase,
  readTaskFlowRegistrySnapshot,
  syncTaskMirroredFlowRecordInDatabase,
  updateTaskFlowRecordInDatabase,
} from "./task-flow-registry.store.kernel.js";
import type {
  TaskFlowRegistryAtomicWrite,
  TaskFlowRegistryMirroredSync,
  TaskFlowRegistryObservedUpdate,
  TaskFlowRegistryStoreSnapshot,
  TaskFlowRegistryUpdate,
  TaskFlowRegistryUpdatePublication,
  TaskFlowRegistryUpdateResult,
} from "./task-flow-registry.store.types.js";
import {
  parseOptionalTaskFlowSyncMode,
  parseTaskFlowStatus,
  type JsonValue,
  type TaskFlowRecord,
  type TaskFlowSyncMode,
} from "./task-flow-registry.types.js";
import { parseDeliveryContextJson, parseSqliteJsonValue } from "./task-registry.sqlite.shared.js";
import { parseTaskNotifyPolicy } from "./task-registry.types.js";

type FlowRunsTable = OpenClawStateKyselyDatabase["flow_runs"];
type FlowRegistryStoreDatabase = Pick<OpenClawStateKyselyDatabase, "flow_runs">;

type FlowRegistryRow = Selectable<FlowRunsTable> & {
  sync_mode: string | null;
  status: string;
  notify_policy: string;
};

const log = createSubsystemLogger("tasks/task-flow-registry");

type FlowRegistryDatabase = {
  db: DatabaseSync;
  path: string;
};

// SQLite-backed task-flow store mirrors the in-process registry into openclaw-state.db.
let cachedDatabase: FlowRegistryDatabase | null = null;

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function resolveFlowSyncMode(row: {
  sync_mode: string | null;
  shape: string | null;
}): TaskFlowSyncMode {
  // Older single_task rows did not persist sync_mode; preserve their mirrored semantics.
  const syncMode = parseOptionalTaskFlowSyncMode(row.sync_mode);
  if (syncMode) {
    return syncMode;
  }
  return row.shape === "single_task" ? "task_mirrored" : "managed";
}

function rowToSyncMode(row: FlowRegistryRow): TaskFlowSyncMode {
  return resolveFlowSyncMode(row);
}


function rowToFlowRecord(row: FlowRegistryRow): TaskFlowRecord {
  const endedAt = normalizeSqliteNumber(row.ended_at);
  const cancelRequestedAt = normalizeSqliteNumber(row.cancel_requested_at);
  const requesterOrigin = parseDeliveryContextJson(row.requester_origin_json);
  const stateJson = parseSqliteJsonValue<JsonValue>(row.state_json);
  const waitJson = parseSqliteJsonValue<JsonValue>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(row.chain_id ? { chainId: row.chain_id } : {}),
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeSqliteNumber(row.revision) ?? 0,
    status: parseTaskFlowStatus(row.status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
    ...(waitJson !== undefined ? { waitJson } : {}),
    ...(cancelRequestedAt != null ? { cancelRequestedAt } : {}),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}

export type BoundTaskFlowRecord = Insertable<FlowRunsTable>;

function bindTaskFlowRecord(record: TaskFlowRecord): BoundTaskFlowRecord {
  return {
    flow_id: record.flowId,
    sync_mode: record.syncMode,
    shape: null,
    owner_key: record.ownerKey,
    chain_id: record.chainId ?? null,
    requester_origin_json: serializeJson(record.requesterOrigin),
    controller_id: record.controllerId ?? null,
    revision: record.revision,
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    state_json: serializeJson(record.stateJson),
    wait_json: serializeJson(record.waitJson),
    cancel_requested_at: record.cancelRequestedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
  };
}

function getFlowRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<FlowRegistryStoreDatabase>(db);
}

function upsertTaskFlowRowInDatabase(db: DatabaseSync, row: BoundTaskFlowRecord): void {
  executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .insertInto("flow_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("flow_id").doUpdateSet({
          sync_mode: (eb) => eb.ref("excluded.sync_mode"),
          owner_key: (eb) => eb.ref("excluded.owner_key"),
          requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
          controller_id: (eb) => eb.ref("excluded.controller_id"),
          revision: (eb) => eb.ref("excluded.revision"),
          status: (eb) => eb.ref("excluded.status"),
          notify_policy: (eb) => eb.ref("excluded.notify_policy"),
          goal: (eb) => eb.ref("excluded.goal"),
          current_step: (eb) => eb.ref("excluded.current_step"),
          blocked_task_id: (eb) => eb.ref("excluded.blocked_task_id"),
          blocked_summary: (eb) => eb.ref("excluded.blocked_summary"),
          state_json: (eb) => eb.ref("excluded.state_json"),
          wait_json: (eb) => eb.ref("excluded.wait_json"),
          cancel_requested_at: (eb) => eb.ref("excluded.cancel_requested_at"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
        }),
      ),
  );
}

function readTaskFlowRecord(db: DatabaseSync, flowId: string): TaskFlowRecord | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getFlowRegistryKysely(db).selectFrom("flow_runs").selectAll().where("flow_id", "=", flowId),
  );
  return row ? rowToFlowRecord(row) : undefined;
}

function openFlowRegistryDatabase(): FlowRegistryDatabase {
  const database = openOpenClawStateDatabase();
  const pathname = database.path;
  if (cachedDatabase && cachedDatabase.path === pathname && cachedDatabase.db.isOpen) {
    return cachedDatabase;
  }
  if (cachedDatabase && !cachedDatabase.db.isOpen) {
    cachedDatabase = null;
  }
  cachedDatabase = {
    db: database.db,
    path: pathname,
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (database: FlowRegistryDatabase) => void) {
  const database = openFlowRegistryDatabase();
  runOpenClawStateWriteTransaction(() => {
    write(database);
  });
}

export function loadTaskFlowRegistryStateFromSqlite(
  flowIds?: readonly string[],
): TaskFlowRegistryStoreSnapshot {
  return readTaskFlowRegistrySnapshot(openFlowRegistryDatabase().db, flowIds);
}

/** Loads task flows without creating or migrating shared state. */
export function loadTaskFlowRegistryStateFromSqliteReadOnly(): TaskFlowRegistryStoreSnapshot {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => readTaskFlowRegistrySnapshot(db)) ?? {
      flows: new Map(),
    }
  );
}

export function upsertTaskFlowRegistryRecordToSqlite(flow: TaskFlowRecord) {
  withWriteTransaction(({ db }) => {
    upsertTaskFlowRowInDatabase(db, bindTaskFlowRecord(flow));
  });
}

export function syncTaskMirroredFlowInSqlite(
  task: TaskFlowSyncInput,
  preparePublication: (result: TaskFlowRegistryMirroredSync) => TaskFlowRegistryUpdatePublication,
): TaskFlowRegistryMirroredSync {
  let committed: TaskFlowRegistryMirroredSync | undefined;
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const result = syncTaskMirroredFlowRecordInDatabase(db, task);
      const publication = preparePublication(result);
      stageSqliteTransactionState(db, {
        stage: publication.stage,
        rollback: publication.rollback,
        commit: () => {
          committed = result;
          publication.commit();
        },
      });
      deferSqlitePostCommitPublication(db, publication.publish);
      return result;
    });
  } catch (error) {
    if (!committed) {
      throw error;
    }
    log.warn("Task-mirrored flow committed before cleanup failed", {
      taskId: task.taskId,
      flowId: task.parentFlowId,
      error,
    });
    return committed;
  }
}

export function updateTaskFlowRegistryRecordInSqlite(
  params: TaskFlowRegistryUpdate,
  preparePublication: (update: TaskFlowRegistryObservedUpdate) => TaskFlowRegistryUpdatePublication,
): TaskFlowRegistryUpdateResult {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = updateTaskFlowRecordInDatabase(db, params);
    if (result.applied || result.reason !== "invalid_patch") {
      const publication = preparePublication(result);
      stageSqliteTransactionState(db, {
        stage: publication.stage,
        rollback: publication.rollback,
        commit: publication.commit,
      });
      deferSqlitePostCommitPublication(db, publication.publish);
    }
    return result;
  });
}

export function upsertTaskFlowRegistryRecordsToSqlite(write: TaskFlowRegistryAtomicWrite): boolean {
  const { changes } = write;
  if (changes.length === 0) {
    return true;
  }
  let applied = false;
  withWriteTransaction(({ db }) => {
    if (write.ownerCondition) {
      let query = getFlowRegistryKysely(db)
        .selectFrom("flow_runs")
        .select(["flow_id", "revision", "status"])
        .where("owner_key", "=", write.ownerCondition.ownerKey)
        .where("controller_id", "=", write.ownerCondition.controllerId)
        .where("status", "in", write.ownerCondition.statuses);
      if (write.ownerCondition.excludeCancelRequested) {
        query = query.where("cancel_requested_at", "is", null);
      }
      const currentFlows = executeSqliteQuerySync(db, query)
        .rows.map((row) => ({
          flowId: row.flow_id,
          revision: normalizeSqliteNumber(row.revision) ?? 0,
          status: parseTaskFlowStatus(row.status),
        }))
        .toSorted((left, right) => left.flowId.localeCompare(right.flowId));
      const expectedFlows = [...write.ownerCondition.expectedFlows].toSorted((left, right) =>
        left.flowId.localeCompare(right.flowId),
      );
      if (
        currentFlows.length !== expectedFlows.length ||
        currentFlows.some((flow, index) => {
          const expected = expectedFlows[index];
          return (
            !expected ||
            flow.flowId !== expected.flowId ||
            flow.revision !== expected.revision ||
            flow.status !== expected.status
          );
        })
      ) {
        return;
      }
    }
    for (const change of changes) {
      const current = readTaskFlowRecord(db, change.flow.flowId);
      if (
        change.expectedRevision === undefined
          ? current !== undefined
          : current?.revision !== change.expectedRevision
      ) {
        return;
      }
    }
    for (const change of changes) {
      upsertTaskFlowRowInDatabase(db, bindTaskFlowRecord(change.flow));
    }
    applied = true;
  });
  return applied;
}

/** Binds only the exact flow selected before admission; lifecycle settlement stays owner-native. */
export async function bindTaskFlowExecution(params: {
  admitted: AdmittedRunContext;
  flowId: string;
  options?: Pick<OpenClawStateDatabaseOptions, "path" | "env">;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
}): Promise<ExecutionOwnerBindingResult> {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  const context = params.context ?? captureOpenClawStateWorkerContext(params.options);
  const input = { flowId: params.flowId, binding };
  const assertOwnerCurrent = params.assertCurrent;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertOwnerCurrent?.();
  };
  const [{ runOpenClawStateWorkerOperation }, { createSqliteWorkerWriteAdmission }] =
    await Promise.all([
      import("../state/openclaw-state-worker-store.js"),
      import("../infra/sqlite-worker-store.js"),
    ]);
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "flows.bindExecution", input }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

export function deleteTaskFlowRegistryRecordFromSqlite(flowId: string) {
  withWriteTransaction(({ db }) => {
    deleteTaskFlowRowInDatabase(db, flowId);
  });
}

export function closeTaskFlowRegistryDatabase() {
  cachedDatabase = null;
  closeOpenClawStateDatabase();
}
