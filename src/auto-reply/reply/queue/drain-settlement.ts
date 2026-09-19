import { expectDefined } from "../../../plugin-sdk/expect-runtime.js";
// Durable settlement for the follow-up drain.
//
// The drain decides what runs next; this module owns what happens to durable
// state once a turn settles: acknowledging it, tombstoning canceled, delivered,
// and discarded work, and capturing or restoring the summary queue around an
// overflow delivery. These helpers touch only SQLite persistence, the queue
// lifecycle, and the queue state shape, so they form a sibling module that the
// drain imports in one direction.
import { removeQueuedItemsByRef } from "../../../utils/queue-helpers.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import { persistFollowupQueuesOrThrow } from "./persist.js";
import { isFollowupRunAborted, type FollowupRun } from "./types.js";

export function persistDrainAcknowledgement(): void {
  // Settle AFTER successful delivery (or fail-closed discard). Keep SQLite
  // rows until then so a crash mid-send can redeliver; OrThrow fails closed.
  persistFollowupQueuesOrThrow();
}

function restoreRemovedFollowups(items: FollowupRun[], removed: readonly FollowupRun[]): void {
  for (const item of removed) {
    if (!items.includes(item)) {
      items.push(item);
    }
  }
}

export function persistDrainAcknowledgementOrRestore(
  items: FollowupRun[],
  removed: readonly FollowupRun[],
): void {
  try {
    persistDrainAcknowledgement();
  } catch (error) {
    restoreRemovedFollowups(items, removed);
    throw error;
  }
}

export function persistCanceledFollowupTombstones(canceled: readonly FollowupRun[]): void {
  for (const item of canceled) {
    item.canceled = true;
  }
  persistDrainAcknowledgement();
}

export function isSettledFollowupTombstone(item: FollowupRun): boolean {
  return item.delivered === true || item.discarded === true;
}

export function dropSettledFollowupTombstones(items: FollowupRun[]): number {
  const settled = items.filter(isSettledFollowupTombstone);
  if (settled.length === 0) {
    return 0;
  }
  persistDrainAcknowledgement();
  removeQueuedItemsByRef(items, settled);
  persistDrainAcknowledgementOrRestore(items, settled);
  return settled.length;
}

function persistQueueTombstones(
  queueItems: FollowupRun[],
  items: readonly FollowupRun[],
  flag: "delivered" | "discarded",
  reinsertMissing: boolean,
): void {
  for (const item of items) {
    if (flag === "delivered") {
      item.delivered = true;
    } else {
      item.discarded = true;
    }
    // Only reinsert known queue identities that admission already removed.
    // Synthetic overflow/collect aggregate runs must not re-enter FIFO.
    if (reinsertMissing && !queueItems.includes(item)) {
      queueItems.push(item);
    }
  }
  // Keep the in-memory terminal marker even if this write throws. Rolling
  // it back would make already-executed work runnable again on restore.
  persistDrainAcknowledgement();
}

export function persistSuccessfulDeliveryReceipts(
  queueItems: FollowupRun[],
  items: readonly FollowupRun[],
  reinsertMissing = false,
): void {
  persistQueueTombstones(queueItems, items, "delivered", reinsertMissing);
}

export function persistFailedDeliveryDiscards(
  queueItems: FollowupRun[],
  items: readonly FollowupRun[],
  reinsertMissing = false,
): void {
  persistQueueTombstones(queueItems, items, "discarded", reinsertMissing);
}

function captureSummaryQueueState(queue: FollowupQueueSummaryState) {
  return {
    summarySources: queue.summarySources.slice(),
    summaryLines: queue.summaryLines.slice(),
    summaryElisions: queue.summaryElisions.map((elision) => ({
      contextKey: elision.contextKey,
      count: elision.count,
      sources: elision.sources.slice(),
      summaryLines: elision.summaryLines.slice(),
      sourceRefs: elision.sourceRefs,
    })),
    droppedCount: queue.droppedCount,
  };
}

function restoreSummaryQueueState(
  queue: FollowupQueueSummaryState,
  snapshot: ReturnType<typeof captureSummaryQueueState>,
): void {
  queue.summarySources.splice(0, queue.summarySources.length, ...snapshot.summarySources);
  queue.summaryLines.splice(0, queue.summaryLines.length, ...snapshot.summaryLines);
  queue.summaryElisions.splice(0, queue.summaryElisions.length, ...snapshot.summaryElisions);
  queue.droppedCount = snapshot.droppedCount;
}

export function consumeCanceledQueueSummarySources(
  queue: FollowupQueueSummaryState,
  canceled: readonly FollowupRun[],
): void {
  persistCanceledFollowupTombstones(canceled);
  const snapshot = captureSummaryQueueState(queue);
  try {
    consumeQueueSummaryDelivery(queue, {
      droppedCount: canceled.length,
      sources: [...canceled],
    });
    persistDrainAcknowledgement();
  } catch (error) {
    restoreSummaryQueueState(queue, snapshot);
    throw error;
  }
}

export function removeCanceledFollowups(
  items: FollowupRun[],
  canceled: readonly FollowupRun[],
): void {
  removeQueuedItemsByRef(items, canceled);
  for (const item of canceled) {
    completeFollowupRunLifecycle(item);
  }
}

