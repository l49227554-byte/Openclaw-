import { computeBackoff } from "../../packages/retry/src/index.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import {
  deliveryQueueEntriesQuery,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-bound.js";
import { inflateDeliveryQueueEntryResult } from "./delivery-queue-sqlite-codec.js";
import { terminalizeInvalidDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deliveryQueueEntryNotFoundError,
  getDeliveryQueueEntryOwnersInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "./kysely-sync.js";
import {
  hasOnlyGenericAttachmentRefs,
  scrubTerminalQueuedAttachments,
} from "./session-delivery-queue-attachment-metadata.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";
import type { SessionDeliveryWorkerOperations } from "./session-delivery-queue.worker-contract.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

function readSessionDeliveryResult(
  database: OpenClawStateDatabase,
  id: string,
): SessionDeliveryWorkerOperations["sessionDelivery.load"]["output"] {
  const query = deliveryQueueEntriesQuery(database, [SESSION_DELIVERY_QUEUE_NAME], "pending").where(
    "id",
    "=",
    id,
  );
  const row = executeSqliteQueryTakeFirstSync(database.db, query);
  return row ? inflateDeliveryQueueEntryResult(row) : null;
}

export function executeSessionDeliveryCommand(
  command: SqliteWorkerCommand<SessionDeliveryWorkerOperations>,
  database: OpenClawStateDatabase,
): SessionDeliveryWorkerOperations[keyof SessionDeliveryWorkerOperations]["output"] {
  const readStatus = (id: string) =>
    getDeliveryQueueEntryOwnersInDatabase(database, [SESSION_DELIVERY_QUEUE_NAME], id).get(
      SESSION_DELIVERY_QUEUE_NAME,
    )?.status;
  const update = (id: string, transform: (entry: QueuedSessionDelivery) => QueuedSessionDelivery) =>
    updateDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id, (entry) =>
      // SAFETY: Only the session namespace reaches this payload transform.
      transform(entry as QueuedSessionDelivery),
    );

  switch (command.type) {
    case "sessionDelivery.enqueue":
      upsertBoundDeliveryQueueEntryInDatabase(command.input, database);
      return;
    case "sessionDelivery.enqueueClaimed": {
      const id = command.input.row.id;
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(command.input, database);
      try {
        return { id, claimed, status: claimed ? "pending" : (readStatus(id) ?? "completed") };
      } catch {
        // A failed status read cannot undo the ownership established by the insert conflict.
        return { id, claimed, status: "unknown" };
      }
    }
    case "sessionDelivery.releaseClaim":
      update(command.input.id, (entry) => ({ ...entry, availableAt: Date.now() }));
      return;
    case "sessionDelivery.defer": {
      const { id, delayMs } = command.input;
      update(id, (entry) => ({
        ...entry,
        availableAt: Date.now() + Math.max(0, delayMs),
      }));
      return;
    }
    case "sessionDelivery.advanceAgentRun": {
      const { id, updates } = command.input;
      update(id, (entry) =>
        entry.kind !== "agentTurn"
          ? entry
          : {
              ...entry,
              agentRunAttempt: (entry.agentRunAttempt ?? 0) + 1,
              deliveryStartedAt: undefined,
              ...(updates?.message ? { message: updates.message } : {}),
              ...(updates?.expectedMediaUrls
                ? { expectedMediaUrls: updates.expectedMediaUrls }
                : {}),
              ...(updates?.suppressTextDelivery === true
                ? { suppressTextDelivery: true as const }
                : {}),
            },
      );
      return;
    }
    case "sessionDelivery.mergePreparedMedia": {
      const { id, mediaUrl, blocksJson } = command.input;
      let result: SessionDeliveryWorkerOperations["sessionDelivery.mergePreparedMedia"]["output"] =
        {
          source: "input",
        };
      update(id, (entry) => {
        if (entry.kind !== "agentTurn") {
          return entry;
        }
        const stored = entry.preparedMediaBlocks?.[mediaUrl];
        // SAFETY: The host serialized the caller's typed block array before worker admission.
        const blocks = stored ?? (JSON.parse(blocksJson) as Array<Record<string, unknown>>);
        if (stored != null) {
          result = { source: "stored", blocks: stored };
        }
        return {
          ...entry,
          preparedMediaBlocks: { ...entry.preparedMediaBlocks, [mediaUrl]: blocks },
        };
      });
      return result;
    }
    case "sessionDelivery.markAttemptStarted": {
      if (!upsertBoundDeliveryQueueEntryInDatabase(command.input, database)) {
        throw new Error(`Session delivery ${command.input.row.id} is no longer pending`);
      }
      return;
    }
    case "sessionDelivery.markSettlement": {
      const id = command.input.row.id;
      try {
        if (
          upsertBoundDeliveryQueueEntryInDatabase(command.input, database) ||
          readStatus(id) === "completed"
        ) {
          return;
        }
        throw new Error(`Session delivery ${id} is no longer pending`);
      } catch (error) {
        try {
          if (readStatus(id) === "completed") {
            return;
          }
        } catch {
          // Preserve the original failure when completion cannot be established.
        }
        throw error;
      }
    }
    case "sessionDelivery.complete": {
      const { id } = command.input;
      try {
        completeDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id);
      } catch (error) {
        try {
          if (readStatus(id) === "completed") {
            return;
          }
        } catch {
          // Preserve the original failure when completion cannot be established.
        }
        throw error;
      }
      return;
    }
    case "sessionDelivery.fail": {
      const { id, error, releaseAttemptOwnership } = command.input;
      update(id, (entry) => {
        const safeEntry =
          entry.kind === "postCompactionDelegate" || hasOnlyGenericAttachmentRefs(entry)
            ? entry
            : scrubTerminalQueuedAttachments(entry);
        const retryCount = safeEntry.retryCount + 1;
        const now = Date.now();
        return {
          ...safeEntry,
          retryCount,
          ...(safeEntry.kind === "agentTurn"
            ? { lastChargedAgentRunAttempt: safeEntry.agentRunAttempt ?? 0 }
            : {}),
          ...(releaseAttemptOwnership === true ? { deliveryStartedAt: undefined } : {}),
          lastAttemptAt: now,
          ...(safeEntry.kind === "agentTurn" && safeEntry.owner?.kind === "subagent_completion"
            ? {
                availableAt:
                  now +
                  computeBackoff(
                    { initialMs: 15_000, factor: 2, maxMs: 5 * 60_000, jitter: 0.2 },
                    retryCount,
                  ),
              }
            : {}),
          lastError: error,
        };
      });
      return;
    }
    case "sessionDelivery.failInvalid": {
      const { entry, error, entryJson } = command.input;
      terminalizeInvalidDeliveryQueueEntryInDatabase(database, {
        queueName: SESSION_DELIVERY_QUEUE_NAME,
        id: entry.id,
        lastError: error,
        entry: {
          id: entry.id,
          enqueuedAt: entry.enqueuedAt,
          retryCount: entry.retryCount,
          retainOnFailure: true,
        },
        expectedEntryJson: entryJson,
      });
      return;
    }
    case "sessionDelivery.load":
      return readSessionDeliveryResult(database, command.input.id);
    case "sessionDelivery.list": {
      return executeSqliteQuerySync(
        database.db,
        deliveryQueueEntriesQuery(database, [SESSION_DELIVERY_QUEUE_NAME], "pending")
          .orderBy("enqueued_at", "asc")
          .orderBy("id", "asc"),
      ).rows.map(inflateDeliveryQueueEntryResult);
    }
    case "sessionDelivery.moveToFailed": {
      const { id } = command.input;
      try {
        const result = readSessionDeliveryResult(database, id);
        if (result?.status !== "loaded") {
          throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
        }
        const entry = result.entry;
        const terminalized = terminalizePendingDeliveryQueueEntryInDatabase(
          database,
          prepareDeliveryQueueTerminalEntry({ queueName: SESSION_DELIVERY_QUEUE_NAME, id, entry }),
        );
        if (terminalized.status !== "terminalized") {
          throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
        }
      } catch (error) {
        try {
          if (readStatus(id) === "failed") {
            return;
          }
        } catch {
          // Preserve the original transition failure when durable state is unreadable.
        }
        throw error;
      }
    }
  }
}
