import { expect, it } from "vitest";
import type { loadOpenClawPlugins } from "./loader.js";
import { useNoBundledPlugins, writePlugin } from "./loader.test-fixtures.js";
import {
  expectNoDiagnosticContaining,
  expectRegistryErrorDiagnostic,
  loadRegistryFromAllowedPlugins,
  loadRegistryFromSinglePlugin,
} from "./loader.test-harness.js";

// Register inside the activation suite to retain its loader mocks and cleanup hooks.
export function registerServiceIdentityTests() {
  it.each([
    {
      label: "background service",
      ownerA: "normalized-service-owner-a",
      ownerB: "normalized-service-owner-b",
      method: "registerService",
      serviceId: "shared-service",
      duplicateMessage: "service already registered: shared-service (normalized-service-owner-a)",
      selectRegistrations: (registry: ReturnType<typeof loadOpenClawPlugins>) => registry.services,
    },
    {
      label: "gateway discovery service",
      ownerA: "normalized-discovery-owner-a",
      ownerB: "normalized-discovery-owner-b",
      method: "registerGatewayDiscoveryService",
      serviceId: "shared-discovery",
      duplicateMessage:
        "gateway discovery service already registered: shared-discovery (normalized-discovery-owner-a)",
      selectRegistrations: (registry: ReturnType<typeof loadOpenClawPlugins>) =>
        registry.gatewayDiscoveryServices,
    },
  ])("normalizes $label ids before checking plugin ownership", (scenario) => {
    useNoBundledPlugins();
    const first = writePlugin({
      id: scenario.ownerA,
      filename: `${scenario.ownerA}.cjs`,
      body: `class OwnedService {
    #owner = "first-owner";
    constructor() { this.id = "  ${scenario.serviceId}  "; }
    describe() { return this.id + ":" + this.#owner; }
    start() { this.startedId = this.id; }
    advertise() { this.startedId = this.id; return { stop() {} }; }
  }
  module.exports = { id: "${scenario.ownerA}", register(api) {
    api.${scenario.method}(new OwnedService());
  } };`,
    });
    const second = writePlugin({
      id: scenario.ownerB,
      filename: `${scenario.ownerB}.cjs`,
      body: `module.exports = { id: "${scenario.ownerB}", register(api) {
    api.${scenario.method}({ id: "${scenario.serviceId}", start() {}, advertise() {} });
  } };`,
    });

    const registry = loadRegistryFromAllowedPlugins([first, second]);
    const registrations = scenario.selectRegistrations(registry);

    expect(registrations).toHaveLength(1);
    const registered = registrations[0]!.service as (typeof registrations)[number]["service"] & {
      id: string;
      describe: () => string;
      start?: (ctx: never) => void;
      advertise?: (ctx: never) => void;
      startedId?: string;
    };
    expect(registered.id).toBe(scenario.serviceId);
    expect(registered.describe()).toBe(`${scenario.serviceId}:first-owner`);
    if (scenario.method === "registerService") {
      registered.start?.({} as never);
    } else {
      registered.advertise?.({} as never);
    }
    expect(registered.startedId).toBe(scenario.serviceId);
    expectRegistryErrorDiagnostic({
      registry,
      pluginId: scenario.ownerB,
      message: scenario.duplicateMessage,
    });
  });

  it("rejects frozen service ids that require normalization without throwing", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "frozen-malformed-service-owner",
      body: `module.exports = { id: "frozen-malformed-service-owner", register(api) {
    api.registerService(Object.freeze({ id: "  frozen-service  ", start() {} }));
    api.registerGatewayDiscoveryService(
      Object.freeze({ id: "  frozen-discovery  ", advertise() {} }),
    );
  } };`,
    });
    const registry = loadRegistryFromSinglePlugin({ plugin });

    expect(registry.plugins[0]?.status).toBe("loaded");
    expect(registry.services).toEqual([]);
    expect(registry.gatewayDiscoveryServices).toEqual([]);
    expectRegistryErrorDiagnostic({
      registry,
      pluginId: "frozen-malformed-service-owner",
      message: "service registration id cannot be normalized",
    });
    expectRegistryErrorDiagnostic({
      registry,
      pluginId: "frozen-malformed-service-owner",
      message: "gateway discovery service registration id cannot be normalized",
    });
  });

  it("preserves frozen services that already have canonical ids", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "frozen-canonical-service-owner",
      body: `module.exports = { id: "frozen-canonical-service-owner", register(api) {
    api.registerService(Object.freeze({ id: "frozen-service", start() {} }));
    api.registerGatewayDiscoveryService(
      Object.freeze({ id: "frozen-discovery", advertise() {} }),
    );
  } };`,
    });
    const registry = loadRegistryFromSinglePlugin({ plugin });

    expect(registry.services[0]?.service.id).toBe("frozen-service");
    expect(registry.gatewayDiscoveryServices[0]?.service.id).toBe("frozen-discovery");
    expect(registry.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
  });

  it.each([
    { mode: "ignored", assignment: "", throwAfterAssignment: false },
    { mode: "throwing-getter", assignment: "", throwAfterAssignment: false },
    {
      mode: "throwing-setter",
      assignment: 'throw new Error("private accessor failure must stay redacted");',
      throwAfterAssignment: false,
    },
    {
      mode: "transformed",
      assignment: 'current = value + "-changed";',
      throwAfterAssignment: false,
    },
    { mode: "throwing-readback", assignment: "", throwAfterAssignment: true },
  ])("rejects $mode service-id accessors without leaking setter/getter errors", (scenario) => {
    useNoBundledPlugins();
    const pluginId = `${scenario.mode}-service-id-owner`;
    const plugin = writePlugin({
      id: pluginId,
      body: `function serviceWithAccessor(id) {
    let current = "  " + id + "  ";
    let assigned = false;
    return {
      get id() {
        if (${String(scenario.mode === "throwing-getter")} || (${String(scenario.throwAfterAssignment)} && assigned)) {
          throw new Error("private accessor failure must stay redacted");
        }
        return current;
      },
      set id(value) {
        assigned = true;
        ${scenario.assignment}
      },
      start() {},
      advertise() {},
    };
  }
  module.exports = { id: "${pluginId}", register(api) {
    api.registerService(serviceWithAccessor("ignored-service"));
    api.registerGatewayDiscoveryService(serviceWithAccessor("ignored-discovery"));
  } };`,
    });
    const registry = loadRegistryFromSinglePlugin({ plugin });

    expect(registry.plugins[0]?.status).toBe("loaded");
    expect(registry.services).toEqual([]);
    expect(registry.gatewayDiscoveryServices).toEqual([]);
    expectRegistryErrorDiagnostic({
      registry,
      pluginId,
      message: "service registration id cannot be normalized",
    });
    expectRegistryErrorDiagnostic({
      registry,
      pluginId,
      message: "gateway discovery service registration id cannot be normalized",
    });
    expect(JSON.stringify(registry.diagnostics)).not.toContain("private accessor failure");
  });

  it.each([
    { label: "canonical", padding: "", registered: true },
    { label: "padded", padding: "  ", registered: false },
  ])("reads $label service-id getters only before guarded normalization", (scenario) => {
    useNoBundledPlugins();
    const pluginId = `${scenario.label}-one-read-service-owner`;
    const plugin = writePlugin({
      id: pluginId,
      body: `function serviceWithOneReadableId(id) {
    let reads = 0;
    return {
      get id() {
        if (reads++ > 0) {
          throw new Error("private second getter read must stay redacted");
        }
        return "${scenario.padding}" + id + "${scenario.padding}";
      },
      set id(_value) {},
      start() {},
      advertise() {},
    };
  }
  module.exports = { id: "${pluginId}", register(api) {
    api.registerService(serviceWithOneReadableId("single-read-service"));
    api.registerGatewayDiscoveryService(serviceWithOneReadableId("single-read-discovery"));
  } };`,
    });
    const registry = loadRegistryFromSinglePlugin({ plugin });

    expect(registry.plugins[0]?.status).toBe("loaded");
    if (scenario.registered) {
      expect(registry.plugins[0]?.services).toEqual(["single-read-service"]);
      expect(registry.plugins[0]?.gatewayDiscoveryServiceIds).toEqual(["single-read-discovery"]);
      expect(registry.services).toHaveLength(1);
      expect(registry.gatewayDiscoveryServices).toHaveLength(1);
      expect(registry.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
      return;
    }

    expect(registry.services).toEqual([]);
    expect(registry.gatewayDiscoveryServices).toEqual([]);
    expectRegistryErrorDiagnostic({
      registry,
      pluginId,
      message: "service registration id cannot be normalized",
    });
    expectRegistryErrorDiagnostic({
      registry,
      pluginId,
      message: "gateway discovery service registration id cannot be normalized",
    });
    expect(JSON.stringify(registry.diagnostics)).not.toContain("private second getter read");
  });

  it("allows the same plugin to register the same service id twice", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "service-owner-self",
      filename: "service-owner-self.cjs",
      body: `module.exports = { id: "service-owner-self", register(api) {
    api.registerService({ id: "  shared-service  ", start() {} });
    api.registerService({ id: "shared-service", start() {} });
  } };`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["service-owner-self"],
      },
    });

    expect(registry.services).toHaveLength(1);
    expect(registry.services[0]?.service.id).toBe("shared-service");
    expectNoDiagnosticContaining({
      registry,
      message: "service already registered: shared-service",
    });
  });

  it("allows the same plugin to reregister a normalized gateway discovery id", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "discovery-owner-self",
      body: `module.exports = { id: "discovery-owner-self", register(api) {
    api.registerGatewayDiscoveryService({ id: "  shared-discovery  ", advertise() {} });
    api.registerGatewayDiscoveryService({ id: "shared-discovery", advertise() {} });
  } };`,
    });
    const registry = loadRegistryFromSinglePlugin({ plugin });

    expect(registry.gatewayDiscoveryServices).toHaveLength(1);
    expect(registry.gatewayDiscoveryServices[0]?.service.id).toBe("shared-discovery");
    expect(registry.plugins[0]?.gatewayDiscoveryServiceIds).toEqual(["shared-discovery"]);
    expect(registry.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
  });

  it("tracks regular services and gateway discovery services separately", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "split-service-owner",
      filename: "split-service-owner.cjs",
      registration: `api.registerService({ id: "shared-service", start() {} });
      api.registerGatewayDiscoveryService({ id: "shared-service", advertise() {} });`,
    });

    const registry = loadRegistryFromSinglePlugin({
      plugin,
      pluginConfig: {
        allow: ["split-service-owner"],
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "split-service-owner");
    expect(record?.services).toEqual(["shared-service"]);
    expect(record?.gatewayDiscoveryServiceIds).toEqual(["shared-service"]);
    expect(registry.services).toHaveLength(1);
    expect(registry.gatewayDiscoveryServices).toHaveLength(1);
    expect(registry.diagnostics).toStrictEqual([]);
  });
}
