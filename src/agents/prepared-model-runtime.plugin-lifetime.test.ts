// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-plugin-lifetime" });
  await resetPreparedModelRuntimeHarness(state);
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

it("retains a successor's registry while the previous catalog releases its last borrow", async () => {
  mocks.configuredAgentIds = ["default"];
  const registry = createEmptyPluginRegistry();
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  const catalogEntered = createDeferred();
  const finishCatalog = createDeferred();
  mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
    catalogEntered.resolve();
    await finishCatalog.promise;
    return { entries: [], routeVariants: [] };
  });
  const config = {};
  const options = {
    gatewayLifecycle: true,
    catalogMode: "static" as const,
    allowGatewaySubagentBinding: true,
  };
  const input = { config, agentId: "default", agentDir: state.agentDir("default") };
  await refreshPreparedModelRuntimeSnapshots(config, options);
  await catalogEntered.promise;
  const previous = getPreparedModelRuntimeSnapshot(input)!;
  expect(previous.pluginRegistry).toBe(registry);
  // Join the already-admitted background catalog so its terminal release is observable.
  const catalog = previous.loadFullModelCatalog!({ changedOnly: true });
  void catalog.catch(() => {});
  const successorEntered = createDeferred();
  const finishSuccessor = createDeferred();
  let successorRegistry: ReturnType<typeof getPluginRuntimeGenerationRegistry>;
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    successorRegistry = getPluginRuntimeGenerationRegistry();
    successorEntered.resolve();
    await finishSuccessor.promise;
    return { entries: [] };
  });
  const replacement = refreshPreparedModelRuntimeSnapshots(config, options);
  void replacement.catch(() => {});
  try {
    await Promise.race([
      successorEntered.promise,
      replacement.then(() => {
        throw new Error("Replacement completed before its static catalog dependency");
      }),
    ]);
    expect(successorRegistry!).toBe(registry);
    expect(previous.isCurrent()).toBe(false);
    finishCatalog.resolve();
    await expect(catalog).rejects.toThrow("superseded");
    finishSuccessor.resolve();
    await replacement;

    const successor = getPreparedModelRuntimeSnapshot(input)!;
    expect(successor).not.toBe(previous);
    expect(successor.pluginRegistry).toBe(registry);
    expect(successor.isCurrent()).toBe(true);
    expect(isPluginRegistryRetired(registry)).toBe(false);
    await successor.loadFullModelCatalog!({ changedOnly: true });
    await closePreparedModelRuntimeSnapshots();
    expect(isPluginRegistryRetired(registry)).toBe(true);
  } finally {
    finishCatalog.resolve();
    finishSuccessor.resolve();
    await Promise.allSettled([catalog, replacement]);
  }
});