export type FollowupQueueSummaryState = {
  cap: number;
  inFlight: Set<FollowupRun>;
  droppedCount: number;
  summaryLines: string[];
  summarySources: FollowupRun[];
  activeSummarySources: WeakSet<FollowupRun>;
  summaryElisions: Array<{
    contextKey: string;
    count: number;
    sources: FollowupRun[];
    summaryLines: string[];
    sourceRefs: WeakMap<FollowupRun, FollowupRun>;
  }>;
  evictedSummaryCount: number;
};

export function dropAbortedQueueSummarySources(queue: FollowupQueueSummaryState): number {
  const aborted: FollowupRun[] = [];
  for (const source of queue.summarySources) {
    if (isFollowupRunAborted(source)) {
      aborted.push(source);
    }
  }
  for (const elision of queue.summaryElisions) {
    for (const source of elision.sources) {
      if (isFollowupRunAborted(source)) {
        aborted.push(source);
      }
    }
  }
  if (aborted.length === 0) {
    return 0;
  }
  consumeCanceledQueueSummarySources(queue, aborted);
  return aborted.length;
}

export type QueueSummaryDelivery = {
  prompt: string;
  droppedCount: number;
  sources: FollowupRun[];
};

export function consumeQueueSummaryDelivery(
  queue: FollowupQueueSummaryState,
  delivery: Pick<QueueSummaryDelivery, "droppedCount" | "sources">,
  completeLifecycles = true,
): void {
  let consumedCount = delivery.sources.length === 0 ? delivery.droppedCount : 0;
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    if (sourceIndex >= 0) {
      queue.summarySources.splice(sourceIndex, 1);
      queue.summaryLines.splice(sourceIndex, 1);
      consumedCount += 1;
    } else {
      const elisionIndex = queue.summaryElisions.findIndex(
        (entry) => entry.sources.includes(source) || entry.sourceRefs.has(source),
      );
      if (elisionIndex >= 0) {
        const entry = expectDefined(
          queue.summaryElisions[elisionIndex],
          "summary elisions entry at elision index",
        );
        const elidedSourceIndex = entry.sources.indexOf(entry.sourceRefs.get(source) ?? source);
        if (elidedSourceIndex >= 0) {
          entry.sources.splice(elidedSourceIndex, 1);
          entry.summaryLines.splice(elidedSourceIndex, 1);
        }
        entry.count = entry.sources.length;
        consumedCount += 1;
        if (entry.sources.length === 0) {
          queue.summaryElisions.splice(elisionIndex, 1);
        }
      }
    }
    if (completeLifecycles) {
      completeFollowupRunLifecycle(source);
    }
  }
  queue.droppedCount = Math.max(0, queue.droppedCount - consumedCount);
}

export function releaseQueueSummaryDeliveryForRetry(
  queue: FollowupQueueSummaryState,
  delivery: QueueSummaryDelivery,
): void {
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    if (sourceIndex >= 0) {
      queue.summarySources[sourceIndex] = createOverflowSummaryRetrySource(source);
    }
    if (!source.turnAdoptionLifecycle) {
      completeFollowupRunLifecycle(source);
    }
  }
}

export function createOverflowSummaryRetrySource(source: FollowupRun): FollowupRun {
  return {
    prompt: source.prompt,
    queueAbortSignal: source.queueAbortSignal,
    transcriptPrompt: source.transcriptPrompt,
    userTurnTranscriptRecorder: source.userTurnTranscriptRecorder,
    explicitSkillSelections: source.explicitSkillSelections,
    toolsAllow: source.toolsAllow,
    disableTools: source.disableTools,
    images: source.images,
    imageOrder: source.imageOrder,
    media: source.media,
    channelAdmissionEvidence: source.channelAdmissionEvidence,
    messageId: source.messageId,
    summaryLine: source.summaryLine,
    enqueuedAt: source.enqueuedAt,
    originatingChannel: source.originatingChannel,
    originatingTo: source.originatingTo,
    originatingAccountId: source.originatingAccountId,
    originatingThreadId: source.originatingThreadId,
    originatingChatId: source.originatingChatId,
    originatingReplyToId: source.originatingReplyToId,
    originatingReplyToMode: source.originatingReplyToMode,
    originatingChatType: source.originatingChatType,
    abortSignal: source.abortSignal,
    turnAdoptionLifecycle: source.turnAdoptionLifecycle,
    replyOperationRunStates: source.replyOperationRunStates,
    queuedFollowupReplyDisposition: source.queuedFollowupReplyDisposition,
    ...(source.currentInboundEventKind === "room_event"
      ? { currentInboundEventKind: "room_event" }
      : {}),
    // A retry copy keeps terminal settlement. Dropping these markers would make
    // work that already executed, failed delivery, or was canceled runnable again.
    ...(source.canceled === true ? { canceled: true as const } : {}),
    ...(source.delivered === true ? { delivered: true as const } : {}),
    ...(source.discarded === true ? { discarded: true as const } : {}),
    run: source.run,
  };
}
