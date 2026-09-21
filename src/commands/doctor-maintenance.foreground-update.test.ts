import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS } from "../infra/gateway-lock.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "../infra/state-database-coordinator.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
});

function fixture(mode: "foreground" | "supervised" = "foreground") {
  const stateDir = dirs.make("doctor-foreground-settlement-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  const owner = {
    pid: process.pid,
    host: hostname(),
    startedAt: getFileLockProcessStartTime(process.pid),
  };
  expect(owner.startedAt).not.toBeNull();
  withOpenClawStateStartupMigrationCheckpointDatabase((db) => {
    db.prepare(
      `INSERT INTO state_leases
       (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
       VALUES ('gateway-owner', 'global', 'previous-gateway', ?, ?, ?, ?, ?)`,
    ).run(
      Date.now() + 600_000,
      Date.now(),
      JSON.stringify({
        owner,
        port: 19483,
        mode,
        supervisor: mode === "supervised" ? { kind: "external", name: "fixture" } : null,
      }),
      Date.now(),
      Date.now(),
    );
  });
  closeOpenClawStateDatabaseForTest();
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const coordinator = acquireGatewayLifecycleCoordinator({ databasePath });
  coordinator.release();
  const predecessor = tryAcquireExclusiveSqliteCoordinator(coordinator.path, { busyTimeoutMs: 0 });
  expect(predecessor).not.toBeNull();
  return { databasePath, predecessor };
}

it.each(["released", "owner-changed", "authority-lost", "deadline"] as const)(
  "settles the foreground state owner before update Doctor admission: %s",
  async (outcome) => {
    const { databasePath, predecessor } = fixture();
    const before = fs.readFileSync(databasePath);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    let monotonicMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    let authorized = true;
    const waiting = Promise.withResolvers<void>();
    let settled = false;
    const result = beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true },
      root: null,
      runtime: { log: () => waiting.resolve(), error: vi.fn(), exit: vi.fn() },
      assertCurrent: () => {
        if (!authorized) {
          throw new Error("update owner was revoked");
        }
      },
    }).then(
      (maintenance) => {
        settled = true;
        return { maintenance };
      },
      (error: unknown) => {
        settled = true;
        waiting.resolve();
        return { error };
      },
    );
    let maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
    try {
      await waiting.promise;
      expect(settled).toBe(false);
      expect(fs.readFileSync(databasePath)).toEqual(before);
      if (outcome === "released") {
        predecessor?.release();
      } else if (outcome === "owner-changed") {
        withOpenClawStateStartupMigrationCheckpointDatabase((db) => {
          db.prepare("UPDATE state_leases SET owner = 'replacement-gateway'").run();
        });
      } else if (outcome === "authority-lost") {
        authorized = false;
        predecessor?.release();
      } else {
        monotonicMs = GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS;
      }
      await vi.advanceTimersToNextTimerAsync();
      const completed = await result;
      maintenance = "maintenance" in completed ? completed.maintenance : undefined;
      if (outcome === "released") {
        expect(maintenance).toBeDefined();
        await maintenance?.finish({});
      } else {
        expect(completed).toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining(
              outcome === "authority-lost"
                ? "update owner was revoked"
                : "another OpenClaw process owns gateway-lifecycle",
            ),
          }),
        });
      }
    } finally {
      predecessor?.release();
      await maintenance?.release();
    }
  },
);

it.each(["ordinary", "unfenced", "supervised"] as const)(
  "does not wait for unrelated Doctor contention: %s",
  async (kind) => {
    const { predecessor } = fixture(kind === "supervised" ? "supervised" : "foreground");
    if (kind === "ordinary") {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    }
    const log = vi.fn();
    try {
      await expect(
        beginDoctorMaintenance({
          options: { repair: true, nonInteractive: true },
          root: null,
          runtime: { log, error: vi.fn(), exit: vi.fn() },
          ...(kind === "unfenced" ? {} : { assertCurrent: () => {} }),
        }),
      ).rejects.toThrow("another OpenClaw process owns gateway-lifecycle");
      expect(log).not.toHaveBeenCalled();
    } finally {
      predecessor?.release();
    }
  },
);
