import { acquireWithWait } from "../infra/acquire-with-wait.js";
import { GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS } from "../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import {
  acquireGatewayMaintenanceCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "../infra/state-database-coordinator.js";
import { readStateLeaseProcessOwnerStatus } from "../infra/state-lease-process-owner.js";
import type { RuntimeEnv } from "../runtime.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { sleep } from "../utils/sleep.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode, resolveDoctorRepairMode } from "./doctor-repair-mode.js";

export async function acquireDoctorGatewayMaintenanceCoordinator(
  databasePath: string,
  env: NodeJS.ProcessEnv,
  params: { options: DoctorOptions; runtime: RuntimeEnv; assertCurrent?: () => void },
) {
  const updateRepair = isDoctorUpdateRepairMode(resolveDoctorRepairMode(params.options));
  let foreground: ReturnType<typeof readGatewayOwnerLease>;
  return await acquireWithWait({
    acquire: () => {
      params.assertCurrent?.();
      return acquireGatewayMaintenanceCoordinator({ databasePath, busyTimeoutMs: 0 });
    },
    shouldRetry: (error) => {
      // A delegated updater may reach Doctor before its replaced foreground
      // Gateway observes the new installation and finishes releasing state.
      if (
        !updateRepair ||
        !params.assertCurrent ||
        !(error instanceof StateDatabaseCoordinatorContentionError) ||
        error.family !== "gateway-lifecycle"
      ) {
        return false;
      }
      params.assertCurrent();
      const current = readGatewayOwnerLease({
        env,
        current: true,
        openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
      });
      if (!foreground) {
        if (current?.state !== "live" || current.mode !== "foreground") {
          return false;
        }
        foreground = current;
        params.runtime.log("Waiting for the previous foreground Gateway to release state.");
      } else if (
        current &&
        (current.owner !== foreground.owner ||
          current.pid !== foreground.pid ||
          current.startedAt !== foreground.startedAt ||
          current.host !== foreground.host ||
          current.mode !== "foreground")
      ) {
        return false;
      }
      // The owner removes its row just before releasing the physical lock.
      // A dead predecessor cannot explain a lock still held by another process.
      return readStateLeaseProcessOwnerStatus(foreground) === "live";
    },
    deadlineMs: performance.now() + GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS,
    pollIntervalMs: 100,
    maxPollIntervalMs: 1_000,
    sleep,
  });
}
