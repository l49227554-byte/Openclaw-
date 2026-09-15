import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareModelPricingContext } from "../model-catalog/pricing.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { getCurrentPluginMetadataSnapshotState } from "../plugins/current-plugin-metadata-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshotAsync,
} from "../plugins/plugin-metadata-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps async cold adoption, workspace scopes, and forced fresh inventories distinct", async () => {
  const stateDir = tempDirs.make("openclaw-async-usage-metadata-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const config = { plugins: { enabled: false } };
  clearPluginMetadataLifecycleCaches();
  try {
    const first = await resolvePluginMetadataSnapshotAsync({ config, env });
    expect(await resolvePluginMetadataSnapshotAsync({ config: structuredClone(config), env })).toBe(
      first,
    );
    const workspaceDir = path.join(stateDir, "workspace");
    const scoped = withPluginCache(createPluginCache(), () =>
      loadPluginMetadataSnapshot({ config, env, index: first.index, workspaceDir }),
    );
    await withPluginMetadataSnapshotScope(
      scoped,
      async () => {
        expect(
          await resolvePluginMetadataSnapshotAsync({
            config,
            env,
            allowWorkspaceScopedCurrent: true,
          }),
        ).toBe(scoped);
        const empty = await resolvePluginMetadataSnapshotAsync({
          config,
          env,
          pluginIds: [],
          allowWorkspaceScopedCurrent: true,
        });
        expect(empty.plugins).toEqual([]);
        expect(empty.index).toBe(scoped.index);
      },
      { config, env, workspaceDir, trustConfigIdentity: true },
    );
    const fresh = await resolvePluginMetadataSnapshotAsync({
      config,
      env,
      index: first.index,
      allowCurrent: false,
    });
    expect(fresh).not.toBe(first);
    expect(getCurrentPluginMetadataSnapshotState().snapshot).toBe(first);
  } finally {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
  }
});

it("does not cache metadata absence when its database read admission retires", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-pricing-read-retirement-"));
  clearPluginMetadataLifecycleCaches();
  const started = createDeferredCore();
  const reading = createDeferredCore();
  vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementationOnce(async () => {
    started.resolve();
    await reading.promise;
    throw new Error("optional metadata unavailable");
  });
  const config = { plugins: { enabled: false }, models: { catalogRefresh: { enabled: false } } };
  try {
    await using cache = createPluginCache();
    const preparing = withPluginCache(cache, () => prepareModelPricingContext(config));
    const rejected = expect(preparing).rejects.toMatchObject({
      code: "PLUGIN_CACHE_FACT_INVALIDATED",
      cause: { code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" },
    });
    await started.promise;
    await closeOpenClawStateDatabaseAsync();
    reading.resolve();
    await rejected;
    await expect(
      withPluginCache(cache, () => prepareModelPricingContext(config)),
    ).resolves.toBeUndefined();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
  }
});
