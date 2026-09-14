import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewaySubagentRuntime } from "./server-plugin-subagent-runtime.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const ROUTE_PATH = "/plugins/route-runner/run";

type Scenario = {
  consented: boolean;
  declared: boolean;
  pluginId?: string;
  revokeBeforeCommit?: boolean;
};

describe("plugin-auth registered route subagent delegation", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function runScenario(scenario: Scenario) {
    return await withTempHome(async () => {
      const pluginId = scenario.pluginId ?? "route-runner";
      let config: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "route-runner": { subagent: { allowRun: scenario.consented } },
          },
        },
      };
      const finalEffects: string[] = [];
      const facadeScopes: string[][] = [];
      const dispatch = vi.fn(
        async (_params: unknown, options: { assertAdmissionCurrent?: () => void } | undefined) => {
          if (scenario.revokeBeforeCommit) {
            config = {
              ...config,
              plugins: {
                entries: { "route-runner": { subagent: { allowRun: false } } },
              },
            };
          }
          options?.assertAdmissionCurrent?.();
          finalEffects.push("session-created", "run-started");
          return { runId: "registered-route-run", sessionKey: "agent:main:route-proof" };
        },
      );
      const context = {
        getRuntimeConfig: () => config,
        createAgentTurnFacade: async (params: { client: { connect: { scopes?: string[] } } }) => {
          facadeScopes.push([...(params.client.connect.scopes ?? [])]);
          return { dispatch, wait: vi.fn() };
        },
      } as unknown as GatewayRequestContext;
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
        ...(scenario.declared
          ? { contracts: { runtimeCapabilities: ["subagent.run" as const] } }
          : {}),
      });
      const api = registryBuilder.createApi(record, { config });
      api.registerHttpRoute({
        path: ROUTE_PATH,
        auth: "plugin",
        handler: async (_req: IncomingMessage, res: ServerResponse) => {
          const result = await api.runtime.subagent.run({
            sessionKey: "agent:main:route-proof",
            message: "registered route proof",
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
      const handled = await handler(
        { url: ROUTE_PATH, method: "POST" } as IncomingMessage,
        response.res,
        undefined,
        { gatewayAuthSatisfied: false },
      );
      return { dispatch, facadeScopes, finalEffects, handled, log, response };
    });
  }

  it("launches through the registered plugin-auth route only with declaration and consent", async () => {
    const result = await runScenario({ declared: true, consented: true });

    expect(result.handled).toBe(true);
    expect(result.response.res.statusCode).toBe(200);
    expect(result.response.end).toHaveBeenCalledWith("registered-route-run");
    expect(result.dispatch).toHaveBeenCalledOnce();
    expect(result.facadeScopes).toEqual([["operator.write"]]);
    expect(result.finalEffects).toEqual(["session-created", "run-started"]);
  });

  it.each([
    { declared: true, consented: false, pluginId: undefined, label: "missing consent" },
    {
      declared: true,
      consented: true,
      pluginId: "other-route-runner",
      label: "another plugin",
    },
  ])("rejects $label before session or run effects", async ({ declared, consented, pluginId }) => {
    const result = await runScenario({ declared, consented, pluginId });

    expect(result.handled).toBe(true);
    expect(result.response.res.statusCode).toBe(500);
    expect(result.dispatch).not.toHaveBeenCalled();
    expect(result.finalEffects).toEqual([]);
  });

  it("rejects consent revoked at final admission before session or run effects", async () => {
    const result = await runScenario({
      declared: true,
      consented: true,
      revokeBeforeCommit: true,
    });

    expect(result.handled).toBe(true);
    expect(result.response.res.statusCode).toBe(500);
    expect(result.dispatch).toHaveBeenCalledOnce();
    expect(result.finalEffects).toEqual([]);
  });
});
