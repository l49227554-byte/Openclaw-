import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayDetachedWorkContinuation } from "../../../process/gateway-work-admission.js";
import { finalizeTaskRunByRunId } from "../../../tasks/detached-task-runtime.js";
import { prepareCanonicalTaskActivation } from "../../../tasks/task-backing-authority-write.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import type { AgentRunSessionTarget } from "../../run-session-target.js";
import { replaceRequesterCronAuthorityEntry } from "../requester-cron-authority.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  normalizeSubagentRunState,
} from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { resolveFinalizedSubagentTaskState } from "./subagent-registry-completion.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { commitSubagentTaskReplacement } from "./subagent-registry-replacement-store.js";
import { SubagentWaitManager } from "./subagent-registry-run-wait.js";
import type {
  RequesterSettleWakeState,
  SubagentAcceptedSteerDispatch,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
} from "./subagent-session-metrics.js";

const log = createSubsystemLogger("agents/subagent-registry");

export class SubagentRecoveryManager extends SubagentWaitManager {
  readonly markSubagentRunForSteerRestart = (
    runId: string,
    expected?: SubagentRunRecord,
  ): boolean => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = this.options.runs.get(key);
    if (
      !entry ||
      (expected && entry !== expected) ||
      entry.execution.restartRecovery ||
      entry.killIntent ||
      entry.killReconciliation
    ) {
      return false;
    }
    if (entry.suppressAnnounceReason === "steer-restart") {
      return false;
    }
    entry.suppressAnnounceReason = "steer-restart";
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (error) {
      entry.suppressAnnounceReason = undefined;
      throw error;
    }
    return true;
  };

  readonly clearSubagentRunSteerRestart = (
    runId: string,
    expected?: SubagentRunRecord,
    acceptedDispatch?: SubagentAcceptedSteerDispatch,
    requirePersistence = false,
  ): boolean => {
    const key = runId.trim();
    if (!key) {
      return false;
    }
    const entry = this.options.runs.get(key);
    if (!entry || (expected && entry !== expected)) {
      return false;
    }
    if (acceptedDispatch && entry.acceptedSteerDispatch !== acceptedDispatch) {
      return false;
    }
    const previousSuppressAnnounceReason = entry.suppressAnnounceReason;
    const previousAcceptedSteerDispatch = entry.acceptedSteerDispatch;
    const persistClear = () => {
      try {
        if (requirePersistence) {
          this.options.persistOrThrow(entry.runId);
        } else {
          this.options.persist(entry.runId);
        }
        return true;
      } catch (error) {
        entry.suppressAnnounceReason = previousSuppressAnnounceReason;
        entry.acceptedSteerDispatch = previousAcceptedSteerDispatch;
        log.warn("failed to persist steer dispatch ownership cleanup", {
          error,
          runId: entry.runId,
        });
        this.options.startSweeper();
        this.options.scheduleSweep({ delayMs: 1_000 });
        return false;
      }
    };
    if (entry.suppressAnnounceReason !== "steer-restart") {
      if (acceptedDispatch) {
        entry.acceptedSteerDispatch = undefined;
        return persistClear();
      }
      return true;
    }
    if (typeof entry.execution.endedAt === "number") {
      const taskResolution = this.options.resolveSubagentTask(entry);
      const task = taskResolution.lookup === "available" ? taskResolution.task : undefined;
      const terminal =
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED
          ? {
              status: "cancelled" as const,
              endedAt: entry.execution.endedAt,
              lastEventAt: entry.execution.endedAt,
              error: "Subagent restart failed after the prior run was interrupted.",
            }
          : resolveFinalizedSubagentTaskState(entry);
      if (terminal) {
        const targetRunId = task?.runId ?? entry.taskRunId ?? entry.runId;
        const targetSessionKey = task?.childSessionKey ?? entry.childSessionKey;
        try {
          finalizeTaskRunByRunId({
            runId: targetRunId,
            runtime: "subagent",
            sessionKey: targetSessionKey,
            ...terminal,
            suppressDelivery: true,
          });
        } catch (err) {
          log.warn("failed to finalize abandoned steer-restart task run", {
            err,
            runId: targetRunId,
            childSessionKey: targetSessionKey,
          });
        }
      }
    }
    entry.suppressAnnounceReason = undefined;
    entry.acceptedSteerDispatch = undefined;
    if (!persistClear()) {
      return false;
    }
    this.options.resumedRuns.delete(key);
    if (typeof entry.execution.endedAt === "number" && !entry.cleanupCompletedAt) {
      this.options.resumeSubagentRun(key);
    }
    return true;
  };

  readonly recordAcceptedSubagentSteerDispatch = (recordParams: {
    runId: string;
    expected: SubagentRunRecord;
    gatewayRunId: string;
    phase?: SubagentAcceptedSteerDispatch["phase"];
    lifecycleGeneration?: string;
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
  }):
    | {
        status: "persisted" | "pending-persistence";
        ownerRunId: string;
        owner: SubagentRunRecord;
        dispatch: SubagentAcceptedSteerDispatch;
      }
    | { status: "rejected" } => {
    const runId = recordParams.runId.trim();
    const gatewayRunId = recordParams.gatewayRunId.trim();
    if (!runId || !gatewayRunId) {
      return { status: "rejected" };
    }
    const exactEntry = this.options.runs.get(runId);
    const entry =
      exactEntry === recordParams.expected
        ? exactEntry
        : [...this.options.getRunsForChildSession(recordParams.expected.childSessionKey)]
            .toSorted(compareSubagentRunGeneration)
            .at(-1);
    const owner = entry ?? recordParams.expected;
    if (!entry && !this.options.runs.has(owner.runId)) {
      this.options.runs.set(owner.runId, owner);
    }
    const acceptedSteerDispatch = {
      gatewayRunId,
      phase: recordParams.phase,
      lifecycleGeneration: recordParams.lifecycleGeneration?.trim() || undefined,
      expectedSessionId: recordParams.expectedSessionId?.trim() || undefined,
      expectedLifecycleRevision: recordParams.expectedLifecycleRevision?.trim() || undefined,
    };
    owner.acceptedSteerDispatch = acceptedSteerDispatch;
    let result: "persisted" | "pending-persistence" = "persisted";
    try {
      this.options.persistOrThrow(owner.runId);
    } catch (error) {
      result = "pending-persistence";
      log.warn("failed to persist accepted steer dispatch; retaining live owner", {
        error,
        runId: owner.runId,
        gatewayRunId,
      });
    }
    this.options.startSweeper();
    this.options.scheduleSweep({ delayMs: 1_000 });
    return {
      status: result,
      ownerRunId: owner.runId,
      owner,
      dispatch: acceptedSteerDispatch,
    };
  };

  readonly replaceSubagentRunAfterSteer = (replaceParams: {
    previousRunId: string;
    nextRunId: string;
    fallback?: SubagentRunRecord;
    expected?: SubagentRunRecord;
    runTimeoutSeconds?: number;
    allowEndedSource?: boolean;
    preserveFrozenResultFallback?: boolean;
    // A follow-up that continues a paused run inherits the original requester's
    // wake credential. An operator steer intentionally drops it: the operator is
    // already the live audience, so re-arming would wake a requester that is no
    // longer waiting. Without this the yielded parent loses its only wake path
    // and its settle batch defers with nothing recording why.
    preserveRequesterSettleWake?: boolean;
    transcriptTarget?: AgentRunSessionTarget;
    task?: string;
    lifecycleGeneration?: string;
    persistenceFailure?: "return-false" | "throw";
    gatewayContextResolver?: GatewayContextResolver;
  }): boolean => {
    const previousRunId = replaceParams.previousRunId.trim();
    const nextRunId = replaceParams.nextRunId.trim();
    if (!previousRunId || !nextRunId) {
      return false;
    }
    if (
      replaceParams.lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(replaceParams.lifecycleGeneration)
    ) {
      return false;
    }

    const previous = this.options.runs.get(previousRunId);
    if (replaceParams.expected && previous !== replaceParams.expected) {
      return false;
    }
    if (
      replaceParams.expected &&
      previous &&
      ((typeof previous.execution.endedAt === "number" &&
        replaceParams.allowEndedSource !== true) ||
        previous.killReconciliation !== undefined ||
        previous.killIntent !== undefined)
    ) {
      return false;
    }
    const source = previous ?? replaceParams.fallback;
    if (!source) {
      return false;
    }
    const sourceSnapshot = structuredClone(source);

    const now = Date.now();
    const generation = nextSubagentRunGeneration(
      [...this.options.getRunsForChildSession(source.childSessionKey), source],
      source.childSessionKey,
    );
    const cfg = this.options.getRuntimeConfig();
    const spawnMode = source.spawnMode === "session" ? "session" : "run";
    const runTimeoutSeconds = replaceParams.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const preserveFrozenResultFallback = replaceParams.preserveFrozenResultFallback === true;
    const sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
    const accumulatedRuntimeMs =
      getSubagentSessionRuntimeMs(
        source,
        typeof source.execution.endedAt === "number" ? source.execution.endedAt : now,
      ) ?? 0;

    const sourceCompletion = ensureCompletionState(source);
    // Follow-up work keeps the latest direction in the task's durable record.
    const nextTask =
      typeof replaceParams.task === "string" && replaceParams.task.length > 0
        ? replaceParams.task
        : source.task;
    // The frozen batch is addressed by runId. Adoption retires the previous id,
    // so an unmapped membership list would drop this row from its own batch and
    // let the wave complete without ever waking the requester.
    const sourceRequesterSettleWake = replaceParams.preserveRequesterSettleWake
      ? source.requesterSettleWake
      : undefined;
    const remapRequesterSettleWake = (
      wake: RequesterSettleWakeState,
    ): RequesterSettleWakeState => ({
      ...wake,
      ...(wake.batchRunIds
        ? {
            batchRunIds: wake.batchRunIds
              .map((runId) => (runId === previousRunId ? nextRunId : runId))
              .toSorted(),
          }
        : {}),
    });
    const next: SubagentRunRecord = normalizeSubagentRunState({
      ...source,
      runId: nextRunId,
      // Materialize the legacy run-id fallback so later replacements keep the
      // same canonical task owner after this source row is retired.
      taskRunId: source.taskRunId ?? source.runId,
      task: nextTask,
      generation,
      createdAt: now,
      sessionStartedAt,
      accumulatedRuntimeMs,
      endedReason: undefined,
      pauseReason: undefined,
      endedHookEmittedAt: undefined,
      browserCleanupDispatchedAt: undefined,
      deleteCleanupDispatchedAt: undefined,
      wakeOnDescendantSettle: undefined,
      requesterSettleWake: sourceRequesterSettleWake
        ? remapRequesterSettleWake(sourceRequesterSettleWake)
        : undefined,
      execution: {
        status: "running",
        startedAt: now,
        lifecycleGeneration:
          replaceParams.lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
        transcriptTarget: replaceParams.transcriptTarget,
      },
      swarmLaunchPending: false,
      completion: {
        required: source.expectsCompletionMessage === true,
        fallbackResultText: preserveFrozenResultFallback ? sourceCompletion.resultText : undefined,
        fallbackCapturedAt: preserveFrozenResultFallback ? sourceCompletion.capturedAt : undefined,
      },
      cleanupCompletedAt: undefined,
      cleanupHandled: false,
      suppressAnnounceReason: undefined,
      terminalOwner: undefined,
      killReconciliation: undefined,
      killIntent: undefined,
      suppressCompletionDelivery: undefined,
      delivery: {
        status: source.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      spawnMode,
      archiveAtMs: undefined,
      runTimeoutSeconds,
    });
    bindGatewayContextResolver(
      next,
      replaceParams.gatewayContextResolver ?? getGatewayContextResolver(source),
    );
    clearDeliveryState(next);

    const taskActivation =
      source.expectsCompletionMessage === false
        ? undefined
        : prepareCanonicalTaskActivation({
            runtime: "subagent",
            childSessionKey: next.childSessionKey,
            runId: source.taskRunId ?? source.runId,
            detail: createSubagentTaskBackingDetail(generation),
            startedAt: now,
            // An admitted kill owns the provisional task projection until its
            // reconciliation settles. An unclaimed marker yields to the admitted
            // successor and must not leave its task cancelled.
            preserveProvisionalCancellation:
              source.killReconciliation?.taskCancellationAccepted === true,
          });

    if (previousRunId !== nextRunId) {
      this.options.runs.delete(previousRunId);
    }
    this.options.runs.set(nextRunId, next);
    const killReconciliationSnapshots = this.markOlderKillReconciliationsSuperseded(next);
    const wakeSnapshots = new Map<SubagentRunRecord, RequesterSettleWakeState>();
    // Every member carries the frozen cohort. Remap them atomically with the
    // successor so a settled sibling cannot drop a still-running replacement.
    for (const memberRunId of sourceRequesterSettleWake?.batchRunIds ?? []) {
      const member = this.options.runs.get(memberRunId);
      const wake = member?.requesterSettleWake;
      if (
        !member ||
        member === next ||
        member.requesterSessionKey !== source.requesterSessionKey ||
        member.requesterAgentId !== source.requesterAgentId ||
        !wake?.batchRunIds?.includes(previousRunId) ||
        wake.rearmGeneration !== sourceRequesterSettleWake?.rearmGeneration
      ) {
        continue;
      }
      wakeSnapshots.set(member, wake);
      member.requesterSettleWake = remapRequesterSettleWake(wake);
    }
    const changedRunIds = [
      previousRunId,
      nextRunId,
      ...[...killReconciliationSnapshots.keys()].map((entry) => entry.runId),
      ...[...wakeSnapshots.keys()].map((entry) => entry.runId),
    ];
    try {
      if (taskActivation) {
        commitSubagentTaskReplacement({
          runs: this.options.runs,
          changedRunIds,
          source: sourceSnapshot,
          successor: next,
          task: taskActivation,
        });
      } else {
        this.options.persistOrThrow(...changedRunIds);
      }
    } catch (error) {
      this.restoreKillReconciliationSnapshots(killReconciliationSnapshots);
      for (const [member, wake] of wakeSnapshots) {
        member.requesterSettleWake = wake;
      }
      this.options.runs.delete(nextRunId);
      this.options.runs.set(previousRunId, source);
      log.warn("failed to persist replacement subagent recovery run; restored source lease", {
        error,
        previousRunId,
        nextRunId,
      });
      if (
        replaceParams.persistenceFailure === "return-false" ||
        replaceParams.lifecycleGeneration !== undefined
      ) {
        return false;
      }
      throw error;
    }
    // Atomic publication can synchronously trigger another replacement. Do not
    // start stale cleanup or completion work after that newer owner takes over.
    if (this.options.runs.get(nextRunId) !== next) {
      return true;
    }
    replaceRequesterCronAuthorityEntry({
      previous: source,
      next,
      preserve: replaceParams.preserveRequesterSettleWake === true,
    });
    if (!taskActivation) {
      subagentRuns.commitOwnership(next);
    }
    if (previousRunId !== nextRunId) {
      this.options.clearPendingLifecycleError(previousRunId);
      this.options.resumedRuns.delete(previousRunId);
      if (this.shouldDeleteAttachments(source)) {
        void safeRemoveAttachmentsDir(source);
      }
      if (
        source.execution.transcriptTarget &&
        source.execution.transcriptTarget !== replaceParams.transcriptTarget
      ) {
        const retiredTarget = source.execution.transcriptTarget;
        // The committed replacement owns cleanup beyond its caller's lifetime,
        // including when restart closes admission before this tail settles.
        void runWithGatewayDetachedWorkContinuation(
          () => removeInternalSessionEffectsSession(retiredTarget),
          "subagents:replacement-cleanup",
        ).catch((error: unknown) => {
          log.warn("failed to remove replaced subagent internal session effects", {
            previousRunId,
            nextRunId,
            error,
          });
        });
      }
    }
    this.options.ensureListener();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    this.options.startSweeper();
    void this.waitForSubagentCompletion(nextRunId, waitTimeoutMs, next);
    return true;
  };
}
