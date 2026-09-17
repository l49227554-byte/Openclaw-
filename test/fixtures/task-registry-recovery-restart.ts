// Subprocess fixture for the task-registry recovery OS-process-restart proof
// (PR 149269). Spawned by src/tasks/task-registry.store.test.ts as a genuinely
// separate OS process (via resolveRuntimeWorkerArgv) so the corrected cleanup
// deadline is proven to survive real process restarts, not just an in-process
// registry reload.
//
// usage: task-registry-recovery-restart.ts <stateDir> <seed|recover|verify>
//
//   seed:    write a lost cron task whose 24h lost-window deadline has expired
//   recover: reload that lost record in a fresh process and recover it via
//            markTaskTerminalById
//   verify:  reload the corrected deadline in a fresh process and assert it
//            survived the restart
import path from "node:path";

const stateDir = process.argv[2];
const phase = process.argv[3];
if (!stateDir || !phase) {
  throw new Error("usage: task-registry-recovery-restart.ts <stateDir> <seed|recover|verify>");
}
process.env.OPENCLAW_STATE_DIR = path.resolve(stateDir);
process.env.OPENCLAW_CONFIG_PATH = path.join(path.resolve(stateDir), "openclaw.json");

const { upsertTaskWithDeliveryStateToSqlite, closeTaskRegistryDatabase } =
  await import("../../src/tasks/task-registry.store.sqlite.js");
const { reloadTaskRegistryFromStore, markTaskTerminalById, getTaskById } =
  await import("../../src/tasks/task-registry.js");
const { resolveTaskCleanupAfter } = await import("../../src/tasks/task-retention.js");
const { openOpenClawStateDatabase } = await import("../../src/state/openclaw-state-db.js");
import type { TaskRecord } from "../../src/tasks/task-registry.types.js";

const TASK_ID = "task-recovery-process-restart";
const HOUR = 60 * 60_000;
const now = Date.now();

if (phase === "seed") {
  // A cron task lost 30h ago whose 24h lost-window deadline has already expired.
  const lostAt = now - 30 * HOUR;
  const lostTask: TaskRecord = {
    taskId: TASK_ID,
    runtime: "cron",
    sourceId: "job-recovery-process-restart",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: "run-recovery-process-restart",
    task: "Recovery process-restart proof",
    status: "lost",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: lostAt,
    lastEventAt: lostAt,
    endedAt: lostAt,
    cleanupAfter: lostAt + 24 * HOUR, // short lost-window retention (expired)
  };
  openOpenClawStateDatabase();
  upsertTaskWithDeliveryStateToSqlite({ task: lostTask });
  closeTaskRegistryDatabase();
  if (now < lostTask.cleanupAfter!) {
    throw new Error("seed: expected the lost-window deadline to be expired");
  }
} else if (phase === "recover") {
  reloadTaskRegistryFromStore();
  const lost = getTaskById(TASK_ID);
  if (lost?.status !== "lost") {
    throw new Error(`recover: expected a still-lost record, got status=${lost?.status}`);
  }
  if (now < lost.cleanupAfter!) {
    throw new Error("recover: expected the stale lost-window deadline to be expired");
  }
  const recoveredEndedAt = now - 20 * HOUR; // recovery 20h after the lost-mark
  const recovered = markTaskTerminalById({
    taskId: TASK_ID,
    status: "succeeded",
    endedAt: recoveredEndedAt,
    lastEventAt: recoveredEndedAt,
  });
  if (recovered?.status !== "succeeded") {
    throw new Error(`recover: expected recovery to succeed, got status=${recovered?.status}`);
  }
  closeTaskRegistryDatabase();
} else if (phase === "verify") {
  reloadTaskRegistryFromStore();
  const recovered = getTaskById(TASK_ID);
  if (recovered?.status !== "succeeded") {
    throw new Error(
      `verify: expected a recovered succeeded record, got status=${recovered?.status}`,
    );
  }
  const expected = resolveTaskCleanupAfter({
    status: "succeeded",
    endedAt: recovered.endedAt!,
    lastEventAt: recovered.lastEventAt,
    createdAt: recovered.createdAt,
  });
  if (recovered.cleanupAfter !== expected || now >= recovered.cleanupAfter!) {
    throw new Error(
      `verify: corrected deadline did not survive restart: got ${recovered.cleanupAfter}, expected ${expected}`,
    );
  }
  closeTaskRegistryDatabase();
} else {
  throw new Error(`unknown phase: ${phase}`);
}
