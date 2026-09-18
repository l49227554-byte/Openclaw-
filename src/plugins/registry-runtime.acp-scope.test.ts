// Verifies the per-plugin registry proxy binds every api.runtime.acp method to the host plugin id.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

describe("plugin registry api.runtime.acp scope", () => {
  it("wraps every method in the host plugin scope and ignores caller-supplied identity", async () => {
    const seen: Array<{
      method: string;
      scope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
    }> = [];
    const record = (method: string) => {
      seen.push({ method, scope: getPluginRuntimeGatewayRequestScope() });
    };
    const acp: PluginRuntime["acp"] = {
      isAvailable: vi.fn(async () => {
        record("isAvailable");
        return { ok: true as const, mode: "request" as const };
      }),
      spawn: vi.fn(async () => {
        record("spawn");
        return {
          runId: "run-1",
          sessionKey: "agent:codex:acp:plugin:alpha:x",
          agentId: "codex",
          runTimeoutSeconds: 1,
        };
      }),
      getRun: vi.fn(async () => {
        record("getRun");
        return undefined;
      }),
      listRuns: vi.fn(async () => {
        record("listRuns");
        return [];
      }),
      getSession: vi.fn(async () => {
        record("getSession");
        return undefined;
      }),
      waitForRun: vi.fn(async () => {
        record("waitForRun");
        return { status: "ok" as const };
      }),
      cancel: vi.fn(async () => {
        record("cancel");
        return { found: false, cancelled: false };
      }),
      observe: vi.fn(async () => {
        record("observe");
        return () => {};
      }),
    };
    const cfg: OpenClawConfig = {};
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: createPluginRuntime({ acp }),
      activateGlobalSideEffects: false,
    });
    const createApi = (id: string) =>
      registry.createApi(
        createPluginRecord({
          id,
          source: `/plugins/${id}/index.js`,
          origin: "bundled",
          enabled: true,
          configSchema: false,
        }),
        { config: cfg },
      );
    const alpha = createApi("alpha");
    const beta = createApi("beta");

    await alpha.runtime.acp.isAvailable();
    await alpha.runtime.acp.spawn({ task: "x", pluginId: "beta" } as never);
    await alpha.runtime.acp.getRun({ runId: "run-1" });
    await alpha.runtime.acp.listRuns();
    await alpha.runtime.acp.getSession({ sessionKey: "agent:codex:acp:plugin:alpha:x" });
    await alpha.runtime.acp.waitForRun({ runId: "run-1" });
    await alpha.runtime.acp.cancel({ runId: "run-1" });
    await alpha.runtime.acp.observe({ runId: "run-1" }, () => {});
    await beta.runtime.acp.listRuns();

    expect(seen.map((entry) => entry.method)).toEqual([
      "isAvailable",
      "spawn",
      "getRun",
      "listRuns",
      "getSession",
      "waitForRun",
      "cancel",
      "observe",
      "listRuns",
    ]);
    for (const entry of seen.slice(0, 8)) {
      expect(entry.scope?.pluginId, entry.method).toBe("alpha");
      expect(entry.scope?.pluginOrigin, entry.method).toBe("bundled");
    }
    expect(seen.at(-1)?.scope?.pluginId).toBe("beta");
    // The host scope is the only identity the Gateway runtime reads; caller input is passed
    // through untouched so the runtime's own validation can reject it.
    expect(acp.spawn).toHaveBeenCalledWith({ task: "x", pluginId: "beta" });
    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  });
});
