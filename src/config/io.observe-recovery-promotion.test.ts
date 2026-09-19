// Covers last-known-good promotion admission for suspicious snapshots (#152509).
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  promoteConfigSnapshotToLastKnownGoodCore,
  recoverConfigFromLastKnownGoodCore,
} from "./io.observe-recovery.js";
import type { ConfigFileSnapshot } from "./types.js";

type ObserveRecoveryDeps = Parameters<typeof promoteConfigSnapshotToLastKnownGoodCore>[0]["deps"];

const approveRecoveryCandidate = <T extends { raw: string; parsed: unknown }>(candidate: T) => ({
  ok: true as const,
  candidate,
});

function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

describe("config observe recovery promotion", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fsp.mkdir(home, { recursive: true });
    return await fn(home);
  }

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-config-observe-promotion-"));
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  async function makeSnapshot(configPath: string, config: Record<string, unknown>) {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, raw, "utf-8");
    return {
      path: configPath,
      exists: true,
      raw,
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    } satisfies ConfigFileSnapshot;
  }

  function makeDeps(home: string, warn = vi.fn()) {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      deps: {
        fs,
        json5: JSON5,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn },
      } as unknown as ObserveRecoveryDeps,
      configPath,
      warn,
    };
  }

  it("refuses to promote a suspicious snapshot over last-known-good", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      const healthyConfig = {
        meta: { lastTouchedVersion: "2026.4.22" },
        update: { channel: "beta" },
        gateway: {
          mode: "local" as const,
          trustedProxies: Array.from({ length: 60 }, (_, index) => `192.0.2.${index}`),
        },
      };
      const healthy = await makeSnapshot(configPath, healthyConfig);

      await expect(
        promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: healthy, logger: deps.logger }),
      ).resolves.toBe(true);
      await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
        healthy.raw,
      );

      const truncated = await makeSnapshot(configPath, { gateway: { mode: "local", port: 19187 } });

      await expect(
        promoteConfigSnapshotToLastKnownGoodCore({
          deps,
          snapshot: truncated,
          logger: deps.logger,
        }),
      ).resolves.toBe(false);
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "Config last-known-good promotion skipped",
      );
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "size-drop-vs-last-good",
      );
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
        "missing-meta-vs-last-good",
      );
      await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
        healthy.raw,
      );

      const brokenRaw = "{ gateway: { mode: 123 } }\n";
      await fsp.writeFile(configPath, brokenRaw, "utf-8");
      const restored = await recoverConfigFromLastKnownGoodCore({
        deps,
        snapshot: {
          ...truncated,
          raw: brokenRaw,
          parsed: { gateway: { mode: 123 } },
          valid: false,
          issues: [{ path: "gateway.mode", message: "Expected string" }],
        },
        reason: "test-suspicious-promotion",
        prepareCandidate: approveRecoveryCandidate,
      });

      expect(restored).toBe(true);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(healthy.raw);
    });
  });

  it("promotes a non-suspicious snapshot whose shape matches the baseline", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      const healthy = await makeSnapshot(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
        update: { channel: "beta" },
        gateway: { mode: "local" as const },
      });

      await expect(
        promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: healthy, logger: deps.logger }),
      ).resolves.toBe(true);

      const edited = await makeSnapshot(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
        update: { channel: "beta" },
        gateway: { mode: "local" as const, port: 19187 },
      });

      await expect(
        promoteConfigSnapshotToLastKnownGoodCore({ deps, snapshot: edited, logger: deps.logger }),
      ).resolves.toBe(true);
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
        "Config last-known-good promotion skipped",
      );
      await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
        edited.raw,
      );
    });
  });
});
