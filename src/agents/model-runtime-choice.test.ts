import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { setPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
}));

const cfg: OpenClawConfig = { plugins: { enabled: false } };
const request = {
  cfg,
  agentId: "main",
  provider: "fixture",
  model: "model",
  runtimeId: "openclaw",
};

function publishOwner(params: {
  config: OpenClawConfig;
  entries: readonly ModelCatalogEntry[];
  authStore: Parameters<typeof setPreparedModelRuntimeAuthStore>[1];
  isCurrent?: () => boolean;
  authModes?: PreparedModelRuntimeSnapshot["authModes"];
  metadataSnapshot?: PreparedModelRuntimeSnapshot["metadataSnapshot"];
  pluginRegistry?: PreparedModelRuntimeSnapshot["pluginRegistry"];
}) {
  const owner: PreparedModelRuntimeSnapshot = {
    config: params.config,
    observationConfig: params.config,
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/runtime-choice" },
    agentId: "main",
    agentDir: "/tmp/runtime-choice/agent",
    workspaceDir: "/tmp/runtime-choice",
    activeProjectKeys: [],
    authModes: params.authModes ?? {},
    metadataSnapshot: params.metadataSnapshot ?? createPluginMetadataSnapshotFixture(),
    isCurrent: params.isCurrent ?? (() => true),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [...params.entries], routeVariants: [...params.entries] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    // An absent registry is not an empty one: harness lookups take a different path.
    ...(params.pluginRegistry ? { pluginRegistry: params.pluginRegistry } : {}),
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
  };
  setPreparedModelRuntimeAuthStore(owner, params.authStore);
  published.owner = owner;
}

function publish(isCurrent = () => true, config = cfg) {
  publishOwner({
    config,
    isCurrent,
    entries: [{ provider: "fixture", id: "model", name: "Model" }],
    authStore: {
      version: 1,
      profiles: {
        "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
      },
    },
  });
}

describe("published runtime choice", () => {
  beforeEach(() => {
    published.owner = undefined;
  });

  it("refuses an unpublished or unresolved model", async () => {
    expect(await preparePublishedModelRuntimeChoice(request)).toMatchObject({
      kind: "unavailable",
    });
    publish();
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, model: "unobserved" }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("validates an off-catalog model through its configured route", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    let current = true;
    publish(() => current, config);
    const choice = await preparePublishedModelRuntimeChoice({
      ...request,
      cfg: config,
      model: "off-catalog",
    });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the configured off-catalog route to be selectable");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });

  it("does not grant an incompatible runtime to an off-catalog model", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    publish(() => true, config);
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        cfg: config,
        model: "off-catalog",
        runtimeId: "codex",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("rechecks the same generation at the session commit boundary", async () => {
    let current = true;
    publish(() => current);
    const choice = await preparePublishedModelRuntimeChoice(request);
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected a supported runtime");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });
});

describe("colliding catalog display keys", () => {
  // One provider publishes two literal rows whose display key collapses to the
  // same string: `modelKey("vendor", "gpt-5.4") === modelKey("vendor", "vendor/gpt-5.4")`.
  // Each row carries its own native runtime, and each harness serves only its row.
  const plainRow = {
    provider: "vendor",
    id: "gpt-5.4",
    name: "Plain",
    nativeRuntime: "vendor-plain",
  };
  const namespacedRow = {
    provider: "vendor",
    id: "vendor/gpt-5.4",
    name: "Namespaced",
    nativeRuntime: "vendor-cli",
  };
  const harnessConfig: OpenClawConfig = {
    plugins: { entries: { "vendor-cli": { enabled: true }, "vendor-plain": { enabled: true } } },
  };

  function publishRows(entries: readonly (typeof plainRow)[]) {
    const pluginRegistry = createEmptyPluginRegistry();
    for (const row of [plainRow, namespacedRow]) {
      pluginRegistry.agentHarnesses.push({
        pluginId: row.nativeRuntime,
        source: "fixture",
        harness: {
          id: row.nativeRuntime,
          label: row.name,
          authBootstrap: "harness",
          supports: (context) => ({ supported: context.modelId === row.id }),
          readModelCatalogReadiness: () => ({ accountType: "oauth", authMode: "oauth" }),
          async runAttempt() {
            throw new Error("Catalog reads must not execute a model");
          },
        },
      });
    }
    publishOwner({
      config: harnessConfig,
      entries,
      pluginRegistry,
      authModes: {
        "vendor-cli": { source: "native", mode: "oauth" },
        "vendor-plain": { source: "native", mode: "oauth" },
      },
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "vendor-cli", providers: ["vendor"], syntheticAuthRefs: ["vendor-cli"] },
          { id: "vendor-plain", providers: ["vendor"], syntheticAuthRefs: ["vendor-plain"] },
        ],
      }),
      authStore: { version: 1, profiles: {} },
    });
  }

  const select = (model: string, runtimeId: string) =>
    preparePublishedModelRuntimeChoice({
      cfg: harnessConfig,
      agentId: "main",
      provider: "vendor",
      model,
      runtimeId,
    });

  const orders = [
    ["plain row first", [plainRow, namespacedRow]],
    ["namespaced row first", [namespacedRow, plainRow]],
  ] as const;

  it.each(orders)("keeps each row's own native runtime available (%s)", async (_label, entries) => {
    publishRows(entries);
    for (const row of [plainRow, namespacedRow]) {
      const choice = await select(row.id, row.nativeRuntime);
      expect(choice.kind).toBe("ready");
      if (choice.kind !== "ready") {
        throw new Error(`Expected ${row.nativeRuntime} to serve ${row.id}`);
      }
      expect(choice.validate()).toBeUndefined();
    }
  });

  it.each(orders)(
    "refuses a runtime only the sibling row carries (%s)",
    async (_label, entries) => {
      publishRows(entries);
      expect(await select(plainRow.id, namespacedRow.nativeRuntime)).toMatchObject({
        kind: "unavailable",
      });
      expect(await select(namespacedRow.id, plainRow.nativeRuntime)).toMatchObject({
        kind: "unavailable",
      });
    },
  );
});
