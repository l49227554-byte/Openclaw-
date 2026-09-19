import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderModelRef } from "../../agents/embedded-agent-runner/model.registry-resolution.js";
import { FailoverError } from "../../agents/failover-error.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import * as metadata from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { recordReplyAutomaticFallbackRoute } from "./agent-runner-fallback-authority.js";
import { runReplyAgent } from "./agent-runner-run.js";
import { clearSessionQueues } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("automatic fallback producer authority", () => {
  it.each(["canonical-alias", "explicit-redirect", "transport-alias", "hook-retarget"])(
    "composes real fallback selection, manifest materialization and ordinary input: %s",
    async (scenario) => {
      const key = `agent:main:fallback-authority-${scenario}`;
      const run = createQueueTestRun({ prompt: "ordinary guidance", messageId: scenario });
      run.run.sessionKey = key;
      run.run.agentId = "main";
      run.run.config = {
        agents: {
          defaults: { model: { primary: "openai/gpt-test", fallbacks: ["moonshot-ai/kimi-k3"] } },
        },
      };
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "moonshot",
            enabledByDefault: true,
            providers: ["moonshot"],
            modelCatalog: {
              aliases: {
                "moonshot-ai": {
                  provider: "moonshot",
                  ...(scenario === "transport-alias"
                    ? {
                        api: "openai-completions" as const,
                        baseUrl: "https://transport.example.invalid/v1",
                      }
                    : {}),
                },
              },
            },
          },
        ],
      });
      vi.spyOn(metadata, "getCurrentPluginMetadataSnapshot").mockReturnValue(snapshot);
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId: run.run.sessionId,
        resetTriggered: false,
      });
      operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
      operation.setPhase("running");
      const queueMessage = vi.fn(async () => {});
      const candidates: string[] = [];
      try {
        await runWithModelFallback({
          cfg: run.run.config,
          provider: run.run.provider,
          model: run.run.model,
          skipAuthProfileRuntime: true,
          run: async (provider, model, options) => {
            candidates.push(`${provider}/${model}`);
            if (!options) {
              throw new Error("missing real fallback provenance");
            }
            recordReplyAutomaticFallbackRoute({
              operation,
              provenance: options.modelRoutingProvenance,
              route: { provider, model },
              config: run.run.config,
              workspaceDir: run.run.workspaceDir,
            });
            if (provider === "openai") {
              if (scenario === "explicit-redirect") {
                throw new LiveSessionModelSwitchError({
                  provider: "moonshot-ai",
                  model: "kimi-k3",
                });
              }
              throw new FailoverError("synthetic primary unavailable", {
                provider,
                model,
                reason: "model_not_found",
              });
            }
            const resolved = normalizeProviderModelRef({
              provider,
              modelId: model,
              modelIdSource: "selected",
              cfg: run.run.config,
              workspaceDir: run.run.workspaceDir,
            });
            expect(resolved.provider).toBe(
              scenario === "transport-alias" ? "moonshot-ai" : "moonshot",
            );
            operation.bindToolAuthorityRoute({
              provider:
                scenario === "hook-retarget"
                  ? "unrelated-provider"
                  : scenario === "transport-alias"
                    ? "moonshot"
                    : resolved.provider,
              model: resolved.model,
            });
            operation.attachBackend({
              kind: "embedded",
              cancel: vi.fn(),
              messageInjection: { isAvailable: () => true, queueMessage },
            });
            return "running fallback fixture";
          },
        });
        expect(candidates).toEqual(["openai/gpt-test", "moonshot-ai/kimi-k3"]);
        if (scenario === "explicit-redirect") {
          expect(operation.automaticFallbackRoute).toBeUndefined();
        }
        const state: ReplyOperationRunState = {};
        await runReplyAgent({
          commandBody: run.prompt,
          followupRun: run,
          opts: { runId: `ordinary-${scenario}`, [REPLY_OPERATION_RUN_STATE]: state },
          queueKey: key,
          resolvedQueue: { mode: "steer", debounceMs: 0 },
          shouldSteer: true,
          shouldFollowup: false,
          isActive: true,
          typing: createMockTypingController(),
          sessionCtx: {},
          sessionKey: key,
          defaultModel: "openai/gpt-test",
          resolvedVerboseLevel: "off",
          isNewSession: false,
          blockStreamingEnabled: false,
          resolvedBlockStreamingBreak: "text_end",
          shouldInjectGroupIntro: false,
          typingMode: "never",
        });
        expect(state.admission).toEqual({
          status: "accepted",
          mode: scenario === "canonical-alias" ? "steer" : "followup",
        });
        expect(queueMessage).toHaveBeenCalledTimes(scenario === "canonical-alias" ? 1 : 0);
      } finally {
        clearSessionQueues([key]);
        operation.complete();
      }
    },
  );
});
