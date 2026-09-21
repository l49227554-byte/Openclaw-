import { cleanupMaterializedSubagentAttachments } from "../subagent-attachment-cleanup.js";
import { terminateAcceptedCollectorRun } from "./subagent-spawn-cleanup.js";
import {
  type PreparedContextEngineSubagentSpawn,
  rollbackPreparedContextEngine,
} from "./subagent-spawn-context.js";
import { isSpawnSubagentAdmissionCancelledError } from "./subagent-spawn-contract.js";

export async function cleanupAcceptedSubagentSpawnFailure(params: {
  phase: "dispatch" | "register";
  error: unknown;
  runId: string;
  childSessionKey: string;
  acceptedChildRunId?: string;
  taskRowOwnership: "required" | "gateway_best_effort";
  contextEnginePreparation?: PreparedContextEngineSubagentSpawn;
  attachmentId?: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  emitLifecycleHooks: boolean;
  cleanupCreatedSession: (emitLifecycleHooks: boolean) => Promise<unknown>;
  /** Retained queued-registration ownership; false means another owner holds the child now. */
  isCurrent?: () => boolean;
}): Promise<void> {
  const cleanupFailures: unknown[] = [];
  const ownsChild = params.isCurrent?.() !== false;
  if (
    ownsChild &&
    params.phase === "register" &&
    params.acceptedChildRunId &&
    (params.taskRowOwnership === "required" || isSpawnSubagentAdmissionCancelledError(params.error))
  ) {
    try {
      const terminated = await terminateAcceptedCollectorRun({
        childSessionKey: params.childSessionKey,
        gatewayRunId: params.acceptedChildRunId,
        expectedSessionId: params.expectedSessionId,
        expectedLifecycleRevision: params.expectedLifecycleRevision,
        retry: false,
      });
      if (!terminated) {
        throw new Error(
          `Accepted child termination was not confirmed: ${params.acceptedChildRunId}`,
          { cause: params.error },
        );
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (!ownsChild) {
    await params.contextEnginePreparation?.dispose().catch(() => {});
  } else {
    try {
      if (
        !(await rollbackPreparedContextEngine(params.contextEnginePreparation)) &&
        params.phase === "register"
      ) {
        throw new Error("Prepared context rollback was not confirmed", { cause: params.error });
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (params.attachmentId && ownsChild) {
    try {
      await cleanupMaterializedSubagentAttachments({
        childSessionKey: params.childSessionKey,
        attachmentId: params.attachmentId,
        isCurrent: params.isCurrent,
      });
    } catch {
      // Best-effort cleanup only.
    }
  }
  try {
    await params.cleanupCreatedSession(params.emitLifecycleHooks);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length > 0) {
    const aggregate = new AggregateError(
      cleanupFailures,
      `Subagent spawn cleanup incomplete: ${params.acceptedChildRunId ?? params.runId}`,
    );
    aggregate.cause = cleanupFailures[0];
    throw aggregate;
  }
}
