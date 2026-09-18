import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnAcpForPluginResult } from "../agents/subagents/spawn/acp-spawn-plugin.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createPluginSubagentRequesterContext,
  withPluginSubagentRequesterContext,
} from "../plugins/runtime/subagent-requester-context.js";
import {
  type PluginAcpObserveEvent,
  PluginAcpRuntimeError,
  resolvePluginAcpOwnerKey,
} from "../plugins/runtime/types-acp.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { registerPluginAcpIdempotencyTests } from "./server-plugin-acp-runtime.test-support.js";
import * as inProcessDispatch from "./server-plugin-in-process-dispatch.js";

const PLUGIN_ID = "factory-adapter";
const OTHER_PLUGIN_ID = "other-plugin";
const OWNER_KEY = resolvePluginAcpOwnerKey(PLUGIN_ID);

const hoisted = vi.hoisted(() => ({
  spawnAcpForPluginMock: vi.fn(),
  listTasksForOwnerKeyMock: vi.fn(),
  getTaskByIdMock: vi.fn(),
  cancelDetachedTaskRunByIdMock: vi.fn(),
  loadSessionEntryMock: vi.fn(),
  readAcpSessionMetaMock: vi.fn(),
}));

vi.mock("../agents/subagents/spawn/acp-spawn-plugin.js", () => ({
  spawnAcpForPlugin: hoisted.spawnAcpForPluginMock,
}));
vi.mock(import("../tasks/task-registry-query.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  listTasksForOwnerKey: hoisted.listTasksForOwnerKeyMock,
  getTaskById: hoisted.getTaskByIdMock,
}));
vi.mock(import("../tasks/task-executor.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  cancelDetachedTaskRunById: hoisted.cancelDetachedTaskRunByIdMock,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: hoisted.loadSessionEntryMock,
}));
vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionMeta: hoisted.readAcpSessionMetaMock,
}));

const { createGatewayAcpRuntime } = await import("./server-plugin-acp-runtime.js");

let config: OpenClawConfig;
let context: GatewayRequestContext | undefined;
let lifetime: AbortController;
let tasks: TaskRecord[];

function createRuntime(
  resolveGatewayContext: (() => GatewayRequestContext | undefined) | undefined = () => context,
) {
  return createGatewayAcpRuntime(resolveGatewayContext, lifetime.signal);
}

function task(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    runtime: "subagent",
    requesterSessionKey: OWNER_KEY,
    ownerKey: OWNER_KEY,
    scopeKind: "session",
    childSessionKey: `agent:codex:acp:plugin:${PLUGIN_ID}:${overrides.taskId}`,
    runId: `run-${overrides.taskId}`,
    task: "do work",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 1_000,
    ...overrides,
  };
}

function acceptedSpawn(overrides?: Partial<SpawnAcpForPluginResult>): SpawnAcpForPluginResult {
  return {
    status: "accepted",
    childSessionKey: `agent:codex:acp:plugin:${PLUGIN_ID}:child-1`,
    runId: "run-1",
    mode: "run",
    runTimeoutSeconds: 900,
    expectsCompletionMessage: false,
    targetAgentId: "codex",
    ...overrides,
  } as SpawnAcpForPluginResult;
}

type ScopeOverrides = {
  client?: GatewayRequestOptions["client"];
  pluginId?: string;
  pluginOrigin?: "bundled" | "global" | "workspace";
};

function scoped<T>(run: () => T, overrides: ScopeOverrides = {}): T {
  return withPluginRuntimeGatewayRequestScope(
    {
      pluginId: overrides.pluginId ?? PLUGIN_ID,
      pluginOrigin: overrides.pluginOrigin ?? "bundled",
      isWebchatConnect: () => false,
      ...(overrides.client ? { client: overrides.client } : {}),
    },
    run,
  );
}

const requestClient = {
  connect: { scopes: ["operator.write"] },
} as unknown as NonNullable<GatewayRequestOptions["client"]>;

async function expectAcpError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof PluginAcpRuntimeError)) {
    throw new Error(`Expected PluginAcpRuntimeError ${code}, got ${String(error)}`);
  }
  expect(error.code).toBe(code);
  return error;
}

