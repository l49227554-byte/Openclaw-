// Memory-flush plan fixtures and model-fallback mock helpers shared with
// agent-runner-memory.test.ts, split out to keep that grandfathered test file
// within its line cap.
import { createAssistantErrorTranscript } from "../../agents/assistant-error-transcript.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import type { MemoryFlushPlan } from "../../plugins/memory-state.test-fixtures.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";

export function createMemoryFlushPlan(): MemoryFlushPlan {
  return {
    softThresholdTokens: 4_000,
    forceFlushTranscriptBytes: 1_000_000_000,
    reserveTokensFloor: 20_000,
    prompt: "Pre-compaction memory flush.\nNO_REPLY",
    systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
    relativePath: "memory/2023-11-14.md",
  };
}

export function createModifiedMemoryFlushPlan(
  overrides: Partial<MemoryFlushPlan>,
): MemoryFlushPlan {
  return { ...createMemoryFlushPlan(), ...overrides };
}

export type ModelFallbackParams = {
  provider?: string;
  model?: string;
  abortSignal?: AbortSignal;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  fallbacksOverride?: unknown[];
  requestedRouteResolution?: "raw" | "resolved";
  userLockedAuthProfileId?: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  prepareAgentHarnessRuntime?: (params: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => Promise<void> | void;
  run: (
    provider: string,
    model: string,
    options: {
      allowTransientCooldownProbe?: boolean;
      isFinalFallbackAttempt?: boolean;
      modelRoutingProvenance: ModelFallbackAttemptProvenance;
    },
  ) => Promise<EmbeddedAgentRunResult>;
};

export function createMemoryRunEntryMockImplementation(deps: {
  runWithModelFallback: (params: ModelFallbackParams) => Promise<unknown>;
  ensureSelectedAgentHarnessPlugin: typeof ensureSelectedAgentHarnessPlugin;
}) {
  return async (params: Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0]) => {
    const assistantErrorTranscript = createAssistantErrorTranscript({
      runId: params.identity.runId,
    });
    const fallbackResult = (await deps.runWithModelFallback({
      ...params.selection,
      ...params.identity,
      abortSignal: params.abortSignal,
      resolveAgentHarnessRuntimeOverride: params.harness.resolveRuntimeOverride,
      prepareAgentHarnessRuntime: async ({
        provider,
        model,
        agentHarnessRuntimeOverride,
      }: {
        provider: string;
        model: string;
        agentHarnessRuntimeOverride?: string;
      }) => {
        await deps.ensureSelectedAgentHarnessPlugin({
          config: params.selection.cfg,
          provider,
          modelId: model,
          agentId: params.identity.agentId,
          sessionKey: params.harness.sessionKey,
          agentHarnessId: agentHarnessRuntimeOverride,
          agentHarnessRuntimeOverride,
          workspaceDir: params.harness.workspaceDir,
          pluginRegistry: requireActivePluginRegistry(),
        });
      },
      run: (provider: string, model: string, options: Parameters<ModelFallbackParams["run"]>[2]) =>
        params.runCandidate(provider, model, {
          agentHarnessRuntimeOverride: params.harness.resolveRuntimeOverride(provider, model),
          assistantErrorTranscript,
          classifyResult: () => undefined,
          allowTransientCooldownProbe: options.allowTransientCooldownProbe,
          isFinalFallbackAttempt: options.isFinalFallbackAttempt,
          isFallbackRetry: false,
          modelRoutingProvenance: options.modelRoutingProvenance,
          contextEngineLogicalTurnLease: {} as never,
          onContextEngineTurnCandidate: () => {},
          onDeferredTurnSendLedgerScope: () => {},
        }),
    })) as {
      outcome?: "completed" | "exhausted";
      result: EmbeddedAgentRunResult;
      provider: string;
      model: string;
      attempts: [];
    };
    return {
      ...fallbackResult,
      outcome: fallbackResult.outcome ?? ("completed" as const),
      terminal: {
        outcome: { reason: "completed" as const, status: "ok" as const },
        metadata: {},
      },
      settleSessionOverride: async () => undefined,
    };
  };
}
