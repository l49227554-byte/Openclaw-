/**
 * Real openclaw.chat -> engine -> system-agent -> embedded admission proof.
 * The synthetic dispatch seam is reached only after real lane admission.
 */
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent-runner/run-orchestrator.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { OpenClawConfig } from "../../config/types.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { SystemAgentSession } from "../../system-agent/agent-turn.js";
import { runSystemAgentTurnWithDeps } from "../../system-agent/agent-turn.test-support.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const RESPONSE_TEXT = "Synthetic expert response; no action was executed.";
const dispatch = vi.hoisted(() =>
  vi.fn<(params: RunEmbeddedAgentParams) => Promise<EmbeddedAgentRunResult>>(),
);

vi.mock("../../agents/embedded-agent-runner/cli-backend-dispatch.js", () => ({
  // This function is called inside run-orchestrator's admitted global-lane task.
  runEmbeddedAgentViaCliBackendIfEligible: dispatch,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptTurn: vi.fn(),
  appendTranscriptReset: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));
vi.mock("../../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));
vi.mock("../../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

const client = {
  connId: "nested-inference-test-connection",
  connect: { device: { id: "nested-inference-test-device" }, role: "operator" },
} as GatewayClient;
let metadata: SystemAgentPluginMetadataTestSnapshot;
const engines: SystemAgentChatEngine[] = [];

beforeAll(() => {
  metadata = createSystemAgentPluginMetadataTestSnapshot();
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const engine of engines.splice(0)) {
      await engine.dispose();
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetCommandQueueStateForTest();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    cleanup();
  }),
);

function completedResult(): EmbeddedAgentRunResult {
  return { meta: { durationMs: 1, finalAssistantVisibleText: RESPONSE_TEXT } };
}

async function createConversation() {
  resetCommandQueueStateForTest();
  const root = tempDirs.make("openclaw-nested-inference-integration-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
  const proof = await metadata.run(
    () => createSystemAgentVerifiedInferenceTestFixture(config),
    config,
  );
  const readConfigFileSnapshot = async () => ({
    exists: true,
    valid: true,
    path: path.join(root, "synthetic-config.json"),
    hash: "synthetic-config-hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
  });
  const observed = createDeferred<"waiting" | "dispatched">();
  const captured: {
    runner?: RunEmbeddedAgentParams;
    session?: SystemAgentSession;
    mainActiveAtDispatch?: number;
    inferenceActiveAtDispatch?: number;
  } = {};
  dispatch.mockImplementation(async (params) => {
    captured.mainActiveAtDispatch = getCommandLaneSnapshot(CommandLane.Main).activeCount;
    captured.inferenceActiveAtDispatch = getCommandLaneSnapshot(
      CommandLane.SystemAgentInference,
    ).activeCount;
    await params.preparedRunAdmission!.admit("embedded");
    observed.resolve("dispatched");
    return completedResult();
  });
  const engine = new SystemAgentChatEngine(
    {
      surface: "gateway",
      verifiedInference: proof.binding,
      operatorApprovalOnly: true,
      deps: {
        ...proof.deps,
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
      },
      runAgentTurn: async (params) => {
        captured.session = params.session;
        return await runSystemAgentTurnWithDeps(params, {
          ...proof.deps,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
          runEmbeddedAgent: async (runnerParams) => {
            captured.runner = runnerParams;
            return await runEmbeddedAgent({
              ...runnerParams,
              onLaneWait: (wait) => {
                if (wait.waiting) {
                  observed.resolve("waiting");
                }
              },
            });
          },
        });
      },
    },
    {
      executeOperation: vi.fn(async () => {
        throw new Error("external operation");
      }),
    },
  );
  engines.push(engine);
  const sessionId = "nested-inference-integration-conversation";
  const sessions = new Map<string, SystemAgentChatSession>([
    [
      sessionId,
      {
        engine,
        welcome: "Synthetic welcome",
        lastUsedAt: 1,
        ownerKey: "device:nested-inference-test-device",
      },
    ],
  ]);
  const respond = vi.fn();
  const invoke = () =>
    metadata.run(
      () =>
        systemAgentHandlers["openclaw.chat"]!({
          params: { sessionId, message: "What is the next setup step?" },
          client,
          context: { systemAgentSessions: sessions } as unknown as GatewayRequestContext,
          respond,
        } as never),
      config,
    );
  return { captured, invoke, observed, respond };
}

describe("system-agent nested inference through real Gateway admission", () => {
  it("completes while its parent occupies the only main slot", async () => {
    const conversation = await createConversation();
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(1);
    const releaseParent = createDeferred();
    const handlerStarted = createDeferred();
    let handler: Promise<void> | undefined;
    const parent = enqueueCommandInLane(CommandLane.Main, async () => {
      handler = Promise.resolve(conversation.invoke());
      handlerStarted.resolve();
      await Promise.race([handler, releaseParent.promise]);
    });
    await handlerStarted.promise;
    if (!handler) {
      throw new Error("gateway handler did not start");
    }
    try {
      const observation = await withTestTimeout(
        conversation.observed.promise,
        2_000,
        "fixture did not reach the real runner admission boundary",
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const snapshot = {
        observation,
        main: getCommandLaneSnapshot(CommandLane.Main),
        inference: getCommandLaneSnapshot(CommandLane.SystemAgentInference),
        dispatchCount: dispatch.mock.calls.length,
      };
      // The repair changes this from waiting/queued-on-main to dispatched on
      // the dedicated inference lane while main remains occupied.
      expect(observation, JSON.stringify(snapshot)).toBe("dispatched");
      expect(snapshot.main.queuedCount).toBe(0);
      expect(snapshot.inference.queuedCount).toBe(0);
      expect(snapshot.dispatchCount).toBe(1);
      expect(conversation.captured.mainActiveAtDispatch).toBe(1);
      expect(conversation.captured.inferenceActiveAtDispatch).toBe(1);
    } finally {
      releaseParent.resolve();
      await parent;
      await handler;
    }
  });
});
