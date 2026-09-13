import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { normalizeSqliteNumber } from "./sqlite-number.js";

export type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

export type SqliteWalCheckpointOptions = {
  databaseLabel?: string;
  databasePath?: string;
  onCheckpointError?: (error: unknown) => void;
};

export type SqliteWalHealth = {
  state: "complete" | "blocked" | "error";
  observedAtMs: number;
  walBytes: number | null;
  databaseBytes: number | null;
  logFrames: number | null;
  checkpointedFrames: number | null;
  lastCompletedAtMs: number | null;
  consecutiveBlocked: number;
  warning: boolean;
  error?: string;
};

function sqliteFileBytes(pathname: string): number {
  try {
    return fs.statSync(pathname).size;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

/** The maintenance lifecycle owns this checkpoint result and its last observation. */
export function createSqliteWalCheckpoint(
  db: DatabaseSync,
  options: SqliteWalCheckpointOptions,
  journalSizeLimitBytes: number,
) {
  let health: SqliteWalHealth | undefined;

  const checkpointObservation = (): SqliteWalHealth => ({
    state: "error",
    observedAtMs: Date.now(),
    walBytes: null,
    databaseBytes: null,
    logFrames: null,
    checkpointedFrames: null,
    lastCompletedAtMs: health?.lastCompletedAtMs ?? null,
    consecutiveBlocked: 0,
    warning: true,
  });

  const recordCheckpointError = (error: unknown, observation = checkpointObservation()): void => {
    health = {
      ...observation,
      state: "error",
      consecutiveBlocked: 0,
      warning: true,
      error: formatErrorMessage(error),
    };
    options.onCheckpointError?.(error);
  };

  const runCheckpoint = (mode: SqliteWalCheckpointMode): boolean => {
    const observation = checkpointObservation();
    let busy: boolean;
    try {
      const row = db.prepare(`PRAGMA wal_checkpoint(${mode});`).get();
      const [busyResult, logFrames, checkpointedFrames] = Object.values(row ?? {}).map((value) =>
        normalizeSqliteNumber(
          typeof value === "number" || typeof value === "bigint" ? value : null,
        ),
      );
      if (busyResult === undefined || logFrames === undefined || checkpointedFrames === undefined) {
        throw new Error("SQLite returned an invalid WAL checkpoint result");
      }
      busy = busyResult !== 0;
      observation.logFrames = logFrames;
      observation.checkpointedFrames = checkpointedFrames;
      // PASSIVE reports busy=0 even when a reader prevents copying all frames.
      observation.state = busy || checkpointedFrames < logFrames ? "blocked" : "complete";
      if (observation.state === "complete") {
        observation.lastCompletedAtMs = observation.observedAtMs;
      } else {
        observation.consecutiveBlocked = (health?.consecutiveBlocked ?? 0) + 1;
      }
      if (options.databasePath) {
        observation.databaseBytes = sqliteFileBytes(options.databasePath);
        observation.walBytes = sqliteFileBytes(`${options.databasePath}-wal`);
      }
      // Allow the existing retained-WAL ceiling or two database images before warning early.
      observation.warning =
        observation.state === "blocked" &&
        (observation.consecutiveBlocked >= 2 ||
          (observation.walBytes !== null &&
            observation.databaseBytes !== null &&
            observation.walBytes > Math.max(2 * observation.databaseBytes, journalSizeLimitBytes)));
      health = observation;
    } catch (error) {
      recordCheckpointError(error, observation);
      return false;
    }
    if (busy || observation.warning) {
      const label = options.databaseLabel ?? "sqlite database";
      options.onCheckpointError?.(
        new Error(
          `${label} WAL checkpoint ${mode} ${busy ? "remained busy" : "blocked by a reader"}`,
        ),
      );
    }
    return observation.state === "complete";
  };

  return {
    run: runCheckpoint,
    recordError: recordCheckpointError,
    get health() {
      return health ? { ...health } : undefined;
    },
  };
}
