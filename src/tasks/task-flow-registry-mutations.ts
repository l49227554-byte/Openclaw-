import {
  applyFlowPatch,
  buildFlowRecord,
  cloneFlowRecord,
  type FlowRecordPatch,
  type ManagedTaskFlowCreateFields,
} from "./task-flow-registry.records.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import type { TaskFlowRegistryAtomicOwnerCondition } from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

export type TaskFlowAtomicUpdate = {
  flowId: string;
  expectedRevision: number;
  patch: FlowRecordPatch;
};

export type TaskFlowAtomicUpdateResult =
  | { applied: true; flows: TaskFlowRecord[] }
  | {
      applied: false;
      reason: "not_found" | "revision_conflict" | "persist_failed";
      flowId?: string;
      current?: TaskFlowRecord;
    };

export type TaskFlowAtomicCreateResult =
  | { applied: true; created: TaskFlowRecord; updated: TaskFlowRecord[] }
  | Exclude<TaskFlowAtomicUpdateResult, { applied: true }>;

type TaskFlowRegistryMutationContext = {
  ensureReady: () => void;
  getFlows: () => Map<string, TaskFlowRecord>;
  reloadFromStore: () => void;
  /** Owner-side projection bookkeeping for one committed flow write. */
  recordWrite: (flowId: string) => void;
  publishUpsert: (flow: TaskFlowRecord, previous?: TaskFlowRecord) => void;
  warn: (message: string, meta: Record<string, unknown>) => void;
};

export function createTaskFlowRegistryMutationApi(context: TaskFlowRegistryMutationContext) {
  function prepareTaskFlowAtomicUpdates(
    updates: readonly TaskFlowAtomicUpdate[],
  ):
    | { applied: true; entries: Array<{ current: TaskFlowRecord; next: TaskFlowRecord }> }
    | Exclude<TaskFlowAtomicUpdateResult, { applied: true }> {
    const flows = context.getFlows();
    const seenFlowIds = new Set<string>();
    const entries: Array<{ current: TaskFlowRecord; next: TaskFlowRecord }> = [];
    for (const update of updates) {
      if (seenFlowIds.has(update.flowId)) {
        const current = flows.get(update.flowId);
        return {
          applied: false,
          reason: "revision_conflict",
          flowId: update.flowId,
          ...(current ? { current: cloneFlowRecord(current) } : {}),
        };
      }
      seenFlowIds.add(update.flowId);
      const current = flows.get(update.flowId);
      if (!current) {
        return { applied: false, reason: "not_found", flowId: update.flowId };
      }
      if (current.revision !== update.expectedRevision) {
        return {
          applied: false,
          reason: "revision_conflict",
          flowId: update.flowId,
          current: cloneFlowRecord(current),
        };
      }
      entries.push({ current, next: applyFlowPatch(current, update.patch) });
    }
    return { applied: true, entries };
  }

  function commitTaskFlowAtomicChanges(params: {
    created: TaskFlowRecord;
    updates: readonly TaskFlowAtomicUpdate[];
    ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
  }): TaskFlowAtomicCreateResult;
  function commitTaskFlowAtomicChanges(params: {
    created?: undefined;
    updates: readonly TaskFlowAtomicUpdate[];
    ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
  }): TaskFlowAtomicUpdateResult;
  function commitTaskFlowAtomicChanges(params: {
    created?: TaskFlowRecord;
    updates: readonly TaskFlowAtomicUpdate[];
    ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
  }): TaskFlowAtomicCreateResult | TaskFlowAtomicUpdateResult {
    context.ensureReady();
    const prepared = prepareTaskFlowAtomicUpdates(params.updates);
    if (!prepared.applied) {
      return prepared;
    }
    const changed = [
      ...prepared.entries.map((entry) => entry.next),
      ...(params.created ? [params.created] : []),
    ];
    if (changed.length === 0) {
      return { applied: true, flows: [] };
    }
    try {
      const store = getTaskFlowRegistryStore();
      if (!store.upsertFlowsAtomically) {
        throw new Error("task-flow registry store does not support atomic writes");
      }
      const applied = store.upsertFlowsAtomically({
        changes: [
          ...prepared.entries.map((entry) => ({
            flow: cloneFlowRecord(entry.next),
            expectedRevision: entry.current.revision,
          })),
          ...(params.created ? [{ flow: cloneFlowRecord(params.created) }] : []),
        ],
        ...(params.ownerCondition ? { ownerCondition: params.ownerCondition } : {}),
      });
      if (!applied) {
        context.reloadFromStore();
        return { applied: false, reason: "revision_conflict" };
      }
    } catch (error) {
      context.warn("Failed to persist atomic task-flow changes", {
        createdFlowId: params.created?.flowId,
        updatedFlowIds: params.updates.map((update) => update.flowId),
        error,
      });
      return { applied: false, reason: "persist_failed" };
    }

    const flows = context.getFlows();
    for (const flow of changed) {
      flows.set(flow.flowId, flow);
      context.recordWrite(flow.flowId);
    }
    for (const entry of prepared.entries) {
      context.publishUpsert(cloneFlowRecord(entry.next), cloneFlowRecord(entry.current));
    }
    const created = params.created;
    if (created) {
      context.publishUpsert(cloneFlowRecord(created));
      return {
        applied: true,
        created: cloneFlowRecord(created),
        updated: prepared.entries.map((entry) => cloneFlowRecord(entry.next)),
      };
    }
    return {
      applied: true,
      flows: prepared.entries.map((entry) => cloneFlowRecord(entry.next)),
    };
  }

  function createManagedTaskFlowWithAtomicUpdates(params: {
    create: ManagedTaskFlowCreateFields;
    updates: readonly TaskFlowAtomicUpdate[];
    ownerCondition?: TaskFlowRegistryAtomicOwnerCondition;
  }): TaskFlowAtomicCreateResult {
    const created = buildFlowRecord({
      ...params.create,
      syncMode: "managed",
      controllerId: params.create.controllerId,
    });
    return commitTaskFlowAtomicChanges({
      created,
      updates: params.updates,
      ...(params.ownerCondition ? { ownerCondition: params.ownerCondition } : {}),
    });
  }

  function updateTaskFlowsAtomically(
    updates: readonly TaskFlowAtomicUpdate[],
  ): TaskFlowAtomicUpdateResult {
    return commitTaskFlowAtomicChanges({ updates });
  }

  return {
    createManagedTaskFlowWithAtomicUpdates,
    updateTaskFlowsAtomically,
  };
}