beforeEach(() => {
  resetAgentEventsForTest();
  config = {
    acp: { enabled: true },
    plugins: { entries: { [PLUGIN_ID]: { acp: { allowDetachedSpawn: true } } } },
  };
  context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  lifetime = new AbortController();
  tasks = [];
  hoisted.listTasksForOwnerKeyMock
    .mockReset()
    .mockImplementation((ownerKey: string) => tasks.filter((entry) => entry.ownerKey === ownerKey));
  hoisted.getTaskByIdMock
    .mockReset()
    .mockImplementation((taskId: string) => tasks.find((entry) => entry.taskId === taskId));
  hoisted.spawnAcpForPluginMock.mockReset().mockResolvedValue(acceptedSpawn());
  hoisted.cancelDetachedTaskRunByIdMock.mockReset();
  hoisted.loadSessionEntryMock.mockReset().mockReturnValue(undefined);
  hoisted.readAcpSessionMetaMock.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  lifetime.abort();
  vi.restoreAllMocks();
});

describe("plugin ACP runtime principal", () => {
  it("fails closed without a plugin principal", async () => {
    const runtime = createRuntime();
    await expectAcpError(runtime.spawn({ task: "x" }), "ACP_PLUGIN_PRINCIPAL_REQUIRED");
    await expectAcpError(runtime.listRuns(), "ACP_PLUGIN_PRINCIPAL_REQUIRED");
    await expect(runtime.isAvailable()).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_PRINCIPAL_REQUIRED",
    });
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("fails closed without an in-process Gateway context", async () => {
    context = undefined;
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x" })),
      "ACP_PLUGIN_GATEWAY_REQUIRED",
    );
    await expect(scoped(() => runtime.isAvailable())).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_GATEWAY_REQUIRED",
    });
  });

  it("closes retained method closures after the runtime lifetime ends", async () => {
    const runtime = createRuntime();
    const spawn = runtime.spawn;
    lifetime.abort();
    await expectAcpError(
      scoped(() => spawn({ task: "x" })),
      "ACP_PLUGIN_RUNTIME_CLOSED",
    );
    await expectAcpError(
      scoped(() => runtime.getRun({ runId: "run-1" })),
      "ACP_PLUGIN_RUNTIME_CLOSED",
    );
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });
});

