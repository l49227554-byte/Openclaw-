/**
 * Subagent spawn executor.
 *
 * Validates spawn requests, prepares child sessions, stages attachments, binds delivery context, and registers runs.
 */
import { isExecutionIdentityCollectionEnabled } from "../../../audit/audit-config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { getCanonicalGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { recordSessionCreated } from "../../../sessions/session-created.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { recordSubagentSpawned } from "../../../sessions/session-state-events.js";
import { parseInlineAttachmentMountPath } from "../../../shared/inline-attachments.js";
import { hasDeliveryTargetFields } from "../../../utils/delivery-context.shared.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "../../spawn-pipeline.js";
import {
  deriveContinuationDelegateChildRunId,
  deriveContinuationDelegateChildSessionKey,
} from "../../subagent-continuation-ids.js";
import { registerSubagentTraceparentHandoff } from "../../subagent-traceparent-handoff.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import {
  buildContinuationSessionPatch,
  type ContinuationSpawnParams,
} from "../announce/subagent-announce.runtime.js";
import {
  recordAcceptedSubagentSpawnRollback,
  rollbackSubagentRunRegistration,
} from "../registry/subagent-registry.js";
import { activateSwarmRun, holdQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { readParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import { materializeSubagentAttachments } from "./subagent-attachments.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import {
  cleanupFailedSpawnBeforeAgentStart,
  cleanupProvisionalSession,
} from "./subagent-spawn-cleanup.js";
import { createCollectorLaunchCallbacks } from "./subagent-spawn-collector.js";
import {
  prepareContextEngineSubagentSpawn,
  prepareSubagentSessionContext,
  rollbackPreparedContextEngine,
  type PreparedContextEngineSubagentSpawn,
} from "./subagent-spawn-context.js";
import type {
  SpawnSubagentContext as BaseSpawnSubagentContext,
  SpawnSubagentParams as BaseSpawnSubagentParams,
  SpawnSubagentResult as BaseSpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { isSpawnSubagentAdmissionCancelledError } from "./subagent-spawn-contract.js";
import { setSubagentSpawnDepsForTest } from "./subagent-spawn-deps.js";
import { prepareSubagentSpawnEnvelope } from "./subagent-spawn-envelope.js";
import {
  buildSubagentExecutionSessionSpawnContext,
  withSubagentGatewayExecutionIdentity,
} from "./subagent-spawn-execution-identity.js";
import { callNativeSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";
import { createSubagentSpawnLifecycleEmitter } from "./subagent-spawn-lifecycle.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { cleanupAcceptedSubagentSpawnFailure } from "./subagent-spawn-rollback.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import { bindThreadForSubagentSpawn } from "./subagent-spawn-thread-binding.js";
import { emitSessionLifecycleEvent, mergeDeliveryContext } from "./subagent-spawn.runtime.js";

export { SUBAGENT_SPAWN_CONTEXT_MODES, SUBAGENT_SPAWN_MODES } from "./subagent-spawn.types.js";

export type SpawnSubagentParams = BaseSpawnSubagentParams & ContinuationSpawnParams;
export type SpawnSubagentContext = BaseSpawnSubagentContext;
export type SpawnSubagentResult = BaseSpawnSubagentResult;

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const assertActive = ctx.assertActive;
  const promptedAt = Date.now();
  const label = params.label?.trim() || "";
  const task = params.task;
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterSessionKey = ctx.agentSessionKey;
  if (params.drainsContinuationDelegateQueue && !params.continuationChainState) {
    return {
      status: "error",
      error: "continuationChainState is required when drainsContinuationDelegateQueue is true",
    };
  }
  const gatewayContextResolver = getGatewayToolCallerIdentity()?.gatewayContextResolver;
  const requestResolution = resolveSubagentSpawnRequest(params, ctx);
  if (!requestResolution.ok) {
    return requestResolution.result;
  }
  const {
    request: {
      taskName,
      spawnMode,
      cleanup,
      expectsCompletionMessage,
      completionRequesterSessionId,
    },
    runtime: {
      hookRunner,
      cfg,
      runTimeoutSeconds,
      contextMode,
      requesterInternalKey,
      ownership,
      requesterAgentId,
      targetAgentId,
    },
    swarm: {
      config: swarmConfig,
      groupId: swarmGroupId,
      schedulerGroupKey: swarmSchedulerGroupKey,
      launchReplayKey: swarmLaunchReplayKey,
      soleImplicitMember,
      reservationPending,
    },
    admission: {
      resolve: resolveAdmission,
      initial: admission,
      reservation: admissionReservation,
      childDepth,
      maxSpawnDepth,
      continuationTargetSessionKeys,
      continuationRecipientAuthorityBinding,
    },
    childIdem: resolvedChildIdem,
  } = requestResolution.resolved;
  const childIdem = params.continuationDelegateFlowId
    ? deriveContinuationDelegateChildRunId(params.continuationDelegateFlowId)
    : resolvedChildIdem;

  let threadBindingReady = false;
  let hasBoundThreadDeliveryOrigin = false;
  let childRunId: string = childIdem;
  let swarmReservationPending = reservationPending;
  const swarmReservation = reservationPending ? holdQueuedSwarmRun(childIdem) : undefined;
  let canCleanupCreatedSession: (() => boolean) | undefined;
  let canRetireReservation: (() => boolean) | undefined;
  let contextEnginePreparation: PreparedContextEngineSubagentSpawn | undefined;
  try {
    if (reservationPending && !swarmReservation) {
      return { status: "error", error: "Collector FIFO reservation is no longer current" };
    }
    const childPlan = await resolveSubagentChildPlan({
      request: params,
      ctx,
      cfg,
      requesterInternalKey,
      requesterAgentId,
      targetAgentId,
      sandboxMode,
      swarmEnabled: swarmConfig.enabled,
      requesterSandboxed: ctx.sandboxed,
    });
    if (!childPlan.ok) {
      return childPlan.result;
    }
    const {
      spawnedCwd,
      toolSpawnMetadata,
      spawnedWorkspaceDir,
      requesterOrigin,
      incognito,
      childSessionKey: resolvedChildSessionKey,
      childRuntimeSandboxed,
      creationPolicy,
      targetAgentDir,
      modelPlan: plan,
      launchAuthorization,
      resolvedModelMetadata,
    } = childPlan.resolved;
    const childSessionKey = params.continuationDelegateFlowId
      ? deriveContinuationDelegateChildSessionKey(targetAgentId, params.continuationDelegateFlowId)
      : resolvedChildSessionKey;
    let { childSessionOrigin } = childPlan.resolved;
    const spawnedByKey = requesterInternalKey;
    const { resolvedModel, thinkingOverride } = plan;
    const initialSession = await createInitialSubagentSession({
      assertActive,
      cfg,
      targetAgentId,
      childSessionKey,
      label: label || undefined,
      incognito,
      requesterInternalKey,
      creationPolicy,
      completionOwnerSessionKey: ownership.completionRequesterSessionKey,
      spawnedWorkspaceDir,
      spawnedCwd,
      sessionPermissionPolicy: ctx.sessionPermissionPolicy,
      admissionPatch: admission.childSessionPatch,
      inheritedToolAllowlist: ctx.inheritedToolAllowlist,
      inheritedToolDenylist: ctx.inheritedToolDenylist,
      modelPatch: plan.initialSessionPatch,
      continuationPatch: buildContinuationSessionPatch(params),
      swarmGroupId,
      collect: params.collect === true,
      outputSchema: params.outputSchema,
      continuationDelegateAdmission: ctx.continuationDelegateAdmission,
    });
    if (initialSession.status === "error") {
      return {
        status: "error",
        error: initialSession.error,
        childSessionKey,
      };
    }
    let provisionalSessionIdentity = {
      expectedSessionId: initialSession.entry?.sessionId,
      expectedLifecycleRevision: initialSession.entry?.lifecycleRevision,
    };
    const cleanupCreatedSession = (emitLifecycleHooks = false) =>
      cleanupProvisionalSession(childSessionKey, {
        emitLifecycleHooks,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
        ...(canCleanupCreatedSession ? { isCurrent: canCleanupCreatedSession } : {}),
      });
    const preparedSpawnContext = await prepareSubagentSessionContext({
      assertActive,
      cfg,
      contextMode,
      requesterAgentId,
      targetAgentId,
      requesterInternalKey,
      childSessionKey,
    });
    if (preparedSpawnContext.status === "error") {
      await cleanupCreatedSession();
      return {
        status: "error",
        error: preparedSpawnContext.error,
        childSessionKey,
      };
    }
    const childEntry = preparedSpawnContext.childEntry ?? initialSession.entry;
    if (childEntry) {
      // Only preparation's committed entry can advance cleanup ownership. A reread
      // of the key could capture a reset/rebound successor that this spawn does not own.
      provisionalSessionIdentity = {
        expectedSessionId: childEntry.sessionId,
        expectedLifecycleRevision: childEntry.lifecycleRevision,
      };
    }
    if (requestThreadBinding) {
      const bindResult = await bindThreadForSubagentSpawn({
        assertActive,
        cfg,
        childSessionKey,
        agentId: targetAgentId,
        label: label || undefined,
        mode: spawnMode,
        requesterSessionKey: ownership.controllerSessionKey,
        requester: {
          channel: childSessionOrigin?.channel,
          accountId: childSessionOrigin?.accountId,
          to: childSessionOrigin?.to,
          threadId: childSessionOrigin?.threadId,
        },
      });
      if (bindResult.status === "error") {
        await cleanupCreatedSession();
        return {
          status: "error",
          error: bindResult.error,
          childSessionKey,
        };
      }
      threadBindingReady = true;
      hasBoundThreadDeliveryOrigin = hasDeliveryTargetFields(bindResult.deliveryOrigin);
      childSessionOrigin =
        mergeDeliveryContext(bindResult.deliveryOrigin, childSessionOrigin) ?? childSessionOrigin;
    }
    const parsedMountPath = parseInlineAttachmentMountPath(params.attachMountPath);
    const mountPathHint =
      parsedMountPath.status === "valid" ? parsedMountPath.mountPath : undefined;

    const preparedEnvelope = prepareSubagentSpawnEnvelope({
      cfg,
      collect: params.collect === true,
      requestThreadBinding,
      completionTarget: params.completionTarget,
      spawnMode,
      hasBoundThreadDeliveryOrigin,
      expectsCompletionMessage,
      soleCollectorChild: soleImplicitMember,
      task,
      requesterSessionKey,
      requesterOrigin: childSessionOrigin,
      childSessionKey,
      label: label || undefined,
      childRuntimeSandboxed,
      childDepth,
      maxSpawnDepth,
      drainsContinuationDelegateQueue: params.drainsContinuationDelegateQueue === true,
      outputSchema: params.outputSchema,
    });
    const { completionMode, envelope } = preparedEnvelope;
    let { childSystemPrompt } = preparedEnvelope;

    let retainOnSessionKeep = false;
    let attachmentsReceipt: SpawnSubagentResult["attachments"];
    let attachmentId: string | undefined;

    const materializedAttachments = await materializeSubagentAttachments({
      assertActive,
      config: cfg,
      childSessionKey,
      targetAgentId,
      sandboxed: childRuntimeSandboxed,
      attachments: params.attachments,
      mountPathHint,
      redactContinuationErrorDetails: params.drainsContinuationDelegateQueue === true,
    });
    if (materializedAttachments && materializedAttachments.status !== "ok") {
      await cleanupCreatedSession(threadBindingReady);
      return {
        status: materializedAttachments.status,
        error: materializedAttachments.error,
      };
    }
    if (materializedAttachments?.status === "ok") {
      retainOnSessionKeep = materializedAttachments.retainOnSessionKeep;
      attachmentsReceipt = materializedAttachments.receipt;
      attachmentId = materializedAttachments.attachmentId;
      childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
    }

    const { childLaunch, queuedLaunch, progressOrigin, spawnedMetadata } =
      buildSubagentLaunchRequest({
        completionMode,
        spawnMode,
        message: envelope.message,
        spawnedByKey,
        toolSpawnMetadata,
        spawnedWorkspaceDir,
        childSessionKey,
        childSessionOrigin,
        childIdem,
        outputSchema: params.outputSchema,
        childSystemPrompt,
        thinkingOverride,
        runTimeoutSeconds,
        lightContext: params.lightContext === true,
        requesterOrigin,
        currentMessagingTarget: ctx.currentMessagingTarget,
        currentChannelId: ctx.currentChannelId,
        currentMessageId: ctx.currentMessageId,
        launchAuthorization,
        swarmSchedulerGroupKey,
        swarmMaxConcurrent: swarmConfig.maxConcurrent,
      });
    if (params.drainsContinuationDelegateQueue) {
      childLaunch.request.drainsContinuationDelegateQueue = true;
    }
    if (params.traceparent) {
      childLaunch.request.traceparent = params.traceparent;
    }
    recordSubagentSpawned({
      childSessionKey,
      childRunId,
      requesterSessionKey: requesterInternalKey,
      agentId: targetAgentId,
    });
    const recordRequesterParticipation = () =>
      recordSessionParticipantBestEffort({
        promptedAt,
        identity: { type: "agent", id: requesterAgentId },
        agentId: targetAgentId,
        sessionKey: childSessionKey,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
      });
    const launchChildRun = async (assertDispatchCurrent?: () => void) => {
      ctx.continuationDelegateAdmission?.assertCurrent("gateway-dispatch");
      registerSubagentTraceparentHandoff({
        idempotencyKey: childIdem,
        sessionKey: childSessionKey,
        traceparent: params.traceparent,
      });
      return await callNativeSubagentGateway(
        withSubagentGatewayExecutionIdentity(
          {
            method: "agent",
            assertDispatchCurrent,
            params: childLaunch.request,
            timeoutMs: childLaunch.timeoutMs,
          },
          {
            sessionSpawnContext: buildSubagentExecutionSessionSpawnContext({
              enabled: isExecutionIdentityCollectionEnabled(cfg),
              backend: "subagent",
              parentAgentId: requesterAgentId,
              requesterRef: requesterInternalKey,
              controllerRef: ownership.controllerSessionKey,
              depth: childDepth,
              maxDepth: maxSpawnDepth,
              targetAgentId,
              sandbox: sandboxMode,
              inheritedToolAllowlist: ctx.inheritedToolAllowlist,
              inheritedToolDenylist: ctx.inheritedToolDenylist,
            }),
            parentExecutionIdentityToken: readParentExecutionIdentity(ctx),
          },
        ),
        childLaunch.authorization,
        gatewayContextResolver,
      );
    };

    const emitSpawnLifecycleHooks = createSubagentSpawnLifecycleEmitter({
      hookRunner,
      childSessionKey,
      requesterInternalKey,
      progressOrigin,
      targetAgentId,
      label: label || undefined,
      requesterOrigin,
      requestThreadBinding,
      spawnMode,
      resolvedModelMetadata,
    });
    const cleanupFailedSpawn = (waitForSessionDeletion?: boolean) =>
      cleanupFailedSpawnBeforeAgentStart({
        childSessionKey,
        attachmentId,
        emitLifecycleHooks: threadBindingReady,
        deleteTranscript: true,
        ...provisionalSessionIdentity,
        waitForSessionDeletion,
        isCurrent: canCleanupCreatedSession,
      });
    type SubagentBackendState = { contextEnginePreparation?: PreparedContextEngineSubagentSpawn };
    // Set once the gateway accepts the child run, so a later failure can tell an
    // accepted run apart from one that never started.
    let acceptedChildRunId: string | undefined;
    let taskRowOwnership: "required" | "gateway_best_effort" = "required";
    const adapter: SpawnBackendAdapter<SubagentBackendState> = {
      async initialize() {
        const result =
          params.lightContext && preparedSpawnContext.mode === "isolated"
            ? ({ status: "ok", preparation: undefined } as const)
            : await prepareContextEngineSubagentSpawn({
                assertActive,
                cfg,
                context: preparedSpawnContext,
                requesterInternalKey,
                childSessionKey,
                runTimeoutSeconds,
              });
        if (result.status === "error") {
          throw new Error(result.error);
        }
        contextEnginePreparation = result.preparation;
        return { contextEnginePreparation };
      },
      async dispatchTurn() {
        if (params.collect) {
          return { runId: childIdem };
        }
        const launch = await launchChildRun(assertActive);
        taskRowOwnership = launch.taskRowOwnership;
        acceptedChildRunId = readGatewayRunId(launch.response) ?? childIdem;
        recordRequesterParticipation();
        return { runId: acceptedChildRunId };
      },
      async cleanupOnFailure({ phase, state, error, registrationScope }) {
        canCleanupCreatedSession = registrationScope?.canCleanupSession;
        canRetireReservation = registrationScope?.canRetireReservation;
        if (phase === "initialize") {
          await cleanupFailedSpawn();
          return;
        }
        let emitLifecycleHooks = threadBindingReady;
        if (phase === "dispatch" && threadBindingReady) {
          let endedHookEmitted = false;
          if (hookRunner?.hasHooks("subagent_ended")) {
            try {
              await hookRunner.runSubagentEnded(
                {
                  targetSessionKey: childSessionKey,
                  targetKind: "subagent",
                  reason: "spawn-failed",
                  sendFarewell: true,
                  accountId: childSessionOrigin?.accountId,
                  runId: childIdem,
                  outcome: "error",
                  error: "Session failed to start",
                },
                {
                  runId: childIdem,
                  childSessionKey,
                  requesterSessionKey: requesterInternalKey,
                },
              );
              endedHookEmitted = true;
            } catch {
              // Spawn cleanup continues even when presentation hooks fail.
            }
          }
          emitLifecycleHooks = !endedHookEmitted;
        }
        await cleanupAcceptedSubagentSpawnFailure({
          phase,
          error,
          runId: childIdem,
          childSessionKey,
          acceptedChildRunId,
          taskRowOwnership,
          contextEnginePreparation: state?.contextEnginePreparation,
          attachmentId,
          ...provisionalSessionIdentity,
          emitLifecycleHooks,
          cleanupCreatedSession,
          isCurrent: canCleanupCreatedSession,
        });
      },
    };
    const pipelineResult = await runSpawnPipeline({
      adapter,
      assertActive,
      admissionReservation,
      progressOrigin,
      progressSessionKey: requesterInternalKey,
      buildRegistration: (_state, runId) => {
        if (params.collect) {
          const latestAdmission = resolveAdmission();
          if (!latestAdmission.ok) {
            throw Object.assign(new Error(latestAdmission.error), {
              spawnStatus: "forbidden" as const,
            });
          }
        }
        return {
          runId,
          requesterTurnRunId: ctx.requesterTurnRunId,
          childSessionKey,
          controllerSessionKey: ownership.controllerSessionKey,
          requesterSessionKey: ownership.completionRequesterSessionKey,
          requesterOrigin,
          progressOrigin,
          requesterDisplayKey: ownership.completionRequesterDisplayKey,
          task,
          taskName,
          agentId: targetAgentId,
          requesterAgentId,
          cleanup,
          label: label || undefined,
          model: resolvedModel,
          agentDir: targetAgentDir,
          workspaceDir: spawnedMetadata.workspaceDir,
          runTimeoutSeconds,
          expectsCompletionMessage: completionMode === "announce",
          completionTarget: params.completionTarget,
          completionRequesterSessionId,
          spawnMode,
          collect: params.collect === true,
          swarmRequesterSessionKey: params.collect ? requesterInternalKey : undefined,
          swarmLaunchIdempotencyKey: params.collect ? childIdem : undefined,
          swarmLaunchReplayKey: params.collect ? swarmLaunchReplayKey : undefined,
          swarmLaunchRequestFingerprint: params.collect
            ? params.swarmLaunchRequestFingerprint
            : undefined,
          outputSchema: params.outputSchema,
          groupId: swarmGroupId,
          queuedLaunch,
          queued: params.collect === true,
          taskRowOwnership,
          ...(gatewayContextResolver ? { gatewayContextResolver } : {}),
          attachmentId,
          retainAttachmentsOnKeep: retainOnSessionKeep,
          ...(params.silentAnnounce ? { silentAnnounce: true } : {}),
          ...(params.wakeOnReturn ? { wakeOnReturn: true } : {}),
          ...(params.drainsContinuationDelegateQueue
            ? { drainsContinuationDelegateQueue: true }
            : {}),
          ...(params.continuationTargetSessionKey
            ? { continuationTargetSessionKey: params.continuationTargetSessionKey }
            : {}),
          ...(continuationTargetSessionKeys?.length ? { continuationTargetSessionKeys } : {}),
          ...(params.continuationFanoutMode
            ? { continuationFanoutMode: params.continuationFanoutMode }
            : {}),
          ...(continuationRecipientAuthorityBinding
            ? { continuationRecipientAuthorityBinding }
            : {}),
          ...(params.traceparent ? { traceparent: params.traceparent } : {}),
        };
      },
      assertRegistrationAdmission: () =>
        ctx.continuationDelegateAdmission?.assertCurrent("registry-acceptance"),
      assertPostPublicationAdmission: () =>
        ctx.continuationDelegateAdmission?.assertCurrent("final-acceptance"),
      publishRegistration: () => {
        if (childEntry) {
          recordSessionCreated(cfg, {
            sessionKey: childSessionKey,
            agentId: targetAgentId,
            entry: childEntry,
          });
        }
        recordSubagentSpawned({
          childSessionKey,
          childRunId,
          requesterSessionKey: requesterInternalKey,
          agentId: targetAgentId,
        });
      },
      afterRegistration: async (state, runId, registrationScope) => {
        ctx.continuationDelegateAdmission?.assertCurrent("lifecycle-publication");
        canCleanupCreatedSession = registrationScope?.canCleanupSession;
        canRetireReservation = registrationScope?.canRetireReservation;
        if (params.collect && swarmGroupId && swarmSchedulerGroupKey) {
          for (
            let claim = registrationScope?.waitForClaim();
            claim;
            claim = registrationScope?.waitForClaim()
          ) {
            await claim;
          }
          const canLaunch = registrationScope?.canLaunch() !== false;
          if (swarmReservation?.isCurrent() !== false) {
            // The scheduler also settles registrations that have lost launch authority.
            activateSwarmRun({
              groupId: swarmSchedulerGroupKey,
              runId,
              lifecycleOwner: gatewayContextResolver
                ? getCanonicalGatewayContextResolver(gatewayContextResolver)
                : undefined,
              ...createCollectorLaunchCallbacks({
                childRunId: runId,
                childSessionKey,
                requesterSessionKey: requesterInternalKey,
                gatewayContextResolver,
                registrationScope,
                preparation: state.contextEnginePreparation,
                provisionalSessionIdentity,
                launchChildRun,
                recordParticipant: recordRequesterParticipation,
                emitSpawnLifecycleHooks,
                cleanupFailedSpawn,
              }),
            });
          } else {
            if (canRetireReservation?.() !== false) {
              swarmReservation?.withdraw();
            }
            if (!canLaunch && canCleanupCreatedSession?.() !== false) {
              await rollbackPreparedContextEngine(contextEnginePreparation);
            } else {
              await contextEnginePreparation?.dispose().catch(() => {});
            }
          }
          contextEnginePreparation = undefined;
        } else {
          await emitSpawnLifecycleHooks(runId);
        }
        emitSessionLifecycleEvent({
          sessionKey: childSessionKey,
          reason: "create",
          parentSessionKey: requesterInternalKey,
          label: label || undefined,
        });
      },
      rollbackRegistration: rollbackSubagentRunRegistration,
      recordAcceptedRollback: (registration, error) =>
        recordAcceptedSubagentSpawnRollback({
          ...registration,
          gatewayRunId: acceptedChildRunId ?? registration.runId,
          reason: error instanceof Error ? error.message : String(error),
          expectedRegistration: registration.expectedRegistration,
          ...provisionalSessionIdentity,
        }),
    });
    if (!pipelineResult.ok) {
      const runId = pipelineResult.runId ?? childIdem;
      const spawnStatus =
        pipelineResult.error && typeof pipelineResult.error === "object"
          ? (pipelineResult.error as { spawnStatus?: unknown }).spawnStatus
          : undefined;
      return {
        status: isSpawnSubagentAdmissionCancelledError(pipelineResult.error)
          ? "cancelled"
          : spawnStatus === "forbidden"
            ? "forbidden"
            : "error",
        error:
          pipelineResult.phase === "register" && spawnStatus !== "forbidden"
            ? `Failed to register subagent run: ${summarizeSpawnError(pipelineResult.error)}`
            : summarizeSpawnError(pipelineResult.error),
        childSessionKey,
        ...(pipelineResult.phase === "initialize" ? {} : { runId }),
      };
    }
    childRunId = pipelineResult.runId;
    canCleanupCreatedSession = pipelineResult.registrationScope?.canCleanupSession;
    canRetireReservation = pipelineResult.registrationScope?.canRetireReservation;
    const collectorAccepted = params.collect && swarmGroupId && swarmSchedulerGroupKey;
    if (collectorAccepted) {
      swarmReservationPending = false;
    }

    emitSessionLifecycleEvent({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: requesterInternalKey,
      label: label || undefined,
    });
    return {
      status: "accepted",
      childSessionKey,
      ...(collectorAccepted ? { sessionKey: childSessionKey } : {}),
      runId: childRunId,
      mode: spawnMode,
      expectsCompletionMessage: completionMode === "announce",
      completionTarget: params.completionTarget,
      context: preparedSpawnContext.mode,
      taskName,
      note:
        [envelope.acceptedNote, preparedSpawnContext.forkFallbackNote].filter(Boolean).join(" ") ||
        undefined,
      ...resolvedModelMetadata,
      modelApplied: plan.modelApplied || undefined,
      attachments: attachmentsReceipt,
    };
  } catch (error) {
    if (isSpawnSubagentAdmissionCancelledError(error)) {
      return { status: "cancelled", error: error.message };
    }
    throw error;
  } finally {
    admissionReservation?.release();
    if (swarmReservationPending && canRetireReservation?.() !== false) {
      swarmReservation?.withdraw();
    }
    try {
      if (params.collect && contextEnginePreparation && canCleanupCreatedSession?.() !== false) {
        await rollbackPreparedContextEngine(contextEnginePreparation);
      } else {
        await contextEnginePreparation?.dispose().catch(() => {});
      }
    } finally {
      await swarmReservation?.release();
    }
  }
}

const testing = {
  setDepsForTest(overrides?: Parameters<typeof setSubagentSpawnDepsForTest>[0]) {
    setSubagentSpawnDepsForTest(overrides);
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentSpawnTestApi")] =
    testing;
}
