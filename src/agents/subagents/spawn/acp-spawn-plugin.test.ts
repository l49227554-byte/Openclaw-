/** Tests plugin-owned ACP spawns: provenance, owner keys, policy reuse, and failure cleanup. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpInitializeSessionInput } from "../../../acp/control-plane/manager.types.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { parseAgentSessionKey, isAcpSessionKey } from "../../../routing/session-key.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import type { PluginAcpSpawnPrincipal } from "./acp-spawn-plugin.js";

const PLUGIN_ID = "factory-adapter";

function createDefaultSpawnConfig(): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex", "claude"],
      defaultAgent: "codex",
    },
    agents: {
      defaults: {
        subagents: {
          allowAgents: ["codex"],
          maxSpawnDepth: 2,
          maxChildrenPerAgent: 2,
        },
      },
    },
    session: { mainKey: "main", scope: "per-sender" },
  };
}

const hoisted = vi.hoisted(() => {
  const state = { cfg: {} as OpenClawConfig };
  return {
    state,
    callGatewayMock: vi.fn(),
    initializeSessionMock: vi.fn(),
    closeRuntimeOnFailureMock: vi.fn(),
    cleanupFailedAcpSpawnMock: vi.fn(),
    registerSubagentRunMock: vi.fn(),
    countActiveRunsForSessionMock: vi.fn(),
    listTasksForOwnerKeyMock: vi.fn(),
    upsertSessionEntryMock: vi.fn(),
    recordSessionCreatedMock: vi.fn(),
    loadSessionEntryMock: vi.fn(),
  };
});

vi.mock("../../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    initializeSession: async (params: AcpInitializeSessionInput) =>
      await hoisted.initializeSessionMock(params),
  }),
}));
vi.mock("../../../acp/control-plane/spawn.js", () => ({
  cleanupFailedAcpSpawn: hoisted.cleanupFailedAcpSpawnMock,
}));
vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: () => hoisted.state.cfg,
}));
vi.mock("../../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/tmp/plugin-acp-sessions.json",
}));
vi.mock("../../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: (scope: unknown) => hoisted.loadSessionEntryMock(scope),
  upsertSessionEntryCore: async (scope: unknown, patch: Partial<SessionEntry>) =>
    await hoisted.upsertSessionEntryMock(scope, patch),
}));
vi.mock("../../../sessions/session-state-events.js", () => ({
  recordSessionCreated: hoisted.recordSessionCreatedMock,
}));
vi.mock("../../../gateway/call.js", () => ({
  callGateway: hoisted.callGatewayMock,
}));
vi.mock("../registry/subagent-registry.js", () => ({
  countActiveRunsForSession: hoisted.countActiveRunsForSessionMock,
  registerSubagentRun: hoisted.registerSubagentRunMock,
}));
vi.mock("../../../tasks/runtime-internal.js", () => ({
  listTasksForOwnerKey: hoisted.listTasksForOwnerKeyMock,
}));

const { spawnAcpForPlugin } = await import("./acp-spawn-plugin.js");
const { resolvePluginAcpOwnerKey } = await import("../../../plugins/runtime/types-acp.js");

type PluginSpawnResult = Awaited<ReturnType<typeof spawnAcpForPlugin>>;

function principal(overrides?: Omit<PluginAcpSpawnPrincipal, "pluginId" | "ownerKey">) {
  return {
    pluginId: PLUGIN_ID,
    ownerKey: resolvePluginAcpOwnerKey(PLUGIN_ID),
    ...overrides,
  };
}

function expectAccepted(result: PluginSpawnResult) {
  if (result.status !== "accepted") {
    throw new Error(`Expected accepted spawn, got ${result.status}: ${result.error}`);
  }
  return result;
}

function expectFailed(result: PluginSpawnResult) {
  if (result.status === "accepted") {
    throw new Error("Expected plugin ACP spawn to fail");
  }
  return result;
}

function createdEntryPatch(): Partial<SessionEntry> {
  const call = hoisted.upsertSessionEntryMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected the child session entry to be created");
  }
  return call[1] as Partial<SessionEntry>;
}

function registration(): Record<string, unknown> {
  const call = hoisted.registerSubagentRunMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected registerSubagentRun to be called");
  }
  return call[0] as Record<string, unknown>;
}

function agentGatewayParams(): Record<string, unknown> {
  const request = hoisted.callGatewayMock.mock.calls
    .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
    .find((candidate) => candidate.method === "agent");
  if (!request?.params) {
    throw new Error("Expected an agent gateway launch");
  }
  return request.params;
}

describe("spawnAcpForPlugin", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
    hoisted.state.cfg = createDefaultSpawnConfig();
    hoisted.callGatewayMock.mockReset().mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      return args.method === "agent" ? { runId: "run-plugin-1" } : {};
    });
    hoisted.closeRuntimeOnFailureMock.mockReset().mockResolvedValue(undefined);
    hoisted.cleanupFailedAcpSpawnMock.mockReset().mockResolvedValue(undefined);
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.recordSessionCreatedMock.mockReset();
    hoisted.countActiveRunsForSessionMock.mockReset().mockReturnValue(0);
    hoisted.listTasksForOwnerKeyMock.mockReset().mockReturnValue([]);
    hoisted.loadSessionEntryMock.mockReset().mockReturnValue(undefined);
    hoisted.upsertSessionEntryMock
      .mockReset()
      .mockImplementation(async (_scope: unknown, patch: Partial<SessionEntry>) => ({
        ...patch,
        sessionId: "sess-plugin",
        updatedAt: Date.now(),
      }));
    hoisted.initializeSessionMock.mockReset().mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as AcpInitializeSessionInput;
      return {
        closeRuntimeOnFailure: hoisted.closeRuntimeOnFailureMock,
        runtime: { close: vi.fn().mockResolvedValue(undefined) },
        handle: { sessionKey: args.sessionKey, backend: "acpx", runtimeSessionName: "rt" },
        meta: {
          backend: "acpx",
          agent: args.agent,
          runtimeSessionName: "rt",
          mode: args.mode,
          state: "idle",
          lastActivityAt: Date.now(),
        },
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("mints a plugin-owned child with plugin provenance and no session lineage", async () => {
    const result = expectAccepted(
      await spawnAcpForPlugin({ task: "Run the suite", label: "nightly" }, principal()),
    );
    expect(result.targetAgentId).toBe("codex");
    expect(result.mode).toBe("run");
    expect(result.expectsCompletionMessage).toBe(false);
    expect(result.childSessionKey).toMatch(
      new RegExp(`^agent:codex:acp:plugin:${PLUGIN_ID}:[0-9a-f-]{36}$`),
    );
    expect(isAcpSessionKey(result.childSessionKey)).toBe(true);
    expect(parseAgentSessionKey(result.childSessionKey)?.agentId).toBe("codex");

    const entry = createdEntryPatch();
    expect(entry.createdVia).toBe("plugin");
    expect(entry.createdActor).toEqual({ type: "system", id: PLUGIN_ID });
    expect(entry.pluginOwnerId).toBe(PLUGIN_ID);
    expect(entry.label).toBe(`plugin:${PLUGIN_ID} nightly`);
    expect(entry.spawnDepth).toBe(1);
    expect(entry).not.toHaveProperty("spawnedBy");
    expect(entry).not.toHaveProperty("parentSessionKey");
    expect(entry).not.toHaveProperty("completionOwnerSessionKey");
    expect(hoisted.recordSessionCreatedMock).toHaveBeenCalledTimes(1);

    const ownerKey = resolvePluginAcpOwnerKey(PLUGIN_ID);
    expect(ownerKey).toBe(`plugin:${PLUGIN_ID}:acp`);
    expect(parseAgentSessionKey(ownerKey)).toBeNull();
    expect(registration()).toMatchObject({
      runId: "run-plugin-1",
      childSessionKey: result.childSessionKey,
      childSessionId: "sess-plugin",
      controllerSessionKey: ownerKey,
      taskOwnerKey: ownerKey,
      requesterSessionKey: ownerKey,
      requesterDisplayKey: `plugin:${PLUGIN_ID}`,
      agentId: "codex",
      requesterAgentId: "codex",
      cleanup: "keep",
      expectsCompletionMessage: false,
      spawnMode: "run",
      label: `plugin:${PLUGIN_ID} nightly`,
    });
    expect(registration()).not.toHaveProperty("requesterOrigin");
    expect(registration()).not.toHaveProperty("requesterTurnRunId");

    const params = agentGatewayParams();
    expect(params).toMatchObject({
      message: "Run the suite",
      sessionKey: result.childSessionKey,
      deliver: false,
      lane: "subagent",
      acpTurnSource: "manual_spawn",
    });
    expect(params).not.toHaveProperty("channel");
    expect(params).not.toHaveProperty("to");
    expect(params).not.toHaveProperty("threadId");
    expect(hoisted.initializeSessionMock.mock.calls[0]?.[0]).toMatchObject({
      mode: "oneshot",
      agent: "codex",
    });
  });

  it("routes only the completion announcement to a host-captured requester", async () => {
    const completionRequester = {
      sessionKey: "agent:main:telegram:group:42",
      origin: { channel: "telegram", to: "telegram:42", accountId: "acct-1", threadId: "7" },
    } as const;
    const result = expectAccepted(
      await spawnAcpForPlugin({ task: "Report back" }, principal({ completionRequester })),
    );
    expect(result.expectsCompletionMessage).toBe(true);
    expect(result.childSessionKey).toMatch(new RegExp(`^agent:codex:acp:plugin:${PLUGIN_ID}:`));

    // Provenance is unchanged: the requester never reaches the child session entry.
    const entry = createdEntryPatch();
    expect(entry.createdVia).toBe("plugin");
    expect(entry.createdActor).toEqual({ type: "system", id: PLUGIN_ID });
    expect(entry.pluginOwnerId).toBe(PLUGIN_ID);
    expect(entry).not.toHaveProperty("spawnedBy");
    expect(entry).not.toHaveProperty("parentSessionKey");
    expect(entry).not.toHaveProperty("deliveryContext");
    expect(entry).not.toHaveProperty("lastChannel");
    expect(entry).not.toHaveProperty("lastTo");

    // Control, admission, and the task row stay plugin-owned; the registry row carries the
    // requester session/origin so the canonical announce owner delivers the completion.
    const ownerKey = resolvePluginAcpOwnerKey(PLUGIN_ID);
    expect(registration()).toEqual({
      runId: "run-plugin-1",
      childSessionKey: result.childSessionKey,
      childSessionId: "sess-plugin",
      controllerSessionKey: ownerKey,
      taskOwnerKey: ownerKey,
      requesterSessionKey: completionRequester.sessionKey,
      requesterOrigin: completionRequester.origin,
      requesterDisplayKey: `plugin:${PLUGIN_ID}`,
      task: "Report back",
      agentId: "codex",
      cleanup: "keep",
      label: `plugin:${PLUGIN_ID}`,
      runTimeoutSeconds: expect.any(Number),
      expectsCompletionMessage: true,
      spawnMode: "run",
    });
    expect(hoisted.countActiveRunsForSessionMock).toHaveBeenCalledWith(ownerKey, expect.anything());
    expect(hoisted.countActiveRunsForSessionMock).not.toHaveBeenCalledWith(
      completionRequester.sessionKey,
      expect.anything(),
    );
    const params = agentGatewayParams();
    expect(params).toMatchObject({ sessionKey: result.childSessionKey, deliver: false });
    expect(params).not.toHaveProperty("channel");
    expect(params).not.toHaveProperty("to");
  });

  it("bounds plugin-attributed labels", async () => {
    expectAccepted(await spawnAcpForPlugin({ task: "x", label: "   " }, principal()));
    expect(registration().label).toBe(`plugin:${PLUGIN_ID}`);

    hoisted.registerSubagentRunMock.mockClear();
    expectAccepted(await spawnAcpForPlugin({ task: "x", label: "x".repeat(500) }, principal()));
    const long = registration().label;
    expect(typeof long).toBe("string");
    expect(long).toHaveLength(80);
    expect((long as string).startsWith(`plugin:${PLUGIN_ID} xxx`)).toBe(true);
    expect((long as string).endsWith("…")).toBe(true);
  });

  it("fails closed when ACP is disabled by policy", async () => {
    hoisted.state.cfg.acp = { ...hoisted.state.cfg.acp, enabled: false };
    const result = expectFailed(await spawnAcpForPlugin({ task: "x" }, principal()));
    expect(result).toMatchObject({ status: "forbidden", errorCode: "acp_disabled" });
    expect(hoisted.upsertSessionEntryMock).not.toHaveBeenCalled();
  });

  it("applies the global ACP agent policy to the plugin target", async () => {
    const result = expectFailed(
      await spawnAcpForPlugin({ task: "x", agentId: "gemini" }, principal()),
    );
    expect(result).toMatchObject({ status: "forbidden", errorCode: "agent_forbidden" });
    expect(hoisted.upsertSessionEntryMock).not.toHaveBeenCalled();
  });

  it("applies the subagent target allowlist under the target agent's policy", async () => {
    const result = expectFailed(
      await spawnAcpForPlugin({ task: "x", agentId: "claude" }, principal()),
    );
    expect(result).toMatchObject({ status: "forbidden", errorCode: "subagent_policy" });
    expect(result.error).toContain("not allowed");
    expect(hoisted.upsertSessionEntryMock).not.toHaveBeenCalled();
  });

  it("rejects the N+1 launch against the plugin owner key", async () => {
    hoisted.countActiveRunsForSessionMock.mockImplementation((ownerKey: string) =>
      ownerKey === resolvePluginAcpOwnerKey(PLUGIN_ID) ? 2 : 0,
    );
    const result = expectFailed(await spawnAcpForPlugin({ task: "x" }, principal()));
    expect(result).toMatchObject({ status: "forbidden", errorCode: "subagent_policy" });
    expect(hoisted.upsertSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
  });

  it("cleans up the created child through the ACP spawn owner when initialization fails", async () => {
    hoisted.initializeSessionMock.mockRejectedValue(new Error("acpx unavailable"));
    const result = expectFailed(await spawnAcpForPlugin({ task: "x" }, principal()));
    expect(result).toMatchObject({ status: "error", errorCode: "spawn_failed" });
    expect(result.error).toContain("acpx unavailable");
    expect(hoisted.cleanupFailedAcpSpawnMock).toHaveBeenCalledTimes(1);
    expect(hoisted.cleanupFailedAcpSpawnMock.mock.calls[0]?.[0]).toMatchObject({
      agentId: "codex",
      deleteTranscript: true,
      sessionEntry: expect.objectContaining({ pluginOwnerId: PLUGIN_ID }),
    });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("cleans up runtime and entry when the Gateway launch fails", async () => {
    hoisted.callGatewayMock.mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      if (args.method === "agent") {
        throw new Error("gateway refused");
      }
      return {};
    });
    const result = expectFailed(await spawnAcpForPlugin({ task: "x" }, principal()));
    expect(result).toMatchObject({ status: "error", errorCode: "dispatch_failed" });
    expect(result.childSessionKey).toMatch(/^agent:codex:acp:plugin:/);
    expect(hoisted.cleanupFailedAcpSpawnMock).toHaveBeenCalledTimes(1);
    expect(hoisted.cleanupFailedAcpSpawnMock.mock.calls[0]?.[0]).toMatchObject({
      closeRuntimeOnFailure: hoisted.closeRuntimeOnFailureMock,
    });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("stops before dispatch when the plugin principal is no longer active", async () => {
    let active = true;
    hoisted.initializeSessionMock.mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as AcpInitializeSessionInput;
      active = false;
      return {
        closeRuntimeOnFailure: hoisted.closeRuntimeOnFailureMock,
        runtime: { close: vi.fn() },
        handle: { sessionKey: args.sessionKey, backend: "acpx", runtimeSessionName: "rt" },
        meta: {
          backend: "acpx",
          agent: args.agent,
          runtimeSessionName: "rt",
          mode: args.mode,
          state: "idle",
          lastActivityAt: Date.now(),
        },
      };
    });
    const result = expectFailed(
      await spawnAcpForPlugin(
        { task: "x" },
        principal({
          assertActive: () => {
            if (!active) {
              throw new Error("plugin runtime retired");
            }
          },
        }),
      ),
    );
    expect(result.status).toBe("error");
    expect(result.error).toContain("plugin runtime retired");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.cleanupFailedAcpSpawnMock).toHaveBeenCalledTimes(1);
  });
});
