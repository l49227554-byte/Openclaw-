import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import {
  readWorkerPlacementMovesReadOnly,
  type WorkerPlacementMoveIntent,
} from "./placement-move-intent.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";
import {
  hasCurrentWorkspaceResultClaim,
  readWorkerWorkspaceReconciliationFacts,
} from "./placement-workspace-result.js";
import { fromRow as decodeWorkerEnvironmentRow } from "./store.js";

export type WorkerEnvironmentPlacementFacts = Pick<
  WorkerEnvironmentRecord,
  | "environmentId"
  | "providerId"
  | "profileId"
  | "profileSnapshot"
  | "state"
  | "leaseId"
  | "ownerEpoch"
  | "nodeDeviceId"
  | "attachedSessionIds"
>;

export type WorkerSessionPlacementProjection = {
  placements: ReadonlyMap<string, WorkerSessionPlacementRecord>;
  moves: ReadonlyMap<string, WorkerPlacementMoveIntent>;
  workspaceResultReconcilingSessionIds: ReadonlySet<string>;
  environments: ReadonlyMap<string, WorkerEnvironmentPlacementFacts>;
};

export type WorkerPlacementConflictBinding = {
  placement: Pick<
    WorkerSessionPlacementRecord,
    "sessionId" | "generation" | "environmentId" | "activeOwnerEpoch"
  >;
  claim: WorkerSessionTurnClaim;
};

export function readWorkerSessionPlacementProjectionInDatabase(
  db: DatabaseSync,
  sessionIds: readonly string[],
  conflictBindings: readonly WorkerPlacementConflictBinding[],
) {
  return runSqliteDeferredTransactionSync(db, () => {
    const { placements, reconcilingSessionIds } = readWorkerWorkspaceReconciliationFacts(
      db,
      sessionIds,
    );
    const environments = new Map<string, WorkerEnvironmentPlacementFacts>();
    const environmentIds = [
      ...new Set(
        [...placements.values()].flatMap((placement) =>
          placement.environmentId ? [placement.environmentId] : [],
        ),
      ),
    ];
    for (let offset = 0; offset < environmentIds.length; offset += 250) {
      for (const row of executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<StateDatabase, "worker_environments">>(db)
          .selectFrom("worker_environments")
          .selectAll()
          .where("environment_id", "in", environmentIds.slice(offset, offset + 250)),
      ).rows) {
        const record = decodeWorkerEnvironmentRow(row, []);
        environments.set(record.environmentId, {
          environmentId: record.environmentId,
          providerId: record.providerId,
          profileId: record.profileId,
          profileSnapshot: record.profileSnapshot,
          state: record.state,
          leaseId: record.leaseId,
          ownerEpoch: record.ownerEpoch,
          nodeDeviceId: record.nodeDeviceId,
          attachedSessionIds: record.attachedSessionIds,
        });
      }
    }
    const projection: WorkerSessionPlacementProjection = {
      placements,
      moves: readWorkerPlacementMovesReadOnly(db, sessionIds),
      workspaceResultReconcilingSessionIds: reconcilingSessionIds,
      environments,
    };
    const conflictSessionIds = new Set<string>();
    for (const binding of conflictBindings) {
      const record = placements.get(binding.placement.sessionId);
      // Host-only conflict payloads belong to the captured placement or its retained result claim.
      if (
        record &&
        record.environmentId === binding.placement.environmentId &&
        record.activeOwnerEpoch === binding.placement.activeOwnerEpoch &&
        (record.generation === binding.placement.generation ||
          hasCurrentWorkspaceResultClaim(db, binding.claim))
      ) {
        conflictSessionIds.add(record.sessionId);
      }
    }
    return { projection, conflictSessionIds };
  });
}
