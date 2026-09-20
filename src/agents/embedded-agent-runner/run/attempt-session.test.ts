import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isEmbeddedMode, setEmbeddedMode } from "../../../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  getEmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../../../infra/embedded-plugin-approval-broker.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import type { AgentTool } from "../../runtime/index.js";
import { agentSessionSetPromptPreparation } from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/index.js";
import type { SemanticStallReplanState } from "./semantic-stall-replan.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const EXPECTED_REPLAN_INSTRUCTION =
  "The recent tool trajectory is strongly stalled. Reassess the active task and take one materially different, safe next step; do not repeat the stalled action.";

const hoisted = vi.hoisted(() => ({
  applyAgentAutoCompactionGuard: vi.fn(),
  applyAgentCompactionSettingsFromConfig: vi.fn(),
  applySystemPromptToSession: vi.fn(),
  buildEmbeddedExtensionFactories: vi.fn(),
  createAgentSessionForEmbeddedRunner: vi.fn(),
  createEmbeddedAgentResourceLoader: vi.fn(),
  createPreparedEmbeddedAgentSettingsManager: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  installMessageToolOnlyTerminalHook: vi.fn(),
  prepareEmbeddedAttemptClientTools: vi.fn(),
  resolveEffectiveCompactionMode: vi.fn(),
  isSilentOverflowProneModel: vi.fn(),
  resolveToolSearchCatalogTool: vi.fn(),
  toToolDefinitions: vi.fn(),
  wrapToolDefinition: vi.fn(),
  notifyToolActivity: vi.fn(),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunner,
}));
vi.mock("../../agent-project-settings.js", () => ({
  createPreparedEmbeddedAgentSettingsManager: hoisted.createPreparedEmbeddedAgentSettingsManager,
}));
vi.mock("../../agent-settings.js", () => ({
  applyAgentAutoCompactionGuard: hoisted.applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig: hoisted.applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel: hoisted.isSilentOverflowProneModel,
  resolveEffectiveCompactionMode: hoisted.resolveEffectiveCompactionMode,
}));
vi.mock("../../agent-tool-definition-adapter.js", () => ({
  toToolDefinitions: hoisted.toToolDefinitions,
}));
vi.mock("../../sessions/sdk.js", () => ({
  createAgentSessionForEmbeddedRunner: hoisted.createAgentSessionForEmbeddedRunner,
}));
vi.mock("../../sessions/tools/tool-definition-wrapper.js", () => ({
  wrapToolDefinition: hoisted.wrapToolDefinition,
}));
vi.mock("../../tool-search.js", () => ({
  resolveToolSearchCatalogTool: hoisted.resolveToolSearchCatalogTool,
}));
vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: hoisted.buildEmbeddedExtensionFactories,
}));
vi.mock("../logger.js", () => ({ log: { info: vi.fn() } }));
vi.mock("../resource-loader.js", () => ({
  createEmbeddedAgentResourceLoader: hoisted.createEmbeddedAgentResourceLoader,
}));
vi.mock("../system-prompt.js", () => ({
  applySystemPromptToSession: hoisted.applySystemPromptToSession,
}));
vi.mock("./attempt-client-tools.js", () => ({
  prepareEmbeddedAttemptClientTools: hoisted.prepareEmbeddedAttemptClientTools,
}));
vi.mock("./message-tool-terminal.js", () => ({
  installMessageToolOnlyTerminalHook: hoisted.installMessageToolOnlyTerminalHook,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({
  notifyToolActivity: hoisted.notifyToolActivity,
}));

import { prepareEmbeddedAttemptAgentSession } from "./attempt-session-prepare.js";

const attempt = {
  authStorage: { id: "auth" },
  config: {},
  contextTokenBudget: 32_000,
  model: { id: "model-1", api: "anthropic-messages" },
  modelId: "model-1",
  modelRegistry: { id: "registry" },
  provider: "anthropic",
  prompt: "prompt",
  runId: "run-1",
  sessionId: "session-1",
  sourceReplyDeliveryMode: "message_tool_only",
  timeoutMs: 30_000,
  workspaceDir: "/workspace",
} as unknown as EmbeddedRunAttemptParams;

function createInput(options?: { activationError?: Error }) {
  const events: string[] = [];
  const settingsManager = { id: "settings" };
  const resourceLoader = {
    reload: vi.fn(async () => {
      events.push("resource-reload");
    }),
  };
  const setActiveToolsByName = vi.fn(() => {
    events.push("activate-tools");
    if (options?.activationError) {
      throw options.activationError;
    }
  });
  const setPromptPreparation = vi.fn<AgentSession[typeof agentSessionSetPromptPreparation]>();
  const activeSession = {
    [agentSessionSetPromptPreparation]: setPromptPreparation,
    agent: { id: "agent", subscribe: vi.fn(), state: { systemPrompt: "", tools: [] } },
    setActiveToolsByName,
    replaceCustomTools: vi.fn(),
  } as unknown as AgentSession;
  const sessionManager = { id: "session-manager" };
  const transcriptLifecycle = {
    withTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
  };
  const hookRunner = { id: "hooks" };
  const sessionToolAllowlist = [{ name: "read" }];
  const allCustomTools = [{ name: "custom" }];
  const clientToolRuntime = {
    builtinToolNames: new Set(["read"]),
    coreBuiltinToolNames: new Set(["read"]),
    clientToolCallSlots: [],
    clientToolDefs: [],
    replaySafeToolNames: new Set(["read"]),
    replaySafeTools: new Set(allCustomTools),
    trustedLocalMediaToolNames: new Set(["read"]),
  };
  let onDeliveredSourceReply: (() => void) | undefined;

  hoisted.createPreparedEmbeddedAgentSettingsManager.mockReturnValue(settingsManager);
  hoisted.resolveEffectiveCompactionMode.mockReturnValue("safeguard");
  hoisted.isSilentOverflowProneModel.mockReturnValue(false);
  hoisted.buildEmbeddedExtensionFactories.mockReturnValue([{ id: "extension" }]);
  hoisted.createEmbeddedAgentResourceLoader.mockReturnValue(resourceLoader);
  hoisted.getGlobalHookRunner.mockReturnValue(hookRunner);
  hoisted.prepareEmbeddedAttemptClientTools.mockReturnValue({
    allCustomTools,
    sessionToolAllowlist,
    ...clientToolRuntime,
    refreshTools: vi.fn(),
  });
  hoisted.createAgentSessionForEmbeddedRunner.mockImplementation(async () => {
    events.push("create-session");
    return { session: activeSession };
  });
  hoisted.applySystemPromptToSession.mockImplementation((_session, prompt: string) => {
    activeSession.agent.state.systemPrompt = prompt;
    events.push("apply-system-prompt");
  });
  hoisted.installMessageToolOnlyTerminalHook.mockImplementation(
    (input: { onDeliveredSourceReply?: () => void }) => {
      events.push("install-terminal-hook");
      onDeliveredSourceReply = input.onDeliveredSourceReply;
    },
  );

  return {
    activeSession,
    setPromptPreparation,
    allCustomTools,
    clientToolRuntime,
    events,
    hookRunner,
    input: {
      attempt,
      agentCoreThinkingLevel: "high" as const,
      agentDir: "/agent",
      clientToolPreparation: {
        codeModeControlsEnabledForRun: true,
        deferredDirectoryToolsCallable: false,
      } as never,
      effectiveCwd: "/workspace",
      getCurrentAttemptPluginMetadataSnapshot: () => undefined,
      initialSystemPrompt: "system prompt",
      markStage: (stage: string) => events.push(`stage:${stage}`),
      onSessionCreated: (session: AgentSession) => {
        expect(session).toBe(activeSession);
        events.push("publish-session");
      },
      onSystemPromptChanged: (systemPrompt: string) => {
        expect(systemPrompt).toBe("system prompt");
        events.push("publish-system-prompt");
      },
      runAbortSignal: new AbortController().signal,
      sessionAgentId: "agent-1",
      transcriptLifecycle: transcriptLifecycle as never,
      sessionManager: sessionManager as never,
    },
    onDeliveredSourceReply: () => onDeliveredSourceReply?.(),
    resourceLoader,
    setActiveToolsByName,
    sessionToolAllowlist,
    settingsManager,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareEmbeddedAttemptAgentSession", () => {
  it("cancels a hydrated directory tool's approval with its captured permission generation", async () => {
    const fixture = createInput();
    const generation = new AbortController();
    fixture.input.clientToolPreparation = {
      codeModeControlsEnabledForRun: false,
      deferredDirectoryToolsCallable: true,
      getToolAbortSignal: () => generation.signal,
    } as never;
    await prepareEmbeddedAttemptAgentSession(fixture.input);
    const { toToolDefinitions } = await vi.importActual<
      typeof import("../../agent-tool-definition-adapter.js")
    >("../../agent-tool-definition-adapter.js");
    const { wrapToolDefinition } = await vi.importActual<
      typeof import("../../sessions/tools/tool-definition-wrapper.js")
    >("../../sessions/tools/tool-definition-wrapper.js");
    hoisted.toToolDefinitions.mockImplementation(toToolDefinitions);
    hoisted.wrapToolDefinition.mockImplementation(wrapToolDefinition);
    hoisted.getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "before_tool_call",
      runBeforeToolCall: async () => ({
        requireApproval: { title: "MCP write", description: "Approve remote mutation" },
      }),
    });
    const execute = vi.fn(async () => ({ content: [], details: { changed: true } }));
    hoisted.resolveToolSearchCatalogTool.mockReturnValue(
      wrapToolWithAbortSignal(
        {
          name: "mcp_write",
          label: "Write",
          description: "Write",
          parameters: Type.Object({}),
          execute,
        },
        generation.signal,
      ),
    );
    const previousMode = isEmbeddedMode();
    const previousBroker = getEmbeddedPluginApprovalBroker();
    const broker = new EmbeddedPluginApprovalBroker();
    const requested = createDeferredCore();
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.requested") {
        requested.resolve();
      }
    });
    setEmbeddedMode(true);
    setEmbeddedPluginApprovalBroker(broker);
    const resolveDeferredTool =
      hoisted.createAgentSessionForEmbeddedRunner.mock.calls[0]![0].resolveDeferredTool;
    const tool = resolveDeferredTool({ toolCall: { name: "mcp_write" } });
    const settled = Promise.allSettled([tool.execute("deferred-write", {})]);
    try {
      await requested.promise;
      expect(broker.listPending()).toHaveLength(1);
      generation.abort(new Error("Permission change"));
      expect(broker.listPending()).toHaveLength(0);
      await settled;
      expect(execute).not.toHaveBeenCalled();
    } finally {
      broker.stop();
      await settled;
      setEmbeddedPluginApprovalBroker(previousBroker);
      setEmbeddedMode(previousMode);
    }
  });

  it("refreshes permission guidance when hook tool caps change without new prompt bytes", async () => {
    const fixture = createInput();
    fixture.input.onSystemPromptChanged = vi.fn();
    const prepared = await prepareEmbeddedAttemptAgentSession(fixture.input);
    let currentToolNames = ["read", "write"];
    prepared.setPermissionPromptPreparation(
      async () => () => `Permission tools: ${currentToolNames.join(", ")}`,
    );
    await fixture.activeSession.agent.prepareNextTurn?.(new AbortController().signal);
    expect(fixture.activeSession.agent.state.systemPrompt).toBe("Permission tools: read, write");

    // A late prompt hook may narrow tools without supplying a new system prompt.
    currentToolNames = ["read"];
    await fixture.activeSession.agent.prepareNextTurn?.(new AbortController().signal);

    expect(fixture.activeSession.agent.state.systemPrompt).toBe("Permission tools: read");
  });

  it("keeps updated permission tools and prompt when an older next-turn hook finishes later", async () => {
    const fixture = createInput();
    fixture.input.onSystemPromptChanged = vi.fn();
    type Snapshot = Awaited<
      ReturnType<NonNullable<typeof fixture.activeSession.agent.prepareNextTurn>>
    >;
    const pending = createDeferredCore<Snapshot>();
    fixture.activeSession.agent.prepareNextTurn = () => pending.promise;
    const prepared = await prepareEmbeddedAttemptAgentSession(fixture.input);
    const nextTurn = fixture.activeSession.agent.prepareNextTurn?.(new AbortController().signal);
    const readTool: AgentTool = {
      name: "read",
      label: "Read",
      description: "Current read-only tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };
    const currentTools = [readTool];
    fixture.activeSession.agent.state.tools = currentTools;

    prepared.refreshTools();
    prepared.setPermissionPromptPreparation(
      async () => (prompt) => `Permission change: read-only\n${prompt}`,
    );
    pending.resolve({
      context: {
        systemPrompt: "old hook prompt",
        messages: [],
        tools: [{ ...readTool, name: "stale_write" }],
      },
    });

    const snapshot = await nextTurn;
    expect(snapshot?.context?.systemPrompt).toBe("Permission change: read-only\nold hook prompt");
    expect(snapshot?.context?.tools).toEqual(currentTools);
    expect(fixture.activeSession.agent.state.systemPrompt).toBe(snapshot?.context?.systemPrompt);
  });

  it("composes one semantic stall replan with contextual prepare and permission refresh", async () => {
    const fixture = createInput();
    fixture.input.onSystemPromptChanged = vi.fn();
    const assertActive = vi.fn();
    const state: SemanticStallReplanState = {
      observer: {
        observeOutcome: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        snapshot: vi.fn(() => ({
          trajectoryVersion: 3,
          latestJudgment: {
            verdict: "stalled" as const,
            probability: 0.97,
            evidence: { detector: "generic_repeat", level: "critical" as const, count: 20 },
            trajectorySize: 8,
            trajectoryVersion: 3,
            toolCallOrdinal: 3,
          },
          metrics: {
            observedOutcomes: 3,
            decisionCalls: 1,
            unavailableDecisions: 0,
            invalidDecisions: 0,
            staleDecisions: 0,
            skippedWhilePending: 0,
            candidateFollowOnCalls: 0,
            verdicts: { progress: 0, stalled: 1, regressing: 0, uncertain: 0 },
          },
        })),
      },
      assertActive,
      used: false,
    };
    fixture.input.attempt = {
      ...fixture.input.attempt,
      semanticStallReplanState: state,
    };
    fixture.activeSession.agent.prepareNextTurn = async () => ({
      context: { systemPrompt: "hook prompt", messages: [], tools: [] },
    });
    fixture.activeSession.agent.prepareNextTurnWithContext = async (_turn, signal) => {
      const snapshot = await fixture.activeSession.agent.prepareNextTurn?.(signal);
      return snapshot ?? undefined;
    };
    const prepared = await prepareEmbeddedAttemptAgentSession(fixture.input);
    prepared.setPermissionPromptPreparation(async () => (prompt) => `permission\n${prompt}`);
    const contextualHook = fixture.activeSession.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("contextual prepare hook was not installed");
    }

    const messages: never[] = [];
    const result = await contextualHook(
      {
        message: {} as never,
        toolResults: [],
        context: { systemPrompt: "turn prompt", messages, tools: [] },
        newMessages: [],
      },
      new AbortController().signal,
    );

    expect(result?.context?.systemPrompt).toBe(
      `permission\nhook prompt\n\n${EXPECTED_REPLAN_INSTRUCTION}`,
    );
    expect(result?.context?.messages).toEqual([]);
    expect(state.used).toBe(true);
    expect(assertActive).toHaveBeenCalledOnce();
    expect(fixture.input.onSystemPromptChanged).toHaveBeenCalledWith("system prompt");
    expect(fixture.input.onSystemPromptChanged).toHaveBeenCalledWith("permission\nhook prompt");

    const second = await contextualHook(
      {
        message: {} as never,
        toolResults: [],
        context: { systemPrompt: "next prompt", messages, tools: [] },
        newMessages: [],
      },
      new AbortController().signal,
    );
    expect(second?.context?.systemPrompt).toBe("permission\nhook prompt");
    expect(assertActive).toHaveBeenCalledOnce();
  });

  it.each(["legacy", "context", "metadata"] as const)(
    "retires the instruction before subsequent hook composition (%s)",
    async (kind) => {
      const contextual = kind === "context";
      const fixture = createInput();
      const assertActive = vi.fn();
      fixture.input.attempt = {
        ...fixture.input.attempt,
        semanticStallReplanState: {
          used: false,
          assertActive,
          observer: {
            observeOutcome: async () => undefined,
            close: async () => undefined,
            snapshot: () => ({
              trajectoryVersion: 1,
              latestJudgment: {
                verdict: "stalled",
                probability: 0.99,
                trajectoryVersion: 1,
                evidence: { detector: "generic_repeat", level: "warning", count: 10 },
                trajectorySize: 8,
                toolCallOrdinal: 11,
              },
              metrics: {
                observedOutcomes: 11,
                decisionCalls: 1,
                unavailableDecisions: 0,
                invalidDecisions: 0,
                staleDecisions: 0,
                skippedWhilePending: 0,
                candidateFollowOnCalls: 0,
                verdicts: { progress: 0, stalled: 1, regressing: 0, uncertain: 0 },
              },
            }),
          },
        },
      };
      fixture.activeSession.agent.prepareNextTurn = async () => undefined;
      Reflect.deleteProperty(fixture.activeSession.agent, "prepareNextTurnWithContext");
      if (contextual) {
        fixture.activeSession.agent.prepareNextTurnWithContext = async (turn) => ({
          context: { ...turn.context, systemPrompt: `${turn.context.systemPrompt}\npolicy` },
        });
      }
      if (kind === "metadata") {
        fixture.activeSession.agent.prepareNextTurnWithContext = async () => ({ stop: false });
      }
      await prepareEmbeddedAttemptAgentSession(fixture.input);
      const hook = fixture.activeSession.agent.prepareNextTurnWithContext;
      if (!hook) {
        throw new Error("context-aware replan hook missing");
      }
      const turn = {
        message: {} as never,
        toolResults: [],
        newMessages: [],
        context: { systemPrompt: "base", messages: [], tools: [] },
      };
      const first = await hook(turn, new AbortController().signal);
      expect(first?.context?.systemPrompt).toBe(
        `${contextual ? "base\npolicy" : "base"}\n\n${EXPECTED_REPLAN_INSTRUCTION}`,
      );
      const second = await hook(
        { ...turn, context: first!.context! },
        new AbortController().signal,
      );
      expect(second?.context?.systemPrompt).toBe(contextual ? "base\npolicy\npolicy" : "base");
      expect(assertActive).toHaveBeenCalledOnce();
      expect(fixture.activeSession.agent.state.systemPrompt).toBe("system prompt");
    },
  );

  it("prepares resources and publishes the activated session runtime", async () => {
    const fixture = createInput();

    const result = await prepareEmbeddedAttemptAgentSession(fixture.input);

    expect(fixture.events).toEqual([
      "resource-reload",
      "stage:session-resource-loader",
      "create-session",
      "publish-session",
      "activate-tools",
      "publish-system-prompt",
      "apply-system-prompt",
      "install-terminal-hook",
      "stage:agent-session",
    ]);
    expect(hoisted.applyAgentAutoCompactionGuard).toHaveBeenCalledTimes(2);
    expect(hoisted.applyAgentCompactionSettingsFromConfig).toHaveBeenCalledOnce();
    expect(hoisted.applyAgentCompactionSettingsFromConfig.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.applyAgentAutoCompactionGuard.mock.invocationCallOrder[1] ?? 0,
    );
    const sessionCall = hoisted.createAgentSessionForEmbeddedRunner.mock.calls[0];
    expect(sessionCall?.[0]).toMatchObject({ resourceLoader: fixture.resourceLoader });
    expect(sessionCall?.[1]).toMatchObject({
      beforeToolBatch: undefined,
      contextOverflowRecoveryOwner: "caller",
    });
    expect(sessionCall?.[0]).not.toHaveProperty("contextOverflowRecoveryOwner");
    expect(fixture.setActiveToolsByName).toHaveBeenCalledWith(fixture.sessionToolAllowlist);
    expect(result).toEqual(
      expect.objectContaining({
        activeSession: fixture.activeSession,
        allCustomTools: fixture.allCustomTools,
        hookRunner: fixture.hookRunner,
        settingsManager: fixture.settingsManager,
        ...fixture.clientToolRuntime,
      }),
    );
    expect(result.hasDeliveredSourceReply()).toBe(false);
    fixture.onDeliveredSourceReply();
    expect(result.hasDeliveredSourceReply()).toBe(true);
  });

  it.each(["replace", "replace-reject", "replace-pending", "abort", "current-error"] as const)(
    "discards permission prompt preparation after %s",
    async (closure) => {
      const fixture = createInput();
      fixture.input.onSystemPromptChanged = vi.fn();
      const prepared = await prepareEmbeddedAttemptAgentSession(fixture.input);
      const pending = createDeferredCore<(prompt: string) => string>();
      const entered = createDeferredCore();
      const staleRenderer = vi.fn(() => "stale permission prompt");
      prepared.setPermissionPromptPreparation(() => {
        entered.resolve();
        return pending.promise;
      });
      const controller = new AbortController();
      const nextTurn = fixture.activeSession.agent.prepareNextTurn!(controller.signal);
      const settled = Promise.allSettled([nextTurn]);
      await entered.promise;
      if (closure === "abort") {
        controller.abort();
      } else if (closure !== "current-error") {
        prepared.setPermissionPromptPreparation(async () => () => "current permission prompt");
      }
      if (closure === "replace-reject" || closure === "current-error") {
        pending.reject(new Error("obsolete memory preparation failed"));
      } else if (closure !== "replace-pending") {
        pending.resolve(staleRenderer);
      }
      const [result] = await settled;
      pending.resolve(staleRenderer);
      expect(staleRenderer).not.toHaveBeenCalled();
      const rejected = closure === "abort" || closure === "current-error";
      expect(result.status).toBe(rejected ? "rejected" : "fulfilled");
      if (closure === "current-error") {
        expect(result).toMatchObject({ reason: { message: "obsolete memory preparation failed" } });
      }
      if (!rejected) {
        expect(fixture.activeSession.agent.state.systemPrompt).toBe("current permission prompt");
      }
    },
  );

  it("fences initial prompt preparation after run cancellation without a policy change", async () => {
    const fixture = createInput();
    const controller = new AbortController();
    fixture.input.runAbortSignal = controller.signal;
    await prepareEmbeddedAttemptAgentSession(fixture.input);
    const prepare = fixture.setPromptPreparation.mock.lastCall?.[0];
    expect(prepare).toBeTypeOf("function");
    const reason = new Error("run closed during SDK prompt hooks");
    controller.abort(reason);
    await expect(prepare!()).rejects.toBe(reason);
  });

  it.each([false, true])(
    "checks replay ownership synchronously after preparation with cancellation %s",
    async (cancel) => {
      const fixture = createInput();
      const controller = new AbortController();
      const assertInitialUserTurnReplay = vi.fn();
      await prepareEmbeddedAttemptAgentSession({
        ...fixture.input,
        runAbortSignal: controller.signal,
        assertInitialUserTurnReplay,
      });
      const admit = await fixture.setPromptPreparation.mock.lastCall?.[0]?.();
      expect(assertInitialUserTurnReplay).not.toHaveBeenCalled();
      const reason = new Error("closed after preparation");
      if (cancel) {
        controller.abort(reason);
        expect(() => admit?.()).toThrow(reason);
        expect(assertInitialUserTurnReplay).not.toHaveBeenCalled();
      } else {
        admit?.();
        expect(assertInitialUserTurnReplay).toHaveBeenCalledOnce();
      }
    },
  );

  it("leaves overflow recovery with the session when no model budget was resolved", async () => {
    const fixture = createInput();
    fixture.input.attempt = {
      ...fixture.input.attempt,
      contextTokenBudget: undefined,
    };

    await prepareEmbeddedAttemptAgentSession(fixture.input);

    expect(hoisted.createAgentSessionForEmbeddedRunner.mock.calls[0]?.[1]).toMatchObject({
      beforeToolBatch: undefined,
      contextOverflowRecoveryOwner: "session",
    });
  });

  it("publishes session ownership before activation can fail", async () => {
    const fixture = createInput({ activationError: new Error("activation failed") });

    await expect(prepareEmbeddedAttemptAgentSession(fixture.input)).rejects.toThrow(
      "activation failed",
    );

    expect(fixture.events).toEqual([
      "resource-reload",
      "stage:session-resource-loader",
      "create-session",
      "publish-session",
      "activate-tools",
    ]);
  });
});
