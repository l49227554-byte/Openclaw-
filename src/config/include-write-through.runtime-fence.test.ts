// Fixture scaffold (mocks, suite temp roots, itWithHome/createFastConfigIO)
// duplicated from include-write-through.publish.test.ts -- it is local,
// unexported test infra, not a shared module.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readConfigFileSnapshot, resetConfigRuntimeState, writeConfigFile } from "./io.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn((): PluginManifestRegistry => ({
    diagnostics: [],
    plugins: [],
  })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: mockLoadPluginManifestRegistry,
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: mockLoadPluginManifestRegistry,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorLegacyConfigRules: () => [],
    applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
  };
});

// The snapshot-to-stage fence must hold for every writer that starts from a
// snapshot, including the runtime entry and bare baseSnapshot callers that
// supply no include hashes of their own.
describe("config io write / include write-through runtime fence", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-fence-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      await suiteRootTracker.make("coordinator"),
    );
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    vi.mocked(tmpDirOwner.resolvePreferredOpenClawTmpDir).mockRestore();
    await suiteRootTracker.cleanup();
  });

  const formatConfig = (config: unknown) => `${JSON.stringify(config, null, 2)}\n`;
  const writeConfigJson = async (configPath: string, config: unknown) => {
    await fs.writeFile(configPath, formatConfig(config), "utf-8");
  };

  async function makeCase(): Promise<{ home: string; configPath: string; workPath: string }> {
    const home = await suiteRootTracker.make("case");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const workPath = path.join(home, ".openclaw", "config", "agents", "work.json5");
    await fs.mkdir(path.dirname(workPath), { recursive: true });
    await writeConfigJson(workPath, {
      name: "Work",
      model: "gpt-4",
    });
    await writeConfigJson(configPath, {
      agents: {
        ownership: "explicit",
        entries: { work: { $include: "./config/agents/work.json5" } },
      },
    });
    return { home, configPath, workPath };
  }

  it("rejects a runtime writeConfigFile save when an included agent file changed after the snapshot read", async () => {
    const { configPath, workPath } = await makeCase();
    const originalRootRaw = await fs.readFile(configPath, "utf-8");

    // The runtime writer asserts the config path twice before its snapshot
    // read and once right after it, ahead of staging. Editing on that third
    // call only lands one concurrent write inside the snapshot-to-stage
    // window; a later edit would trip the separate stage-to-publish fence.
    let calls = 0;
    const concurrentRaw = formatConfig({ name: "Work", model: "concurrent-edit" });
    const assertConfigPathForWrite = () => {
      calls += 1;
      if (calls === 3) {
        fsSync.writeFileSync(workPath, concurrentRaw, "utf-8");
      }
    };

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      await expect(
        writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { work: { model: "gpt-4-turbo" } },
            },
          } as unknown as OpenClawConfig,
          { assertConfigPathForWrite },
        ),
      ).rejects.toThrow("included config changed since last load");
    });

    expect(calls).toBeGreaterThanOrEqual(3);
    await expect(fs.readFile(workPath, "utf-8")).resolves.toBe(concurrentRaw);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
  });

  it("fences a bare baseSnapshot from readConfigFileSnapshot", async () => {
    const { configPath, workPath } = await makeCase();
    const originalRootRaw = await fs.readFile(configPath, "utf-8");

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      // The wizard/install shape: a bare ConfigFileSnapshot from the public
      // reader, threaded straight into writeConfigFile as baseSnapshot with
      // no includeFileHashesForWrite/Targets of its own.
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const externalRaw = formatConfig({
        name: "Work",
        model: "concurrent-external-edit",
      });
      await fs.writeFile(workPath, externalRaw, "utf-8");

      await expect(
        writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { work: { model: "gpt-4-turbo" } },
            },
          } as unknown as OpenClawConfig,
          { baseSnapshot: snapshot },
        ),
      ).rejects.toThrow("included config changed since last load");

      await expect(fs.readFile(workPath, "utf-8")).resolves.toBe(externalRaw);
    });

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
  });

  it("refuses to stage include writes for a snapshot with no load-time fence", async () => {
    const { configPath, workPath } = await makeCase();
    const originalRootRaw = await fs.readFile(configPath, "utf-8");
    const originalWorkRaw = await fs.readFile(workPath, "utf-8");

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      // No read recorded load hashes for this object, so the write fails
      // closed even though nothing on disk changed.
      const clonedSnapshot = { ...snapshot };

      await expect(
        writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { work: { model: "gpt-4-turbo" } },
            },
          } as unknown as OpenClawConfig,
          { baseSnapshot: clonedSnapshot },
        ),
      ).rejects.toThrow(ConfigMutationConflictError);
    });

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
    await expect(fs.readFile(workPath, "utf-8")).resolves.toBe(originalWorkRaw);
  });

  it("still publishes a mixed root+include write through the runtime entry when nothing raced it", async () => {
    const { configPath, workPath } = await makeCase();

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      await writeConfigFile({
        agents: {
          ownership: "explicit",
          entries: { work: { name: "Work", model: "gpt-4-turbo" } },
        },
      } as unknown as OpenClawConfig);
    });

    const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(rootAfter.agents).toEqual({
      ownership: "explicit",
      entries: { work: { $include: "./config/agents/work.json5" } },
    });
    const workAfter = JSON.parse(await fs.readFile(workPath, "utf-8")) as Record<string, unknown>;
    expect(workAfter.model).toBe("gpt-4-turbo");
    expect(workAfter.name).toBe("Work");
  });
});
