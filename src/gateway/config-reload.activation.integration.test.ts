// Keep provider/model dependencies controlled while exercising the real config reloader.
// oxfmt-ignore
import { cleanupPreparedModelRuntimeHarness, getPreparedModelRuntimeMocks, resetPreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import {
  readConfigFileSnapshot,
  registerConfigWriteListener,
  transformConfigFileWithRetry,
} from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import {
  createRuntimeConfigWriteApplication,
  getRuntimeConfigWriteApplication,
  attachRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindPluginMetadataSnapshotCache } from "../plugins/plugin-cache.js";
import {
  captureSetupInferenceFileUndo,
  commitSetupInferenceActivation,
  type SetupInferenceConfigTarget,
} from "../system-agent/setup-inference-transition.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { startGatewayConfigReloader } from "./config-reload.js";
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "activation-reloader" });
  await resetPreparedModelRuntimeHarness(state);
  bindPluginMetadataSnapshotCache(getPreparedModelRuntimeMocks().pluginMetadataSnapshot);
  getPreparedModelRuntimeMocks().configuredAgentIds = ["default"];
  getPreparedModelRuntimeMocks().configuredWorkspaces.set("default", state.workspaceDir);
});
afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
describe("setup activation reload ownership", () => {
  it("the real reloader supersedes an old activation without rejecting the newer publication", async () => {
    const previous: OpenClawConfig = {
      gateway: { mode: "local" },
      plugins: { slots: { memory: "none" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://fixture.invalid/v1",
            api: "openai-responses",
            apiKey: "fixture-key",
            models: ["working", "verified", "newer"].map((id) => ({
              id: `fixture-${id}`,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
              compat: { supportsTools: true },
            })),
          },
        },
      },
      agents: {
        entries: { default: {} },
        defaults: { workspace: state.workspaceDir, model: "openai/fixture-working" },
      },
    };
    const candidate = {
      ...previous,
      agents: {
        ...previous.agents,
        defaults: { ...previous.agents?.defaults, model: "openai/fixture-verified" },
      },
    };
    const newer = {
      ...previous,
      agents: {
        ...previous.agents,
        defaults: { ...previous.agents?.defaults, model: "openai/fixture-newer" },
      },
    };
    await state.writeConfig(previous);
    await refreshPreparedModelRuntimeSnapshots(previous);
    const initial = await readConfigFileSnapshot();
    const reloader = startGatewayConfigReloader({
      initialConfig: initial.config,
      initialCompareConfig: initial.sourceConfig,
      initialSnapshotRawHash: initial.hash ?? null,
      initialAuthoredConfig: initial.parsed,
      initialSnapshotValid: initial.valid,
      initialSnapshotIssues: initial.issues,
      testDebounceMs: 0,
      readSnapshot: readConfigFileSnapshot,
      watchPath: state.configPath,
      readPluginInstallRecords: async () => ({}),
      initialPluginInstallRecords: {},
      subscribeToWrites: (listener) =>
        registerConfigWriteListener(listener, {
          ownsRuntimeActivationFor: state.configPath,
          preCommitRuntimePreflight: async (sourceConfig) => ({
            runtimeConfig: sourceConfig,
            compareConfig: sourceConfig,
          }),
        }),
      onHotReload: async (plan, config, ownership) => {
        await refreshPreparedModelRuntimeSnapshots(config, {
          isPublicationCurrent: ownership.isCurrent,
        });
        ownership.markRuntimeCommitted(config, plan);
        return "applied";
      },
      onNoopConfigCommit: async (_plan, config, ownership) => {
        await refreshPreparedModelRuntimeSnapshots(config, {
          isPublicationCurrent: ownership.isCurrent,
        });
      },
      onRestart: () => {
        throw new Error("fixture route must hot reload");
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const completion = createDeferred<() => Promise<boolean>>();
    const applied = createDeferred<ReturnType<typeof createRuntimeConfigWriteApplication>>();
    try {
      const configTarget: SetupInferenceConfigTarget = {
        read: async () => ({
          config: (await readConfigFileSnapshot()).sourceConfig,
          write: configTarget.write,
        }),
        write: async (_candidate, { writeOptions, captureUndo }) => {
          const application = getRuntimeConfigWriteApplication(writeOptions);
          if (!application) {
            throw new Error("missing activation application");
          }
          applied.resolve(application);
          const result = await transformConfigFileWithRetry({
            base: "source",
            writeOptions,
            transform: (_current, context) => {
              captureUndo(captureSetupInferenceFileUndo(context.snapshot, candidate));
              return { nextConfig: candidate };
            },
          });
          return result.nextConfig;
        },
      };
      await commitSetupInferenceActivation({
        preserveWorkingConnection: true,
        assertCurrent: () => {},
        activate: async () => undefined,
        deferCompletion: completion.resolve,
        configTarget,
        config: candidate,
      });
      await expect((await applied.promise).result).resolves.toBe("applied");
      const newerApplication = createRuntimeConfigWriteApplication();
      await transformConfigFileWithRetry({
        base: "source",
        writeOptions: attachRuntimeConfigWriteApplication({}, newerApplication),
        transform: () => ({ nextConfig: newer }),
      });
      await expect(newerApplication.result).resolves.toBe("applied");
      const normalRead = prepareModelRuntimeSnapshot({
        agentId: "default",
        agentDir: state.agentDir("default"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: state.workspaceDir,
        config: candidate,
      });
      await expect((await completion.promise)()).rejects.toThrow("superseded");
      expect(resolveAgentModelPrimaryValue((await normalRead).config.agents?.defaults?.model)).toBe(
        "openai/fixture-newer",
      );
      expect(
        resolveAgentModelPrimaryValue(
          (await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model,
        ),
      ).toBe("openai/fixture-newer");
    } finally {
      await reloader.stop();
    }
  });
});
