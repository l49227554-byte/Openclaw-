import type { CronMaintenanceOptions } from "../service/jobs-scheduling.js";
import type { DeferredCronNotifications } from "../service/state.js";
import type { CronFailureNotificationDelivery, CronJob } from "../types.js";
import type {
  CronRunRecoveryOutcome,
  CronRunRecoveryPreparation,
  CronRunRecoveryProposal,
} from "./run-recovery.types.js";

type CronScheduleOwnershipFacts = {
  jobId: string;
  active: boolean;
  reservation?: { markerAtMs: number; preserveWhenDisabled: boolean };
};

export type CronRuntimeMutationContracts = {
  "cron.repairRun": {
    input: { storeKey: string; proposal: CronRunRecoveryProposal; mode: "startup" | "reclaim" };
    facts: Pick<CronJob, "id" | "delivery" | "failureAlert">;
    preparation: CronRunRecoveryPreparation;
    outcome: CronRunRecoveryOutcome;
  };
  "cron.scheduleUnowned": {
    input: {
      storeKey: string;
      options?: Omit<CronMaintenanceOptions, "deferredNotifications">;
    };
    facts: { jobIds: string[] };
    preparation: { nowMs: number; ownership: CronScheduleOwnershipFacts[] };
    outcome: {
      changed: boolean;
      jobs: CronJob[];
      notifications: DeferredCronNotifications;
      logs: CronRunRecoveryOutcome["logs"];
    };
  };
  "cron.recordFailureAlertOutcome": {
    input: {
      storeKey: string;
      jobId: string;
      runAtMs: number | undefined;
      alertAtMs: number | undefined;
      notificationId: string | undefined;
      outcome: CronFailureNotificationDelivery;
    };
    facts: { ownsCycle: boolean };
    preparation: Record<string, never>;
    outcome: { job?: CronJob };
  };
};

export type CronRuntimeMutationType = keyof CronRuntimeMutationContracts;
export type CronRuntimeWorkerOperations = {
  [Type in CronRuntimeMutationType]: {
    input: CronRuntimeMutationContracts[Type]["input"] & { nonce: string };
    output: { nonce: string };
  };
};
