import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { handleOrphanedSubagentResume } from "./subagent-registry-resume-orphan.js";

function createHarness(params?: {
  terminal?: boolean;
  collect?: boolean;
  collectorComplete?: boolean;
  collectorLaunchCleanupPending?: boolean;
  hasUnsettledTask?: boolean;
}) {
  const now = Date.now();
  const entry = createSubagentRunRecord({
    runId: "run-orphan",
    childSessionKey: "agent:main:subagent:orphan",
    task: "finish orphan ownership",
    cleanup: "keep",
    expectsCompletionMessage: false,
    completion: { required: false },
    delivery: { status: "not_required" },
    createdAt: now - 100,
    startedAt: now - 50,
    ...(params?.terminal ? { endedAt: now, outcome: { status: "ok" } } : {}),
    ...(params?.collect
      ? {
          collect: true,
          ...(params.collectorComplete ? { collectorCompletion: { status: "done" } } : {}),
          ...(params.collectorLaunchCleanupPending ? { collectorLaunchCleanupPending: true } : {}),
        }
      : {}),
  });
  const runs = new Map([[entry.runId, entry]]);
  const resumedRuns = new Set<string>();
  const persist = vi.fn();
  const complete = vi.fn(async () => {});
  const handled = handleOrphanedSubagentResume({
    runId: entry.runId,
    entry,
    source: "restore",
    runs,
    resumedRuns,
    hasUnsettledTask: params?.hasUnsettledTask === true,
    persist,
    complete,
    warn: vi.fn(),
  });
  return { complete, entry, handled, persist, runs };
}

it("completes a running quiet orphan instead of pruning its ownership", async () => {
  const harness = createHarness();

  expect(harness.handled).toBe(true);
  expect(harness.runs.has(harness.entry.runId)).toBe(true);
  await vi.waitFor(() => expect(harness.complete).toHaveBeenCalledOnce());
});

it.each([
  { name: "unfinished task", hasUnsettledTask: true },
  { name: "unfinished collector", collect: true },
  {
    name: "collector launch cleanup",
    collect: true,
    collectorComplete: true,
    collectorLaunchCleanupPending: true,
  },
])("preserves terminal orphan ownership with $name debt", (params) => {
  const harness = createHarness({ terminal: true, ...params });

  expect(harness.handled).toBe(false);
  expect(harness.runs.has(harness.entry.runId)).toBe(true);
  expect(harness.complete).not.toHaveBeenCalled();
  expect(harness.persist).not.toHaveBeenCalled();
});

it("directly prunes a terminal orphan only after all ownership is settled", () => {
  const harness = createHarness({
    terminal: true,
    collect: true,
    collectorComplete: true,
  });

  expect(harness.handled).toBe(true);
  expect(harness.runs.has(harness.entry.runId)).toBe(false);
  expect(harness.persist).toHaveBeenCalledWith(harness.entry.runId);
  expect(harness.complete).not.toHaveBeenCalled();
});
