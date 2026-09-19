import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { getActiveMemoryEscalationProvider } from "./active-memory-escalation-provider.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { ActiveMemoryEscalationProvider } from "./registry-contribution-types.js";
import { createTestPluginRegistry as createTestRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function createRecord(id: string) {
  return createPluginRecord({
    id,
    source: `/plugins/${id}/index.ts`,
    origin: "global",
    enabled: true,
    configSchema: false,
  });
}

function provider(id: string, decision: "recall" | "skip" = "recall") {
  return {
    id,
    decide: vi.fn(async () => decision),
  } satisfies ActiveMemoryEscalationProvider;
}

function registerProvider(
  builder: ReturnType<typeof createTestRegistry>,
  pluginId: string,
  value: ActiveMemoryEscalationProvider,
  initialize?: () => void,
) {
  const record = createRecord(pluginId);
  const api = builder.createApi(record, { config: {} });
  const instance = expectDefined(getPluginInstance(record), "escalation provider instance");
  onTestFinished(async () => {
    await instance.dispose();
  });
  runPluginRegisterSyncInRegistry(
    (registeredApi) => {
      initialize?.();
      registeredApi.registerActiveMemoryEscalationProvider(value);
    },
    api,
    builder.registry,
    pluginId,
  );
  builder.registry.plugins.push(record);
  return instance;
}

describe("active memory escalation provider registry", () => {
  it("resolves the provider from the active plugin generation and revokes stale views", async () => {
    const pluginRegistry = createTestRegistry();
    const value = provider("local-intent");
    const owner = registerProvider(pluginRegistry, "intent-plugin", value);
    setActivePluginRegistry(pluginRegistry.registry);

    const resolved = expectDefined(
      getActiveMemoryEscalationProvider("local-intent"),
      "registered escalation provider",
    );
    await expect(
      resolved.decide({
        message: "What did we decide?",
        searchQuery: "What did we decide?",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("recall");

    await owner.dispose();
    expect(() =>
      resolved.decide({
        message: "What did we decide?",
        searchQuery: "What did we decide?",
        signal: new AbortController().signal,
      }),
    ).toThrow(/reloaded|disabled|retiring/);
  });

  it("rejects duplicate ids owned by a different plugin", () => {
    const pluginRegistry = createTestRegistry();
    const first = provider("shared", "recall");
    const second = provider("shared", "skip");
    registerProvider(pluginRegistry, "first-owner", first);

    registerProvider(pluginRegistry, "second-owner", second);
    expect(
      pluginRegistry.registry.activeMemoryEscalationProviders.get("shared")?.provider,
    ).not.toBe(second);
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "second-owner",
        message:
          "active memory escalation provider already registered: shared (owner: first-owner)",
      }),
    );
  });

  it.each(["another registry", "rejected duplicate"])(
    "keeps the selected provider owner when a shared descriptor is adopted by %s",
    async (registration) => {
      const active = createTestRegistry();
      const store = createPluginRuntimeStore<string>("escalation runtime missing");
      const value: ActiveMemoryEscalationProvider = {
        id: "shared",
        decide() {
          expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(active.registry);
          return store.getRuntime() === "first runtime" ? "recall" : "skip";
        },
      };
      registerProvider(active, "first-owner", value, () => store.setRuntime("first runtime"));
      setActivePluginRegistry(active.registry);
      const other = registration === "another registry" ? createTestRegistry() : active;
      const otherOwner = registerProvider(other, "second-owner", value, () =>
        store.setRuntime("second runtime"),
      );

      expect(
        await getActiveMemoryEscalationProvider("shared")?.decide({
          message: "Continue",
          searchQuery: "Continue",
          signal: new AbortController().signal,
        }),
      ).toBe("recall");
      await otherOwner.dispose();
      expect(
        await getActiveMemoryEscalationProvider("shared")?.decide({
          message: "Continue",
          searchQuery: "Continue",
          signal: new AbortController().signal,
        }),
      ).toBe("recall");
    },
  );

  it("rejects malformed providers", () => {
    const pluginRegistry = createTestRegistry();
    registerProvider(pluginRegistry, "missing-id", {
      id: "",
      decide: () => "recall",
    });
    registerProvider(pluginRegistry, "missing-decide", {
      id: "broken",
    } as ActiveMemoryEscalationProvider);

    expect(pluginRegistry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("registration missing id") }),
        expect.objectContaining({
          message: 'active memory escalation provider "broken" registration missing decide',
        }),
      ]),
    );
  });
});
