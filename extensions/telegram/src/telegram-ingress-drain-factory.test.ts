/** Verifies callback admission and the grammY terminal outcome handoff. */
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureTelegramMessageProcessingResult,
  recordTelegramMessageProcessingResult,
  runWithTelegramUpdateProcessingFrame,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { takeTelegramCallbackQueryAdmissionAnswer } from "./callback-query-answer-state.js";

const mocks = vi.hoisted(() => ({
  createTelegramIngressMonitor: vi.fn((params: unknown) => params),
  openTelegramIngressQueue: vi.fn(() => ({ kind: "test-queue" })),
  resolveTelegramAdoptionStallTimeoutMs: vi.fn(() => 5_000),
}));

vi.mock("./telegram-ingress-drain.js", () => ({
  createTelegramIngressMonitor: mocks.createTelegramIngressMonitor,
  resolveTelegramAdoptionStallTimeoutMs: mocks.resolveTelegramAdoptionStallTimeoutMs,
}));

vi.mock("./telegram-ingress-spool.js", () => ({
  openTelegramIngressQueue: mocks.openTelegramIngressQueue,
}));

const { createTelegramTransportIngressMonitor } =
  await import("./telegram-ingress-drain-factory.js");

type CapturedMonitor = {
  onDurableAdmission: (update: unknown, context: { isNew: boolean }) => void | Promise<void>;
  dispatch: (update: unknown) => Promise<TelegramMessageProcessingResult | void>;
};

describe("Telegram transport ingress outcome handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: "after a rejected new-row answer",
      rejectNewAnswer: true,
      startNewPending: false,
      consumePending: false,
      expectedRequests: 2,
    },
    {
      name: "for an existing durable row",
      rejectNewAnswer: false,
      startNewPending: false,
      consumePending: false,
      expectedRequests: 1,
    },
    {
      name: "while middleware consumes a pending answer",
      rejectNewAnswer: false,
      startNewPending: true,
      consumePending: true,
      expectedRequests: 1,
    },
    {
      name: "before middleware consumes a new-row answer",
      rejectNewAnswer: false,
      startNewPending: true,
      consumePending: false,
      expectedRequests: 1,
    },
  ])(
    "coalesces duplicate callback answers $name",
    async ({ rejectNewAnswer, startNewPending, consumePending, expectedRequests }) => {
      const callbackId = "callback-redelivered";
      const answerRequests: Array<ReturnType<typeof createDeferred<true>>> = [];
      const answerCallbackQuery = vi.fn((_id: string) => {
        const answer = createDeferred<true>();
        answerRequests.push(answer);
        return answer.promise;
      });
      const bot = {
        handleUpdate: vi.fn(async () => {}),
        api: { answerCallbackQuery },
      };
      createTelegramTransportIngressMonitor({
        spoolDir: "/tmp/telegram-ingress-proof",
        bot,
        accountId: "default",
      });
      const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;
      const update = { update_id: 125, callback_query: { id: callbackId } };

      if (rejectNewAnswer) {
        await monitor.onDurableAdmission(update, { isNew: true });
        const rejectedAnswer = answerRequests[0];
        if (!rejectedAnswer) {
          throw new Error("expected a callback answer request");
        }
        rejectedAnswer.reject(new Error("ACK unavailable"));
        await Promise.allSettled(answerRequests.map((answer) => answer.promise));
      }
      if (startNewPending) {
        await monitor.onDurableAdmission(update, { isNew: true });
        if (consumePending) {
          expect(takeTelegramCallbackQueryAdmissionAnswer(bot, callbackId)).toBeDefined();
        }
      }
      await monitor.onDurableAdmission(update, { isNew: false });
      await monitor.onDurableAdmission(update, { isNew: false });

      expect(answerCallbackQuery.mock.calls.map(([id]) => id)).toEqual(
        Array.from({ length: expectedRequests }, () => callbackId),
      );
      expect(bot.handleUpdate).not.toHaveBeenCalled();

      for (const answer of answerRequests) {
        answer.resolve(true);
      }
      await Promise.allSettled(answerRequests.map((answer) => answer.promise));

      if (startNewPending && !consumePending) {
        expect(takeTelegramCallbackQueryAdmissionAnswer(bot, callbackId)).toBeDefined();
      }
      // Tombstones never dispatch; their settled answers must not remain per bot.
      expect(takeTelegramCallbackQueryAdmissionAnswer(bot, callbackId)).toBeUndefined();
    },
  );

  it.each([
    { kind: "completed" as const },
    { kind: "skipped" as const },
    { kind: "failed-retryable" as const, error: new Error("retry the update") },
  ])(
    "returns the middleware-owned $kind outcome despite grammY returning void",
    async (outcome) => {
      const bot = {
        handleUpdate: vi.fn(async () => {
          await runWithTelegramUpdateProcessingFrame(async () => {
            recordTelegramMessageProcessingResult(outcome);
          });
        }),
        api: { answerCallbackQuery: vi.fn(async () => true) },
      };
      createTelegramTransportIngressMonitor({
        spoolDir: "/tmp/telegram-ingress-proof",
        bot,
        accountId: "default",
      });
      const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;
      const update = { update_id: 123 };

      await expect(monitor.dispatch(update)).resolves.toBe(outcome);
      expect(bot.handleUpdate).toHaveBeenCalledWith(update);
    },
  );

  it("does not invent an outcome for deferred participant ownership", async () => {
    const bot = {
      handleUpdate: vi.fn(async () => {
        await runWithTelegramUpdateProcessingFrame(async () => {});
      }),
      api: { answerCallbackQuery: vi.fn(async () => true) },
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      accountId: "default",
    });
    const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;

    await expect(monitor.dispatch({ update_id: 124 })).resolves.toBeUndefined();
  });

  it("keeps an existing explicit skip when middleware applies its completion default", async () => {
    const bot = {
      handleUpdate: vi.fn(async () => {
        await runWithTelegramUpdateProcessingFrame(async () => {
          recordTelegramMessageProcessingResult({ kind: "skipped" });
          ensureTelegramMessageProcessingResult({ kind: "completed" });
        });
      }),
      api: { answerCallbackQuery: vi.fn(async () => true) },
    };
    createTelegramTransportIngressMonitor({
      spoolDir: "/tmp/telegram-ingress-proof",
      bot,
      accountId: "default",
    });
    const monitor = mocks.createTelegramIngressMonitor.mock.calls[0]?.[0] as CapturedMonitor;

    await expect(monitor.dispatch({ update_id: 125 })).resolves.toEqual({ kind: "skipped" });
  });
});
