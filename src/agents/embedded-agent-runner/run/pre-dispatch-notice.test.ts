import { describe, expect, it, vi } from "vitest";
import { deliverPreDispatchNotice } from "./pre-dispatch-notice.js";

describe("pre-dispatch notice delivery", () => {
  it("uses the existing block-reply callback and deduplicates a run", async () => {
    const onBlockReply = vi.fn(async () => {});
    const onBlockReplyFlush = vi.fn(async () => {});
    const first = await deliverPreDispatchNotice({
      notice: { text: "Auto router: dispatching Astra Medium." },
      runId: "notice-test-session:first",
      onBlockReply,
      onBlockReplyFlush,
    });
    const second = await deliverPreDispatchNotice({
      notice: { text: "duplicate" },
      runId: "notice-test-session:first",
      onBlockReply,
    });

    expect(first).toBe("delivered");
    expect(second).toBe("skipped");
    expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
      text: "Auto router: dispatching Astra Medium.",
      isStatusNotice: true,
    });
    expect(onBlockReplyFlush).toHaveBeenCalledExactlyOnceWith({ reason: "message_end" });
  });

  it("does not claim or emit a notice when the host has no delivery callback", async () => {
    const runId = "notice-test-session:no-callback";
    await expect(deliverPreDispatchNotice({ notice: { text: "unwired" }, runId })).resolves.toBe(
      "skipped",
    );

    const onBlockReply = vi.fn();
    await expect(
      deliverPreDispatchNotice({ notice: { text: "retry" }, runId, onBlockReply }),
    ).resolves.toBe("delivered");
    expect(onBlockReply).toHaveBeenCalledOnce();
  });

  it("lets a durable host renderer own the notice without duplicating block delivery", async () => {
    const onPreDispatchNotice = vi.fn(async () => true);
    const onBlockReply = vi.fn(async () => {});
    const onBlockReplyFlush = vi.fn(async () => {});

    await expect(
      deliverPreDispatchNotice({
        notice: { text: "Auto router: dispatching Luna Max." },
        runId: "notice-test-session:durable-host",
        onPreDispatchNotice,
        onBlockReply,
        onBlockReplyFlush,
      }),
    ).resolves.toBe("delivered");

    expect(onPreDispatchNotice).toHaveBeenCalledExactlyOnceWith({
      text: "Auto router: dispatching Luna Max.",
      isStatusNotice: true,
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onBlockReplyFlush).not.toHaveBeenCalled();
  });

  it("still uses block delivery when the host renderer declines ownership", async () => {
    const onPreDispatchNotice = vi.fn(async () => false);
    const onBlockReply = vi.fn(async () => {});

    await expect(
      deliverPreDispatchNotice({
        notice: { text: "Auto router: dispatching Sol Medium." },
        runId: "notice-test-session:host-declined",
        onPreDispatchNotice,
        onBlockReply,
      }),
    ).resolves.toBe("delivered");

    expect(onPreDispatchNotice).toHaveBeenCalledOnce();
    expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
      text: "Auto router: dispatching Sol Medium.",
      isStatusNotice: true,
    });
  });

  it.each([
    ["declines", false],
    ["throws", true],
  ] as const)(
    "starts the fallback timeout after the durable renderer %s",
    async (_outcome, throws) => {
      vi.useFakeTimers();
      try {
        let resolveDurable: ((handled: boolean) => void) | undefined;
        const onPreDispatchNotice = vi.fn(() =>
          throws
            ? Promise.reject(new Error("durable renderer unavailable"))
            : new Promise<boolean>((resolve) => {
                resolveDurable = resolve;
              }),
        );
        const onBlockReply = vi.fn(() => new Promise<void>(() => {}));
        let settled = false;
        const pending = deliverPreDispatchNotice({
          notice: { text: "fallback budget" },
          runId: `notice-test-session:fallback-${_outcome}`,
          onPreDispatchNotice,
          onBlockReply,
          callbackTimeoutMs: 25,
        });
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        expect(onPreDispatchNotice).toHaveBeenCalledOnce();
        if (throws) {
          await vi.advanceTimersByTimeAsync(0);
        } else {
          await vi.advanceTimersByTimeAsync(100);
          expect(onBlockReply).not.toHaveBeenCalled();
          resolveDurable?.(false);
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(onBlockReply).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(24);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toBe("failed");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("fails open after a bounded callback wait and deduplicates a late success", async () => {
    let resolveCallback: (() => void) | undefined;
    const onBlockReply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCallback = resolve;
        }),
    );
    const runId = "notice-test-session:late-callback";
    await expect(
      deliverPreDispatchNotice({
        notice: { text: "bounded" },
        runId,
        onBlockReply,
        callbackTimeoutMs: 1,
      }),
    ).resolves.toBe("failed");

    resolveCallback?.();
    await Promise.resolve();
    await expect(
      deliverPreDispatchNotice({ notice: { text: "duplicate" }, runId, onBlockReply }),
    ).resolves.toBe("skipped");
    expect(onBlockReply).toHaveBeenCalledOnce();
  });

  it("propagates cancellation while a callback is waiting", async () => {
    const controller = new AbortController();
    const runId = "notice-test-session:aborted";
    const pending = deliverPreDispatchNotice({
      notice: { text: "cancel me" },
      runId,
      signal: controller.signal,
      onBlockReply: () => new Promise<void>(() => {}),
      callbackTimeoutMs: 5_000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not invoke the host callback when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const onBlockReply = vi.fn();

    await expect(
      deliverPreDispatchNotice({
        notice: { text: "already canceled" },
        runId: "notice-test-session:pre-aborted",
        signal: controller.signal,
        onBlockReply,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(onBlockReply).not.toHaveBeenCalled();
  });
});
