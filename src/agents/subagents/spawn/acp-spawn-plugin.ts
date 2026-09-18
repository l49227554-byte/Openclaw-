/**
 * Plugin-owned one-shot ACP spawns. Reuses the sessions_spawn(runtime="acp") policy,
 * admission, runtime, gateway launch, spawn pipeline, and failure-cleanup owners while
 * binding the child to a plugin principal instead of a requester session.
 */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment } from "../../../acp/control-plane/manager.types.js";
import { cleanupFailedAcpSpawn } from "../../../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../../../acp/policy.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { PluginSubagentRequesterContext } from "../../../plugins/runtime/subagent-requester-context.js";
import { normalizeOptionalAgentId } from "../../../routing/session-key.js";
import { recordSessionCreated } from "../../../sessions/session-state-events.js";
import { reserveChildAdmissionSlot } from "../../child-admission.js";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "../../spawn-pipeline.js";
import { resolveSpawnAdmission } from "../../spawn-plan.js";
import { resolveSpawnedWorkspaceInheritance } from "../../spawned-context.js";
import { countUntrackedActiveAcpRunsForOwner } from "./acp-spawn-admission.js";
import { toGatewayImageAttachments } from "./acp-spawn-bootstrap-delivery.js";
import {
  createAcpSpawnFailure,
  type SpawnAcpAccepted,
  type SpawnAcpFailure,
} from "./acp-spawn-result.js";
import {
  initializeAcpSpawnRuntime,
  resolveAcpSessionMode,
  resolveAcpSpawnRuntimeOptions,
  resolveRuntimeCwdForAcpSpawn,
  type AcpSpawnInitializedRuntime,
} from "./acp-spawn-runtime.js";
import {
  resolveConfiguredAcpSubagentTargetIds,
  resolveTargetAcpAgentId,
} from "./acp-spawn-target.js";
import { callSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "./subagent-spawn-plan.js";

const PLUGIN_ACP_LABEL_MAX_LENGTH = 80;

export type PluginAcpSpawnPrincipal = {
  pluginId: string;
  /** Registry and task owner key; never an agent session. */
  ownerKey: string;
  /**
   * Host-captured requester for `completionDelivery: "current-requester"`. Only the
   * completion announcement is routed to it; task ownership, control, admission, and
   * child-session provenance stay with the plugin.
   */
  completionRequester?: PluginSubagentRequesterContext;
  assertActive?: () => void;
};

export type PluginAcpSpawnInput = {
  task: string;
  label?: string;
  agentId?: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  attachments?: AcpTurnAttachment[];
};

export type SpawnAcpForPluginResult =
  | (SpawnAcpAccepted & { targetAgentId: string })
  | (SpawnAcpFailure & { targetAgentId?: string });

/** Bounded, plugin-attributed display label for registry rows and task views. */
function resolvePluginAcpLabel(pluginId: string, label?: string): string {
  const base = `plugin:${pluginId}`;
  const custom = normalizeOptionalString(label);
  const combined = custom ? `${base} ${custom}` : base;
  return combined.length > PLUGIN_ACP_LABEL_MAX_LENGTH
    ? `${combined.slice(0, PLUGIN_ACP_LABEL_MAX_LENGTH - 1)}…`
    : combined;
}

function fail(
  params: Parameters<typeof createAcpSpawnFailure>[0],
  targetAgentId?: string,
): SpawnAcpForPluginResult {
  return { ...createAcpSpawnFailure(params), ...(targetAgentId ? { targetAgentId } : {}) };
}

function mintPluginAcpSessionKey(targetAgentId: string, pluginId: string): string {
  return `agent:${targetAgentId}:acp:plugin:${pluginId}:${crypto.randomUUID()}`;
}

export async function spawnAcpForPlugin(
  params: PluginAcpSpawnInput,
  principal: PluginAcpSpawnPrincipal,
): Promise<SpawnAcpForPluginResult> {
  const cfg = getRuntimeConfig();
  if (!isAcpEnabledByPolicy(cfg)) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "acp_disabled",
      error: "ACP is disabled by policy (`acp.enabled=false`).",
    });
  }
  const targetAgentResult = resolveTargetAcpAgentId({ requestedAgentId: params.agentId, cfg });
  if (!targetAgentResult.ok) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode:
        params.agentId && normalizeOptionalAgentId(params.agentId)
          ? "runtime_agent_mismatch"
          : "target_agent_required",
      error: targetAgentResult.error,
    });
  }
  const { agentId: targetAgentId, backendId } = targetAgentResult;
  const agentPolicyError = resolveAcpAgentPolicyError(cfg, targetAgentId);
  if (agentPolicyError) {
    return fail(
      {
        status: "forbidden",
        errorCode: "agent_forbidden",
        error: agentPolicyError.message,
      },
      targetAgentId,
    );
  }
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  const { ownerKey, pluginId, completionRequester } = principal;
  const expectsCompletionMessage = completionRequester !== undefined;
  // The plugin has no agent identity; admission counts and caps apply to its owner key
  // under the target agent's subagent policy, so N+1 launches still fail closed.
  const resolveAdmission = (pendingChildren = 0, pendingChildSessionKeys?: ReadonlySet<string>) =>
    resolveSpawnAdmission({
      cfg,
      enabled: true,
      requesterSessionKey: ownerKey,
      requesterAgentId: targetAgentId,
      targetAgentId,
      requestedAgentId: params.agentId,
      configuredAgentIds: resolveConfiguredAcpSubagentTargetIds(cfg),
      additionalActiveChildren:
        countUntrackedActiveAcpRunsForOwner(ownerKey, pendingChildSessionKeys) + pendingChildren,
    });
  const rejectSubagentPolicy = (error: string) =>
    fail({ status: "forbidden", errorCode: "subagent_policy", error }, targetAgentId);
  const admission = resolveAdmission();
  if (!admission.ok) {
    return rejectSubagentPolicy(admission.error);
  }
  const runtimeOptionsResult = resolveAcpSpawnRuntimeOptions({
    cfg,
    targetAgentId,
    configAgentId: targetAgentResult.configAgentId,
    model: params.model,
    thinking: params.thinking,
    runTimeoutSeconds,
  });
  if (!runtimeOptionsResult.ok) {
    return fail(
      {
        status: "error",
        errorCode: "spawn_failed",
        error: runtimeOptionsResult.error,
      },
      targetAgentId,
    );
  }
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    targetAgentId,
    explicitWorkspaceDir: params.cwd,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({ resolvedCwd, explicitCwd: params.cwd });
  } catch (error) {
    return fail(
      {
        status: "error",
        errorCode: "cwd_resolution_failed",
        error: formatErrorMessage(error),
      },
      targetAgentId,
    );
  }

  const sessionKey = mintPluginAcpSessionKey(targetAgentId, pluginId);
  const label = resolvePluginAcpLabel(pluginId, params.label);
  const childIdem = crypto.randomUUID();
  const gatewayAttachments = toGatewayImageAttachments(params.attachments);
  let childCreationEntry: SessionEntry | undefined;
  let childSessionId: string | undefined;
  let closeRuntimeOnFailure: (() => Promise<void>) | undefined;

  const adapter: SpawnBackendAdapter<{ initializedSession: AcpSpawnInitializedRuntime }> = {
    async initialize() {
      const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId });
      childCreationEntry =
        (await upsertSessionEntryCore(
          { storePath, sessionKey, agentId: targetAgentId },
          {
            // Plugin attribution only: no spawnedBy/parentSessionKey lineage and no
            // requester delivery route, so the child never inherits a session's visibility.
            ...buildSessionCreationStamp({
              via: "plugin",
              actor: { type: "system", id: pluginId },
            }),
            pluginOwnerId: pluginId,
            ...(admission.childSessionPatch
              ? {
                  spawnDepth: admission.childSessionPatch.spawnDepth,
                  ...(admission.childSessionPatch.subagentRole
                    ? { subagentRole: admission.childSessionPatch.subagentRole }
                    : {}),
                  subagentControlScope: admission.childSessionPatch.subagentControlScope,
                }
              : {}),
            label,
          },
          { assertCommitAllowed: principal.assertActive },
        )) ?? undefined;
      const initializedSession = await initializeAcpSpawnRuntime({
        assertActive: principal.assertActive,
        cfg,
        sessionKey,
        targetAgentId,
        runtimeMode: resolveAcpSessionMode("run"),
        backendId,
        runtimeOptions: runtimeOptionsResult.runtimeOptions,
        modelExplicit: runtimeOptionsResult.modelExplicit,
        cwd: runtimeCwd,
      });
      closeRuntimeOnFailure = initializedSession.initialized.closeRuntimeOnFailure;
      // The incarnation the ACP runtime bound to; a later entry under the same key with a
      // different sessionId is somebody else's session and must not be cancelled as this run.
      childSessionId = initializedSession.sessionId ?? childCreationEntry?.sessionId;
      principal.assertActive?.();
      return { initializedSession };
    },
    async dispatchTurn() {
      if (childCreationEntry) {
        recordSessionCreated({ sessionKey, agentId: targetAgentId, entry: childCreationEntry });
      }
      // Same in-process Gateway launch as sessions_spawn: the trusted backend client plus
      // acpTurnSource="manual_spawn" lets Gateway task tracking skip its CLI row, so the
      // registry row created below is the run's only task record.
      const response = await callSubagentGateway({
        method: "agent",
        assertDispatchCurrent: principal.assertActive,
        params: {
          message: params.task,
          sessionKey,
          idempotencyKey: childIdem,
          deliver: false,
          lane: AGENT_LANE_SUBAGENT,
          acpTurnSource: "manual_spawn",
          timeout: runTimeoutSeconds,
          label,
          ...(gatewayAttachments ? { attachments: gatewayAttachments } : {}),
        },
        timeoutMs: 10_000,
      });
      return { runId: readGatewayRunId(response) ?? childIdem };
    },
    async cleanupOnFailure() {
      await cleanupFailedAcpSpawn({
        cfg,
        sessionKey,
        agentId: targetAgentId,
        sessionEntry: childCreationEntry,
        deleteTranscript: true,
        closeRuntimeOnFailure,
      });
    },
  };

  const admissionReservation = reserveChildAdmissionSlot({
    controllerSessionKey: ownerKey,
    childSessionKey: sessionKey,
    resolveAdmission,
  });
  if (!admissionReservation.ok) {
    return rejectSubagentPolicy(admissionReservation.error);
  }
  const pipelineResult = await runSpawnPipeline({
    adapter,
    assertActive: principal.assertActive,
    admissionReservation,
    hookRunner: getGlobalHookRunner(),
    progressSessionKey: ownerKey,
    buildRegistration: (_state, runId) => ({
      runId,
      childSessionKey: sessionKey,
      ...(childSessionId ? { childSessionId } : {}),
      // Control and the task row stay with the plugin in both modes. With a host-captured
      // requester, only the announce target moves to that requester: the registry row's
      // requester session/origin feed the canonical completion delivery owner, and the
      // requester agent derives from that captured session key rather than the ACP target.
      controllerSessionKey: ownerKey,
      taskOwnerKey: ownerKey,
      requesterSessionKey: completionRequester?.sessionKey ?? ownerKey,
      ...(completionRequester ? { requesterOrigin: completionRequester.origin } : {}),
      requesterDisplayKey: `plugin:${pluginId}`,
      task: params.task,
      agentId: targetAgentId,
      ...(completionRequester ? {} : { requesterAgentId: targetAgentId }),
      cleanup: params.cleanup === "delete" ? "delete" : "keep",
      label,
      runTimeoutSeconds,
      // Without a captured requester, plugins poll or observe; nothing announces anywhere.
      expectsCompletionMessage,
      spawnMode: "run",
    }),
  });
  if (!pipelineResult.ok) {
    if (pipelineResult.phase === "initialize") {
      return fail(
        {
          status: "error",
          errorCode: "spawn_failed",
          error: summarizeSpawnError(pipelineResult.error),
        },
        targetAgentId,
      );
    }
    if (pipelineResult.phase === "dispatch") {
      return fail(
        {
          status: "error",
          errorCode: "dispatch_failed",
          error: summarizeSpawnError(pipelineResult.error),
          childSessionKey: sessionKey,
        },
        targetAgentId,
      );
    }
    return fail(
      {
        status: "error",
        errorCode: "spawn_failed",
        error: `Failed to register ACP run: ${summarizeSpawnError(pipelineResult.error)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
        childSessionKey: sessionKey,
        runId: pipelineResult.runId,
      },
      targetAgentId,
    );
  }
  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId: pipelineResult.runId,
    mode: "run",
    runTimeoutSeconds,
    expectsCompletionMessage,
    targetAgentId,
  };
}
