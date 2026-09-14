import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const ROUTE_PATH = "/plugins/route-runner/final-effects";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin-auth subagent delegation final effects", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;

  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      const module = await import("./server-kernel.js");
      const create = module.createGatewayKernel;
      const capture = vi
        .spyOn(module, "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await create(...args);
          return kernel;
        });
      try {
        harness = await startGatewayServerHarness();
      } finally {
        capture.mockRestore();
      }
    },
    cleanup: async () => {
      await harness?.close();
    },
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function invokeRoute(params: {
    consented: boolean;
    declared?: boolean;
    pluginId?: string;
    roles?: NonNullable<OpenClawConfig["gateway"]>["roles"];
    revokeBeforeSessionCommit?: boolean;
    seedOrdinarySession?: boolean;
  }) {
    await prepareGatewayReplyRuntimeForTest();
    agentCommandMock.mockClear();
    const pluginId = params.pluginId ?? "route-runner";
    const runId = randomUUID();
    const existingSessionId = `existing-${randomUUID()}`;
    const sessionKey = `agent:main:subagent:${randomUUID()}`;
    const storePath = path.join(tempDirs.make("openclaw-plugin-final-effects-"), "sessions.json");
    let config: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
      ...(params.roles ? { gateway: { roles: params.roles } } : {}),
      plugins: {
        entries: {
          "route-runner": { subagent: { allowRun: params.consented } },
        },
      },
    };
    const context = kernel.gatewayRequestContext;
    const originalGetRuntimeConfig = context.getRuntimeConfig;
    context.getRuntimeConfig = () => config;
    const subagent = createGatewaySubagentRuntime(() => context);
    const runtime = createPluginRuntime({ subagent });
    runtime.config = { ...runtime.config, current: () => config };
    const registryBuilder = createRuntimeTestRegistry(runtime);
    const record = createPluginRecord({
      id: pluginId,
      source: `/plugins/${pluginId}/index.js`,
      origin: "global",
      enabled: true,
      configSchema: false,
      ...(params.declared === false
        ? {}
        : { contracts: { runtimeCapabilities: ["subagent.run" as const] } }),
    });
    const api = registryBuilder.createApi(record, { config });
    api.registerHttpRoute({
      path: ROUTE_PATH,
      auth: "plugin",
      handler: async (_req: IncomingMessage, res: ServerResponse) => {
        const result = await api.runtime.subagent.run({
          sessionKey,
          message: "registered route durable-effects proof",
          idempotencyKey: runId,
        });
        res.statusCode = 200;
        res.end(result.runId);
        return true;
      },
    });
    setActivePluginRegistry(registryBuilder.registry);
    const log = { warn: vi.fn() } as unknown as Parameters<
      typeof createGatewayPluginRequestHandler
    >[0]["log"];
    const handler = createGatewayPluginRequestHandler({
      registry: registryBuilder.registry,
      log,
      getGatewayRequestContext: () => context,
    });
    const response = makeMockHttpResponse();
    const originalPatch = sessionAccessor.patchSessionEntryTarget;
    let persistedScope: Parameters<typeof sessionAccessor.patchSessionEntryTarget>[0] | undefined;
    const patchSpy = vi
      .spyOn(sessionAccessor, "patchSessionEntryTarget")
      .mockImplementationOnce(async (...args) => {
        persistedScope = args[0];
        if (params.seedOrdinarySession) {
          await sessionAccessor.upsertSessionEntryCore(
            {
              agentId: persistedScope.agentId,
              sessionKey: persistedScope.target.canonicalKey,
              storePath: persistedScope.storePath,
            },
            { sessionId: existingSessionId, updatedAt: Date.now() },
          );
        }
        if (params.revokeBeforeSessionCommit) {
          config = {
            ...config,
            plugins: {
              entries: { "route-runner": { subagent: { allowRun: false } } },
            },
          };
        }
        return originalPatch(...args);
      });
    try {
      const handled = await handler(
        { url: ROUTE_PATH, method: "POST" } as IncomingMessage,
        response.res,
        undefined,
        { gatewayAuthSatisfied: false },
      );
      if (response.res.statusCode === 200) {
        await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledOnce());
      }
      return {
        agentCommandMock,
        handled,
        existingSessionId,
        response,
        runId,
        sessionKey,
        storePath,
        loadEntry: () =>
          persistedScope
            ? sessionAccessor.loadSessionEntry({
                agentId: persistedScope.agentId,
                sessionKey: persistedScope.target.canonicalKey,
                storePath: persistedScope.storePath,
              })
            : undefined,
      };
    } finally {
      patchSpy.mockRestore();
      context.getRuntimeConfig = originalGetRuntimeConfig;
    }
  }

  it("persists a plugin-owned session and starts the real run pipeline", async () => {
    const result = await invokeRoute({ consented: true });

    expect(result.handled).toBe(true);
    expect(result.response.res.statusCode).toBe(200);
    expect(result.response.end).toHaveBeenCalledWith(result.runId);
    expect(result.loadEntry()).toMatchObject({
      pluginOwnerId: "route-runner",
    });
    expect(result.loadEntry()?.sessionId).toEqual(expect.any(String));
    expect(result.agentCommandMock).toHaveBeenCalledOnce();
  });

  it("rejects revoked consent in the real SQLite commit guard without durable effects", async () => {
    const result = await invokeRoute({
      consented: true,
      revokeBeforeSessionCommit: true,
    });

    expect(result.handled).toBe(true);
    expect(result.response.res.statusCode).toBe(500);
    expect(result.loadEntry()).toBeUndefined();
    expect(result.agentCommandMock).not.toHaveBeenCalled();
  });

  it("keeps a plugin-auth route system-owned on role-enabled Gateways", async () => {
    const result = await invokeRoute({
      consented: true,
      roles: {
        default: "restricted",
        definitions: {
          restricted: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    });

    expect(result.response.res.statusCode).toBe(200);
    expect(result.loadEntry()).toMatchObject({
      pluginOwnerId: "route-runner",
    });
    expect(result.loadEntry()?.sessionId).toEqual(expect.any(String));
  });

  it("may continue an ordinary unlocked session without taking plugin ownership", async () => {
    const result = await invokeRoute({ consented: true, seedOrdinarySession: true });

    expect(result.response.res.statusCode).toBe(200);
    expect(result.loadEntry()).toMatchObject({ sessionId: result.existingSessionId });
    expect(result.loadEntry()?.pluginOwnerId).toBeUndefined();
    expect(result.agentCommandMock).toHaveBeenCalledOnce();
  });
});