describe("plugin ACP spawn authority", () => {
  it("denies detached spawns by default", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x" })),
      "ACP_PLUGIN_DETACHED_FORBIDDEN",
    );
    await expect(scoped(() => runtime.isAvailable())).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_DETACHED_FORBIDDEN",
    });
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("denies detached spawns for untrusted plugins even with the flag", async () => {
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x" }), { pluginOrigin: "workspace" }),
      "ACP_PLUGIN_DETACHED_FORBIDDEN",
    );
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("accepts detached spawns for trusted plugins with the flag and binds the plugin principal", async () => {
    const runtime = createRuntime();
    await expect(scoped(() => runtime.isAvailable())).resolves.toEqual({
      ok: true,
      mode: "detached",
    });
    tasks.push(task({ taskId: "t1", runId: "run-1" }));
    const result = await scoped(() => runtime.spawn({ task: "Run it", cwd: "/repo" }));
    expect(result).toEqual({
      runId: "run-1",
      taskId: "t1",
      sessionKey: `agent:codex:acp:plugin:${PLUGIN_ID}:child-1`,
      agentId: "codex",
      runTimeoutSeconds: 900,
    });
    const [input, principal] = hoisted.spawnAcpForPluginMock.mock.calls[0] ?? [];
    expect(input).toMatchObject({ task: "Run it", cwd: "/repo" });
    expect(principal).toMatchObject({ pluginId: PLUGIN_ID, ownerKey: OWNER_KEY });
    expect(typeof principal.assertActive).toBe("function");
  });

  it("treats a live request or requester context as request-scoped without inheriting it", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    await expect(scoped(() => runtime.isAvailable(), { client: requestClient })).resolves.toEqual({
      ok: true,
      mode: "request",
    });
    await scoped(() => runtime.spawn({ task: "x" }), { client: requestClient });
    await withPluginSubagentRequesterContext(
      { sessionKey: "agent:main:main", origin: { channel: "telegram", to: "telegram:1" } },
      () => scoped(() => runtime.spawn({ task: "y" })),
    );
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
    for (const call of hoisted.spawnAcpForPluginMock.mock.calls) {
      expect(call[1]).toMatchObject({ pluginId: PLUGIN_ID, ownerKey: OWNER_KEY });
      expect(call[1]).not.toHaveProperty("requesterSessionKey");
      expect(call[1]).not.toHaveProperty("completionRequester");
      expect(call[0]).not.toHaveProperty("requesterSessionKey");
      expect(call[0]).not.toHaveProperty("completionDelivery");
    }
  });

  it("reports ACP disabled through isAvailable", async () => {
    config.acp = { enabled: false };
    await expect(scoped(() => createRuntime().isAvailable())).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_DISABLED",
    });
  });

  it("expires request authority once the host request callback returns", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let later!: Promise<unknown>;
    let availableLater!: ReturnType<PluginRuntime["acp"]["isAvailable"]>;
    await scoped(
      async () => {
        await expect(runtime.isAvailable()).resolves.toEqual({ ok: true, mode: "request" });
        // Armed inside the request (so the scope is inherited), but the host never awaits it.
        later = (async () => {
          await barrier;
          return runtime.spawn({ task: "detached-after-request" });
        })();
        availableLater = barrier.then(() => runtime.isAvailable());
      },
      { client: requestClient, pluginOrigin: "workspace" },
    );
    release();
    await expectAcpError(later, "ACP_PLUGIN_DETACHED_FORBIDDEN");
    await expect(availableLater).resolves.toMatchObject({
      ok: false,
      code: "ACP_PLUGIN_DETACHED_FORBIDDEN",
    });
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("stops an in-flight spawn whose request ended before the owner is reached", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    // The spawn starts synchronously inside the request but is not awaited by the host,
    // so the lease is gone by the time the spawn owner would be invoked.
    let later!: Promise<unknown>;
    scoped(
      () => {
        later = runtime.spawn({ task: "unawaited" });
      },
      { client: requestClient, pluginOrigin: "workspace" },
    );
    const error = await expectAcpError(later, "ACP_PLUGIN_DETACHED_FORBIDDEN");
    expect(error.message).toContain("lost its Gateway request while the spawn was in flight");
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("keeps request authority for work the host awaits and rechecks it per side effect", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    let assertActive: (() => void) | undefined;
    hoisted.spawnAcpForPluginMock.mockImplementation(
      async (_input: unknown, principal: { assertActive?: () => void }) => {
        assertActive = principal.assertActive;
        assertActive?.();
        await Promise.resolve();
        assertActive?.();
        return acceptedSpawn();
      },
    );
    const result = await scoped(() => runtime.spawn({ task: "awaited" }), {
      client: requestClient,
      pluginOrigin: "workspace",
    });
    expect(result.runId).toBe("run-1");
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(1);
    // The owner's retained fence fails closed after the request has returned.
    expect(assertActive).toBeTypeOf("function");
    expect(assertActive).toThrow(PluginAcpRuntimeError);
  });

  it("does not let plugin code mint request authority by mutating the exposed scope", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    const { getPluginRuntimeGatewayRequestScope } =
      await import("../plugins/runtime/gateway-request-scope.js");
    await expectAcpError(
      scoped(
        () => {
          const scope = getPluginRuntimeGatewayRequestScope();
          scope!.client = requestClient;
          return runtime.spawn({ task: "forged" });
        },
        { pluginOrigin: "workspace" },
      ),
      "ACP_PLUGIN_DETACHED_FORBIDDEN",
    );
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("lets a trusted detached grant run after its arming request has ended", async () => {
    const runtime = createRuntime();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let later!: Promise<unknown>;
    await scoped(
      async () => {
        later = (async () => {
          await barrier;
          return runtime.spawn({ task: "detached-by-grant" });
        })();
      },
      { client: requestClient },
    );
    release();
    await expect(later).resolves.toMatchObject({ runId: "run-1" });
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(1);
  });
});

