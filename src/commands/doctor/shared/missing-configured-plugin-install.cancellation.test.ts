// Register catalog mocks before loading the repair runtime.
import "./missing-configured-plugin-install.suite.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { copyPluginInstallTransactionRequest } from "../../../plugins/install-transaction.js";
import { readPersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store.js";
import { createColdPluginFixture } from "../../../plugins/test-helpers/cold-plugin-fixtures.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { channelPluginEntry } from "./missing-configured-plugin-install.test-helpers.js";

const { mocks, testEnv, tempDirs, useRealInstallIndexWrites, setupPluginInstallSuite } =
  await import("./missing-configured-plugin-install.suite.test-support.js");

describe("configured plugin repair cancellation", () => {
  setupPluginInstallSuite();
  it("propagates cancellation from persisted-record repair without continuing fallback", async () => {
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: "/missing/demo",
      },
    };
    const controller = new AbortController();
    const abortReason = new Error("Gateway startup interrupted by SIGTERM");
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: { signal?: AbortSignal }) => {
        expect(params.signal).toBeDefined();
        expect(params.signal?.aborted).toBe(false);
        controller.abort(abortReason);
        params.signal?.throwIfAborted();
        throw new Error("expected composed repair signal to abort");
      },
    );

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    await expect(
      repairMissingConfiguredPluginInstalls({
        cfg: {
          plugins: {
            entries: {
              demo: { enabled: true },
            },
          },
        },
        env: {},
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);

    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease).not.toHaveBeenCalled();
  });

  it.each(["publication", "index planning"] as const)(
    "rolls back a real candidate install when startup is cancelled after %s",
    async (cancelAfter) => {
      const root = tempDirs.make("openclaw-doctor-cancelled-candidate-");
      const env = { ...testEnv, OPENCLAW_STATE_DIR: path.join(root, "state") };
      const extensionsDir = path.join(root, "extensions");
      const targetDir = path.join(extensionsDir, "demo");
      const sourceDir = path.join(root, "source");
      fs.mkdirSync(sourceDir);
      createColdPluginFixture({ rootDir: sourceDir, pluginId: "demo" });
      fs.writeFileSync(path.join(sourceDir, "marker.txt"), "published candidate");
      const cfg = {
        plugins: { entries: { demo: { enabled: true } } },
      } satisfies OpenClawConfig;
      const controller = new AbortController();
      const reason = new Error(`Startup cancelled after ${cancelAfter}`);
      let published = false;
      mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(extensionsDir);
      mocks.listChannelPluginCatalogEntries.mockReturnValue([
        channelPluginEntry({ id: "demo", npmSpec: "@example/demo" }),
      ]);
      const { installPluginDirectoryIntoExtensions } =
        await import("../../../plugins/install-shared.js");
      const install: typeof import("../../../plugins/install.js").installPluginFromNpmSpec = async (
        params,
      ) => {
        const result = await installPluginDirectoryIntoExtensions(
          copyPluginInstallTransactionRequest(params, {
            sourceDir,
            targetDir,
            pluginId: "demo",
            extensions: ["index.cjs"],
            logger: {},
            timeoutMs: 1_000,
            mode: "install",
            dryRun: false,
            copyErrorPrefix: "failed to copy plugin",
            hasDeps: false,
            depsLogMessage: "",
            signal: params.signal,
            onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
          }),
        );
        if (result.ok) {
          published =
            fs.readFileSync(path.join(targetDir, "marker.txt"), "utf8") === "published candidate";
          if (cancelAfter === "publication") {
            controller.abort(reason);
          }
        }
        return result;
      };
      mocks.installPluginFromNpmSpec.mockImplementation(install);
      await useRealInstallIndexWrites();
      try {
        await seedInstalledPluginIndex({}, { env, config: cfg, candidates: [] });
        const before = await readPersistedInstalledPluginIndex({ env });
        const { repairMissingConfiguredPluginInstalls } =
          await import("./missing-configured-plugin-install.js");
        const failure = await repairMissingConfiguredPluginInstalls({
          cfg,
          env,
          signal: controller.signal,
          beforePersistentEffect: async () => {
            if (published && cancelAfter === "index planning") {
              await Promise.resolve();
              controller.abort(reason);
            }
          },
        }).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(published).toBe(true);
        expect.soft(failure).toBe(reason);
        expect.soft(await readPersistedInstalledPluginIndex({ env })).toEqual(before);
        expect(fs.existsSync(targetDir)).toBe(false);
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
      }
    },
  );
});
