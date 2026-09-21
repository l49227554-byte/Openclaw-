import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { persistPluginInstall } from "./install-persistence.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

describe("plugin install slot selection", () => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanupPluginLoaderFixturesForTest();
  });

  it("does not register a legacy function-export plugin while persisting its first install", async () => {
    const stateDir = makePluginLoaderTempDir();
    const configPath = path.join(stateDir, "openclaw.json");
    const registrationMarker = path.join(stateDir, "registered");
    await withEnvAsync(
      {
        OPENCLAW_HOME: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      async () => {
        useNoBundledPlugins();
        await writeConfigFile({});
        await withPluginLifecycleLease({}, async () => {
          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          const pluginId = "legacy-function-candidate";
          const pluginDir = path.join(stateDir, "extensions", pluginId);
          fs.mkdirSync(pluginDir, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDir, "package.json"),
            JSON.stringify({
              name: pluginId,
              version: "1.0.0",
              openclaw: { extensions: ["./index.cjs"] },
            }),
          );
          fs.writeFileSync(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              configSchema: { type: "object", additionalProperties: false, properties: {} },
            }),
          );
          fs.writeFileSync(
            path.join(pluginDir, "index.cjs"),
            `module.exports = function register() {
              require("node:fs").writeFileSync(${JSON.stringify(registrationMarker)}, "registered");
            };\n`,
          );

          await persistPluginInstall({
            snapshot: {
              config: snapshot.config,
              baseHash: snapshot.hash ?? undefined,
              writeOptions,
            },
            pluginId,
            install: { source: "marketplace", installPath: pluginDir, version: "1.0.0" },
            enable: true,
          });

          expect(fs.existsSync(registrationMarker)).toBe(false);
          const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
          expect(persisted.plugins?.entries?.[pluginId]?.enabled).toBe(true);
        });
      },
    );
  });
});