describe("plugin ACP requester-bound completion delivery", () => {
  const requester = {
    sessionKey: "agent:main:telegram:group:42",
    origin: { channel: "telegram", to: "telegram:42", accountId: "acct-1", threadId: "7" },
  } as const;

  it("passes only the host-captured requester to the plugin spawn owner", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    hoisted.spawnAcpForPluginMock.mockResolvedValue(
      acceptedSpawn({ expectsCompletionMessage: true }),
    );
    const result = await withPluginSubagentRequesterContext(requester, () =>
      scoped(() => runtime.spawn({ task: "Report back", completionDelivery: "current-requester" })),
    );
    expect(result.runId).toBe("run-1");
    const [input, principal] = hoisted.spawnAcpForPluginMock.mock.calls[0] ?? [];
    expect(input).toEqual({ task: "Report back" });
    expect(principal).toMatchObject({
      pluginId: PLUGIN_ID,
      ownerKey: OWNER_KEY,
      completionRequester: requester,
    });
    expect(principal.completionRequester).toEqual(requester);
  });

  it("fails closed for detached and request-scoped calls without a live requester", async () => {
    const runtime = createRuntime();
    const detached = await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", completionDelivery: "current-requester" })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    expect(detached.detailCode).toBe("completionDelivery");
    expect(detached.message).toContain("requester-bound plugin hook invocation");
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", completionDelivery: "current-requester" }), {
        client: requestClient,
      }),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    // Authority captured by an earlier hook does not survive the end of that invocation.
    const spawnLater = await withPluginSubagentRequesterContext(
      requester,
      async () => () =>
        scoped(() => runtime.spawn({ task: "x", completionDelivery: "current-requester" })),
    );
    await expectAcpError(spawnLater(), "ACP_PLUGIN_INVALID_INPUT");
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("rejects caller-provided requester routes and unknown delivery modes", async () => {
    const runtime = createRuntime();
    const invalid = await expectAcpError(
      withPluginSubagentRequesterContext(requester, () =>
        scoped(() =>
          runtime.spawn({
            task: "x",
            completionDelivery: "session" as unknown as "current-requester",
          }),
        ),
      ),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    expect(invalid.detailCode).toBe("completionDelivery");
    for (const option of ["requesterSessionKey", "parentSessionKey", "spawnedBy"]) {
      const error = await expectAcpError(
        withPluginSubagentRequesterContext(requester, () =>
          scoped(() =>
            runtime.spawn({
              task: "x",
              completionDelivery: "current-requester",
              [option]: "agent:other:main",
            } as Parameters<PluginRuntime["acp"]["spawn"]>[0]),
          ),
        ),
        "ACP_PLUGIN_UNSUPPORTED_OPTION",
      );
      expect(error.detailCode).toBe(option);
    }
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("never replays one requester's run to another requester under the same key", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    hoisted.spawnAcpForPluginMock
      .mockResolvedValueOnce(acceptedSpawn({ runId: "run-a", expectsCompletionMessage: true }))
      .mockResolvedValueOnce(acceptedSpawn({ runId: "run-b", expectsCompletionMessage: true }));
    const spawn = () =>
      scoped(() =>
        runtime.spawn({
          task: "same",
          idempotencyKey: "k-req",
          completionDelivery: "current-requester",
        }),
      );
    const first = await withPluginSubagentRequesterContext(requester, spawn);
    const replay = await withPluginSubagentRequesterContext(requester, spawn);
    const other = await withPluginSubagentRequesterContext(
      { sessionKey: "agent:main:telegram:dm:9", origin: { channel: "telegram", to: "telegram:9" } },
      spawn,
    );
    expect(first.runId).toBe("run-a");
    expect(replay).toEqual({ ...first, replayed: true });
    expect(other.runId).toBe("run-b");
    expect(other.replayed).toBeUndefined();
    expect(hoisted.spawnAcpForPluginMock).toHaveBeenCalledTimes(2);
  });

  it("keeps separator-containing host-captured routes distinct and ignores public route overrides", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    let launched = 0;
    hoisted.spawnAcpForPluginMock.mockImplementation(async () =>
      acceptedSpawn({ runId: `run-${++launched}`, expectsCompletionMessage: true }),
    );
    const origins = [
      { channel: "slack", to: "channel:A|acct", threadId: "thread" },
      { channel: "slack", to: "channel:A", accountId: "acct", threadId: "|thread" },
    ] as const;
    const spawnFrom = (origin: (typeof origins)[number]) => {
      const captured = createPluginSubagentRequesterContext({
        sessionKey: "agent:main:main",
        origin,
      });
      if (!captured) {
        throw new Error("Expected a routable host capture");
      }
      return withPluginSubagentRequesterContext(captured, () =>
        scoped(() =>
          runtime.spawn({
            task: "A",
            idempotencyKey: "separator-route",
            completionDelivery: "current-requester",
            // Public payloads cannot name or replace the host-captured route.
            completionRequester: { sessionKey: "agent:foreign:main", origin: origins[0] },
            requesterRoute: origins[0],
          } as Parameters<PluginRuntime["acp"]["spawn"]>[0]),
        ),
      );
    };
    const first = await spawnFrom(origins[0]);
    const second = await spawnFrom(origins[1]);
    expect(second.runId).not.toBe(first.runId);
    expect(second.replayed).toBeUndefined();
    expect(await spawnFrom(origins[0])).toEqual({ ...first, replayed: true });
    expect(await spawnFrom(origins[1])).toEqual({ ...second, replayed: true });
    expect(launched).toBe(2);
    expect(hoisted.spawnAcpForPluginMock.mock.calls[1]?.[1].completionRequester).toEqual({
      sessionKey: "agent:main:main",
      origin: origins[1],
    });
    expect(hoisted.spawnAcpForPluginMock.mock.calls[1]?.[0]).not.toHaveProperty("requesterRoute");
  });

  it("keys replay on the full host-captured completion route, not the session alone", async () => {
    config.plugins = {};
    const runtime = createRuntime();
    let launched = 0;
    hoisted.spawnAcpForPluginMock.mockImplementation(async () =>
      acceptedSpawn({ runId: `run-${++launched}`, expectsCompletionMessage: true }),
    );
    const spawnFrom = (origin: {
      channel: string;
      to: string;
      accountId?: string;
      threadId?: string;
    }) =>
      withPluginSubagentRequesterContext({ sessionKey: "agent:main:main", origin }, () =>
        scoped(() =>
          runtime.spawn({
            task: "A",
            idempotencyKey: "route",
            completionDelivery: "current-requester",
          }),
        ),
      );
    const channelA = await spawnFrom({ channel: "slack", to: "channel:A" });
    const channelB = await spawnFrom({ channel: "slack", to: "channel:B" });
    const otherAccount = await spawnFrom({
      channel: "slack",
      to: "channel:A",
      accountId: "acct-2",
    });
    const thread = await spawnFrom({ channel: "slack", to: "channel:A", threadId: "171" });
    const runIds = [channelA, channelB, otherAccount, thread].map((result) => result.runId);
    expect(new Set(runIds).size).toBe(4);
    expect([channelA, channelB, otherAccount, thread].every((r) => r.replayed === undefined)).toBe(
      true,
    );
    // The same session captured on the same route replays; a plugin cannot steer the
    // route because requester fields are rejected as input (see the unsupported-option case).
    const replayA = await spawnFrom({ channel: "slack", to: "channel:A" });
    expect(replayA).toEqual({ ...channelA, replayed: true });
    const replayThread = await spawnFrom({ channel: "slack", to: "channel:A", threadId: "171" });
    expect(replayThread).toEqual({ ...thread, replayed: true });
    expect(launched).toBe(4);
  });
});

