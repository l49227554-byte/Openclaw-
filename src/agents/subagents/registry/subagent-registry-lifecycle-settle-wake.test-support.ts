// Settle-wake settlement-failure coverage for the subagent registry lifecycle.
// Split out of subagent-registry-lifecycle.test.ts, which is a grandfathered
// oversized file; the scaffolding is injected the same way the private
// completion-settlement suite receives it.
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { settleRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RequesterSettleWakeParams = Parameters<
  SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];

export function registerRequesterSettleWakeFailureTests({
  createRunEntry,
  createLifecycleController,
  waitForLifecycleState,
  completionDeliveryMocks,
}: {
  createRunEntry: (
    overrides: Partial<SubagentRunRecord> & { endedAt?: number },
  ) => SubagentRunRecord;
  createLifecycleController: (
    options: { entry: SubagentRunRecord } & Partial<SubagentLifecycleOptions>,
  ) => SubagentLifecycleController;
  waitForLifecycleState: (assertion: () => void) => Promise<unknown>;
  completionDeliveryMocks: {
    settleRequesterCompletionBatch: Mock<typeof settleRequesterCompletionBatch>;
  };
}): void {
  describe("requester settle wake settlement failures", () => {
    it("abandons a wake whose settlement commit can never succeed", async () => {
      // Production wedge (2026-08-26..2026-09-20): settlement rejected the batch
      // on every attempt, the write rolled back, and the registry sweeper re-ran
      // the identical rejection ~1440 times a day for 20 days. The retained
      // pending commit bounds the retry *rate*; nothing bounded its lifetime.
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        delivery: { status: "pending" },
        requesterSettleWake: { status: "pending", attemptCount: 0, batchRunIds: ["run-1"] },
      });
      const persist = vi.fn();
      const warn = vi.fn();
      // Inject the fault at its real boundary: the store rejects inside its write
      // transaction, so no durable state ever advances between attempts.
      completionDeliveryMocks.settleRequesterCompletionBatch.mockImplementation(() => {
        throw new Error("subagent completion owner changed before settlement: run-1");
      });
      const settleWake = vi.fn(async (wakeParams: RequesterSettleWakeParams) => {
        wakeParams.completeBatch([entry], entry.requesterSettleWake?.rearmGeneration, {
          delivered: false,
          path: "none",
          error: "requester settle wake deferred too many times",
        });
        return false;
      });
      const controller = createLifecycleController({
        entry,
        persist,
        warn,
        resolveSubagentTask: () => ({ lookup: "available" }),
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      const realNow = Date.now;
      let clockOffsetMs = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
      try {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          controller.clearScheduledResumeTimers();
          controller.resumeRequesterSettleWake(entry.runId, entry);
          await waitForLifecycleState(() =>
            expect(
              warn.mock.calls.filter(([message]) => message === "requester settle wake failed")
                .length,
            ).toBe(attempt),
          );
          // Each failure must buy a real backoff instead of an immediate re-run.
          clockOffsetMs += 300_000;
        }
        await waitForLifecycleState(() => expect(entry.requesterSettleWake).toBeUndefined());
      } finally {
        now.mockRestore();
      }

      expect(persist).toHaveBeenCalledWith(entry.runId);
      expect(warn).toHaveBeenCalledWith(
        // The rejection text must reach the message; warn metadata is not rendered.
        expect.stringContaining(
          "requester settle wake abandoned after 5 settlement failures: subagent completion owner changed before settlement",
        ),
        expect.objectContaining({ failureCount: 5 }),
      );
      controller.clearScheduledResumeTimers();
    });

    it("keeps settling a wake whose owner is still available", async () => {
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        delivery: { status: "delivered" },
        requesterSettleWake: { status: "pending", attemptCount: 0, batchRunIds: ["run-1"] },
      });
      const warn = vi.fn();
      const settleWake = vi.fn(async (wakeParams: RequesterSettleWakeParams) => {
        wakeParams.completeBatch([entry], entry.requesterSettleWake?.rearmGeneration);
        return true;
      });
      const controller = createLifecycleController({
        entry,
        warn,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      controller.resumeRequesterSettleWake(entry.runId, entry);
      await waitForLifecycleState(() => expect(entry.requesterSettleWake).toBeUndefined());
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("requester settle wake abandoned"),
        expect.anything(),
      );
      controller.clearScheduledResumeTimers();
    });
  });
}
