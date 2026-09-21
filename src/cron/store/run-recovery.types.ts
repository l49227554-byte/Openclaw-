import type { CronConfig } from "../../config/types.cron.js";
import type { ResolvedFailureAlert } from "../service/failure-alerts.js";
import type { InterruptedStartupRun } from "../service/startup-run-repair.js";
import type { DeferredCronNotifications, Logger } from "../service/state.js";
import type { CronRunReceiptRecoveryCandidate } from "./run-receipt-store.js";

export type CronRunRecoveryProposal = {
  jobId: string;
  queuedAtMs?: number;
  runningAtMs?: number;
  runningReceiptId?: string;
  receipt?: CronRunReceiptRecoveryCandidate;
};

export type CronRunRecoveryWorkerOperations = {
  "cron.initializeRunReceipts": {
    input: Record<string, never>;
    output: void;
  };
};

export type CronRunRecoveryResult =
  | { kind: "live"; receipt: CronRunReceiptRecoveryCandidate }
  | { kind: "superseded"; receipt?: CronRunReceiptRecoveryCandidate }
  | {
      kind: "repaired";
      interrupted?: InterruptedStartupRun;
      notifications: DeferredCronNotifications;
      skipStartupCatchup?: boolean;
    };

export type CronRunRecoveryObservation =
  | { kind: "observed"; proposals: CronRunRecoveryProposal[] }
  | { kind: "schema-uninitialized" };

export type CronRunRecoveryReadCommand = {
  type: "cron.observeRunRecovery";
  storeKey: string;
  proposals: readonly CronRunRecoveryProposal[];
};

export type CronRunRecoveryOutcome = {
  result: CronRunRecoveryResult;
  logs: Array<{ level: keyof Logger; fields: unknown; message?: string }>;
};

export type CronRunRecoveryPreparation = {
  proposedReceiptIsStale: boolean;
  nowMs: number;
  cronConfig?: CronConfig;
  failureAlert: ResolvedFailureAlert | null;
};