describe("plugin ACP spawn input", () => {
  it.each([
    ["mode", "session"],
    ["thread", true],
    ["streamTo", "parent"],
    ["resumeSessionId", "abc"],
    ["sandbox", "require"],
    ["expectsCompletionMessage", true],
    ["steer", "x"],
    ["setMode", "plan"],
  ])("rejects unsupported option %s", async (option, value) => {
    const runtime = createRuntime();
    const error = await expectAcpError(
      scoped(() =>
        runtime.spawn({ task: "x", [option]: value } as Parameters<
          PluginRuntime["acp"]["spawn"]
        >[0]),
      ),
      "ACP_PLUGIN_UNSUPPORTED_OPTION",
    );
    expect(error.detailCode).toBe(option);
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("validates task, cwd, timeout, cleanup, and attachments", async () => {
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "  " })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", cwd: "relative/dir" })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", runTimeoutSeconds: -1 })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    await expectAcpError(
      scoped(() => runtime.spawn({ task: "x", cleanup: "purge" as unknown as "keep" })),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    await expectAcpError(
      scoped(() =>
        runtime.spawn({
          task: "x",
          attachments: [{ mediaType: "image/png" } as { mediaType: string; data: string }],
        }),
      ),
      "ACP_PLUGIN_INVALID_INPUT",
    );
    expect(hoisted.spawnAcpForPluginMock).not.toHaveBeenCalled();
  });

  it("maps owner-side spawn failures to the plugin error taxonomy", async () => {
    const runtime = createRuntime();
    const cases: Array<[string, string]> = [
      ["acp_disabled", "ACP_PLUGIN_DISABLED"],
      ["agent_forbidden", "ACP_PLUGIN_AGENT_FORBIDDEN"],
      ["subagent_policy", "ACP_PLUGIN_ADMISSION_REJECTED"],
      ["cwd_resolution_failed", "ACP_PLUGIN_INVALID_INPUT"],
      ["dispatch_failed", "ACP_PLUGIN_SPAWN_FAILED"],
    ];
    for (const [errorCode, expected] of cases) {
      hoisted.spawnAcpForPluginMock.mockResolvedValueOnce({
        status: "forbidden",
        errorCode,
        error: `owner said ${errorCode}`,
      } as SpawnAcpForPluginResult);
      const error = await expectAcpError(
        scoped(() => runtime.spawn({ task: "x" })),
        expected,
      );
      expect(error.detailCode).toBe(errorCode);
      expect(error.message).toBe(`owner said ${errorCode}`);
    }
  });
});

