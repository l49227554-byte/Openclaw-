import { describe, expect, it, vi } from "vitest";
import type { ChannelMessageDeferredDeliveryAdmissionContext } from "../../channels/message/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  drainPendingDeliveriesCore,
  recoverPendingDeliveries,
  type DeliverFn,
} from "./delivery-queue-recovery.js";
import { enqueueDelivery } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
  readQueuedEntry,
  setQueuedEntryState,
} from "./delivery-queue.test-helpers.js";

const resolveAdapter = vi.hoisted(() => vi.fn());
vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelMessageAdapter: resolveAdapter,
}));
vi.mock("../../utils/sleep.js", () => ({ sleep: async () => {} }));

describe("provider recovery deferral", () => {
  const { tmpDir } = installDeliveryQueueTmpDirHooks();

  it.each(["startup", "drain"] as const)(
    "%s preserves custody and attempts across repeated pauses and database reopen",
    async (mode) => {
      let paused = true;
      const admit = vi.fn((ctx: ChannelMessageDeferredDeliveryAdmissionContext) =>
        paused && ctx.supportsRecoveryDeferral
          ? { status: "deferred" as const, reason: "provider cooldown" }
          : { status: "allowed" as const },
      );
      const reconcile = vi.fn().mockResolvedValue({ status: "not_sent" });
      resolveAdapter.mockReturnValue({
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          admitDeferredDelivery: admit,
          reconcileUnknownSend: reconcile,
        },
      });
      const id = await enqueueDelivery(
        { channel: "demo", to: "recipient", payloads: [{ text: "original" }] },
        tmpDir(),
      );
      const unknownId = await enqueueDelivery(
        { channel: "demo", to: "other", payloads: [{ text: "unconfirmed" }] },
        tmpDir(),
      );
      setQueuedEntryState(tmpDir(), unknownId, {
        retryCount: 1,
        recoveryState: "send_attempt_started",
        lastAttemptAt: Date.now() - 60_000,
        platformSendStartedAt: Date.now() - 60_000,
      });
      const before = [readQueuedEntry(tmpDir(), id), readQueuedEntry(tmpDir(), unknownId)];
      const deliver = vi
        .fn<DeliverFn>()
        .mockResolvedValue([{ channel: "demo", messageId: "sent" }]);
      const run = () => {
        const params = { cfg: {}, stateDir: tmpDir(), log: createRecoveryLog(), deliver };
        return mode === "startup"
          ? recoverPendingDeliveries(params)
          : drainPendingDeliveriesCore({
              ...params,
              drainKey: "deferral-test",
              logLabel: "deferral-test",
              selectEntry: () => ({ match: true, bypassBackoff: true }),
            });
      };
      for (let attempt = 0; attempt < 7; attempt++) {
        closeOpenClawStateDatabaseForTest();
        const summary = await run();
        if (mode === "startup") {
          expect(summary).toEqual({
            recovered: 0,
            failed: 0,
            skippedMaxRetries: 0,
            deferredBackoff: 2,
          });
        }
        expect([readQueuedEntry(tmpDir(), id), readQueuedEntry(tmpDir(), unknownId)]).toEqual(
          before,
        );
        expect(await loadPendingDeliveries(tmpDir())).toHaveLength(2);
      }
      expect(deliver).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(admit).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "recovery", supportsRecoveryDeferral: true }),
      );

      paused = false;
      await run();
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
      await run();
      expect(deliver).toHaveBeenCalledTimes(2);
    },
  );

  it("honors current permanent rejection after a pause without dispatching", async () => {
    let paused = true;
    resolveAdapter.mockReturnValue({
      durableFinal: {
        admitDeferredDelivery: () =>
          paused
            ? { status: "deferred", reason: "provider cooldown" }
            : { status: "permanent_rejection", reason: "account revoked" },
      },
    });
    await enqueueDelivery(
      { channel: "demo", to: "recipient", payloads: [{ text: "original" }] },
      tmpDir(),
    );
    const deliver = vi.fn<DeliverFn>();
    const params = { cfg: {}, stateDir: tmpDir(), log: createRecoveryLog(), deliver };
    await recoverPendingDeliveries(params);
    expect(await loadPendingDeliveries(tmpDir())).toHaveLength(1);
    paused = false;
    closeOpenClawStateDatabaseForTest();
    const result = await recoverPendingDeliveries(params);
    expect(result.failed).toBe(1);
    expect(await loadPendingDeliveries(tmpDir())).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });
});