registerPluginAcpIdempotencyTests({
  createRuntime,
  scoped,
  getConfig: () => config,
  spawnAcpForPluginMock: hoisted.spawnAcpForPluginMock,
  acceptedSpawn,
  expectAcpError,
  pluginId: PLUGIN_ID,
  otherPluginId: OTHER_PLUGIN_ID,
});

describe("plugin ACP run inspection", () => {
  beforeEach(() => {
    tasks.push(
      task({ taskId: "mine-active", runId: "run-mine-active", createdAt: 3_000 }),
      task({
        taskId: "mine-done",
        runId: "run-mine-done",
        status: "succeeded",
        createdAt: 2_000,
      }),
      task({
        taskId: "foreign",
        runId: "run-foreign",
        ownerKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        requesterSessionKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        childSessionKey: `agent:codex:acp:plugin:${OTHER_PLUGIN_ID}:x`,
      }),
      task({
        taskId: "agent-owned",
        runId: "run-agent",
        ownerKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        childSessionKey: "agent:codex:acp:s1",
      }),
    );
  });

  it("returns only the caller's runs from getRun and listRuns", async () => {
    const runtime = createRuntime();
    await expect(scoped(() => runtime.getRun({ runId: "run-mine-active" }))).resolves.toMatchObject(
      {
        id: "mine-active",
      },
    );
    await expect(scoped(() => runtime.getRun({ taskId: "mine-done" }))).resolves.toMatchObject({
      id: "mine-done",
    });
    await expect(scoped(() => runtime.getRun({ runId: "run-foreign" }))).resolves.toBeUndefined();
    await expect(scoped(() => runtime.getRun({ taskId: "agent-owned" }))).resolves.toBeUndefined();
    await expect(
      scoped(() => runtime.getRun({ runId: "run-foreign" }), { pluginId: OTHER_PLUGIN_ID }),
    ).resolves.toMatchObject({ id: "foreign" });

    const active = await scoped(() => runtime.listRuns());
    expect(active.map((run) => run.id)).toEqual(["mine-active"]);
    const all = await scoped(() => runtime.listRuns({ includeTerminal: true, limit: 1 }));
    expect(all.map((run) => run.id)).toEqual(["mine-active"]);
    const everything = await scoped(() => runtime.listRuns({ includeTerminal: true }));
    expect(everything.map((run) => run.id)).toEqual(["mine-active", "mine-done"]);
  });

  it("waits only for owned runs through the Gateway agent.wait owner", async () => {
    const dispatch = vi
      .spyOn(inProcessDispatch, "dispatchGatewayMethodInProcess")
      .mockResolvedValue({ status: "completed", runId: "run-mine-active" });
    const runtime = createRuntime();
    await expect(
      scoped(() => runtime.waitForRun({ runId: "run-mine-active", timeoutMs: 50 })),
    ).resolves.toEqual({ status: "ok", runId: "run-mine-active" });
    expect(dispatch).toHaveBeenCalledWith(
      "agent.wait",
      { runId: "run-mine-active", timeoutMs: 50 },
      expect.objectContaining({ resolveGatewayContext: expect.any(Function) }),
    );
    await expectAcpError(
      scoped(() => runtime.waitForRun({ runId: "run-foreign" })),
      "ACP_PLUGIN_RUN_NOT_FOUND",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("hides foreign and missing sessions identically in getSession", async () => {
    const mine = `agent:codex:acp:plugin:${PLUGIN_ID}:child-1`;
    const foreign = `agent:codex:acp:plugin:${OTHER_PLUGIN_ID}:child-2`;
    hoisted.loadSessionEntryMock.mockImplementation((scope: { sessionKey: string }) => {
      if (scope.sessionKey === mine) {
        return {
          sessionId: "s1",
          updatedAt: 5,
          createdAt: 4,
          label: `plugin:${PLUGIN_ID}`,
          pluginOwnerId: PLUGIN_ID,
        } as SessionEntry;
      }
      if (scope.sessionKey === foreign) {
        return { sessionId: "s2", updatedAt: 5, pluginOwnerId: OTHER_PLUGIN_ID } as SessionEntry;
      }
      return undefined;
    });
    hoisted.readAcpSessionMetaMock.mockReturnValue({
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "rt",
      mode: "oneshot",
      cwd: "/repo",
      state: "running",
      lastActivityAt: 6,
      identity: { acpxSessionId: "secret" },
      runtimeOptions: { model: "m" },
    });
    const runtime = createRuntime();
    const detail = await scoped(() => runtime.getSession({ sessionKey: mine }));
    expect(detail).toEqual({
      sessionKey: mine,
      agentId: "codex",
      backend: "acpx",
      mode: "oneshot",
      cwd: "/repo",
      state: "running",
      lastActivityAt: 6,
      label: `plugin:${PLUGIN_ID}`,
      createdAt: 4,
      updatedAt: 5,
    });
    await expect(
      scoped(() => runtime.getSession({ sessionKey: foreign })),
    ).resolves.toBeUndefined();
    await expect(
      scoped(() => runtime.getSession({ sessionKey: "agent:codex:acp:plugin:nobody:none" })),
    ).resolves.toBeUndefined();
    await expect(
      scoped(() => runtime.getSession({ sessionKey: "agent:main:main" })),
    ).resolves.toBeUndefined();
    expect(hoisted.readAcpSessionMetaMock).toHaveBeenCalledTimes(1);
  });
});

describe("plugin ACP cancellation", () => {
  const MINE = task({ taskId: "mine", runId: "run-mine" });
  const notFound = { found: false, cancelled: false, reason: "Task not found." };

  function ownedEntry(pluginOwnerId: string | undefined): SessionEntry {
    return { sessionId: "s-mine", updatedAt: 1, pluginOwnerId } as SessionEntry;
  }

  beforeEach(() => {
    tasks.push({ ...MINE });
    hoisted.loadSessionEntryMock.mockImplementation((scope: { sessionKey: string }) =>
      scope.sessionKey === MINE.childSessionKey ? ownedEntry(PLUGIN_ID) : undefined,
    );
  });

  it("rereads session ownership and the task binding, then cancels through the canonical task owner", async () => {
    hoisted.cancelDetachedTaskRunByIdMock.mockResolvedValue({
      found: true,
      cancelled: true,
      task: task({ taskId: "mine", runId: "run-mine", status: "cancelled" }),
    });
    const runtime = createRuntime();
    await expect(
      scoped(() => runtime.cancel({ runId: "run-mine", reason: "operator stop" })),
    ).resolves.toMatchObject({ found: true, cancelled: true, task: { id: "mine" } });
    expect(hoisted.loadSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: MINE.childSessionKey, agentId: "codex" }),
    );
    expect(hoisted.getTaskByIdMock).toHaveBeenCalledWith("mine");
    expect(hoisted.cancelDetachedTaskRunByIdMock).toHaveBeenCalledWith({
      cfg: config,
      taskId: "mine",
      reason: "operator stop",
    });
  });

  it.each([
    ["re-owned by another plugin", () => ownedEntry(OTHER_PLUGIN_ID)],
    ["released from plugin ownership", () => ownedEntry(undefined)],
    ["deleted", () => undefined],
  ])(
    "reports not found without cancelling when the child session is %s after the task lookup",
    async (_label, replacement) => {
      // The owner-scoped lookup still returns the task; only the final session reread sees
      // the replacement, which is the window the reread exists for.
      hoisted.listTasksForOwnerKeyMock.mockImplementation((ownerKey: string) => {
        hoisted.loadSessionEntryMock.mockImplementation(() => replacement());
        return tasks.filter((entry) => entry.ownerKey === ownerKey);
      });
      const runtime = createRuntime();
      await expect(scoped(() => runtime.cancel({ runId: "run-mine" }))).resolves.toEqual(notFound);
      expect(hoisted.loadSessionEntryMock).toHaveBeenCalledTimes(1);
      expect(hoisted.cancelDetachedTaskRunByIdMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["re-owned", { ownerKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID) }],
    ["rebound to another run", { runId: "run-mine-replacement" }],
    ["rebound to another child session", { childSessionKey: "agent:codex:acp:plugin:x:other" }],
    ["removed", undefined],
  ])(
    "reports not found without cancelling when the task row is %s after the lookup",
    async (_label, patch) => {
      hoisted.listTasksForOwnerKeyMock.mockImplementation((ownerKey: string) => {
        hoisted.getTaskByIdMock.mockImplementation(() =>
          patch ? { ...MINE, ...patch } : undefined,
        );
        return tasks.filter((entry) => entry.ownerKey === ownerKey);
      });
      const runtime = createRuntime();
      await expect(scoped(() => runtime.cancel({ runId: "run-mine" }))).resolves.toEqual(notFound);
      expect(hoisted.cancelDetachedTaskRunByIdMock).not.toHaveBeenCalled();
    },
  );

  it("reports foreign runs as not found without touching the task owner", async () => {
    tasks.push(
      task({
        taskId: "foreign",
        runId: "run-foreign",
        ownerKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        requesterSessionKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
      }),
    );
    const runtime = createRuntime();
    await expect(scoped(() => runtime.cancel({ runId: "run-foreign" }))).resolves.toEqual({
      found: false,
      cancelled: false,
      reason: "Task not found.",
    });
    expect(hoisted.cancelDetachedTaskRunByIdMock).not.toHaveBeenCalled();
  });
});

describe("plugin ACP observe", () => {
  const RUN_ID = "run-observe";

  beforeEach(() => {
    tasks.push(task({ taskId: "observe", runId: RUN_ID }));
  });

  it("filters streams, delivers in order, and unsubscribes on the terminal event", async () => {
    const runtime = createRuntime();
    const events: PluginAcpObserveEvent[] = [];
    await scoped(() => runtime.observe({ runId: RUN_ID }, (event) => events.push(event)));
    emitAgentEvent({ runId: RUN_ID, stream: "assistant", data: { text: "hidden" } });
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { phase: "runtime_event" } });
    emitAgentEvent({ runId: RUN_ID, stream: "tool", data: { name: "shell" } });
    emitAgentEvent({ runId: RUN_ID, stream: "lifecycle", data: { phase: "end", endedAt: 1 } });
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { phase: "late" } });
    expect(events.map((event) => [event.stream, event.data.phase ?? event.data.name])).toEqual([
      ["acp", "runtime_event"],
      ["tool", "shell"],
      ["lifecycle", "end"],
    ]);
    expect(events.every((event) => event.runId === RUN_ID && !event.truncated)).toBe(true);
  });

  it("marks the last event truncated at maxEvents and stops", async () => {
    const runtime = createRuntime();
    const events: PluginAcpObserveEvent[] = [];
    await scoped(() =>
      runtime.observe({ runId: RUN_ID, maxEvents: 2 }, (event) => events.push(event)),
    );
    for (let index = 0; index < 4; index += 1) {
      emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { index } });
    }
    expect(events.map((event) => event.data.index)).toEqual([0, 1]);
    expect(events[1]?.truncated).toBe(true);
  });

  it("unsubscribes on abort signal and on runtime shutdown", async () => {
    const runtime = createRuntime();
    const aborted: PluginAcpObserveEvent[] = [];
    const retained: PluginAcpObserveEvent[] = [];
    const abort = new AbortController();
    await scoped(() =>
      runtime.observe({ runId: RUN_ID, signal: abort.signal }, (event) => aborted.push(event)),
    );
    const unsubscribe = await scoped(() =>
      runtime.observe({ runId: RUN_ID }, (event) => retained.push(event)),
    );
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { n: 1 } });
    abort.abort();
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { n: 2 } });
    expect(aborted.map((event) => event.data.n)).toEqual([1]);
    expect(retained.map((event) => event.data.n)).toEqual([1, 2]);
    lifetime.abort();
    emitAgentEvent({ runId: RUN_ID, stream: "acp", data: { n: 3 } });
    expect(retained.map((event) => event.data.n)).toEqual([1, 2]);
    expect(() => unsubscribe()).not.toThrow();
  });

  it("rejects foreign runs and returns a no-op for terminal runs", async () => {
    tasks.push(
      task({ taskId: "done", runId: "run-done", status: "succeeded" }),
      task({
        taskId: "foreign",
        runId: "run-foreign",
        ownerKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
        requesterSessionKey: resolvePluginAcpOwnerKey(OTHER_PLUGIN_ID),
      }),
    );
    const runtime = createRuntime();
    await expectAcpError(
      scoped(() => runtime.observe({ runId: "run-foreign" }, () => {})),
      "ACP_PLUGIN_RUN_NOT_FOUND",
    );
    const seen: PluginAcpObserveEvent[] = [];
    const stop = await scoped(() =>
      runtime.observe({ runId: "run-done" }, (event) => seen.push(event)),
    );
    emitAgentEvent({ runId: "run-done", stream: "acp", data: {} });
    expect(seen).toEqual([]);
    stop();
  });
});
