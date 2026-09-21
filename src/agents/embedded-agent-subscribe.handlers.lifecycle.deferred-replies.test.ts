import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { handleAgentEnd } from "./embedded-agent-subscribe.handlers.lifecycle.js";
import { createContext } from "./embedded-agent-subscribe.handlers.lifecycle.test-support.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";

const { emitAgentEventMock } = vi.hoisted(() => ({
  emitAgentEventMock: vi.fn(),
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: emitAgentEventMock,
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

describe("handleAgentEnd deferred replies", () => {
  it("keeps synchronous terminal delivery synchronous and emits once", () => {
    emitAgentEventMock.mockClear();
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });

    expect(handleAgentEnd(ctx)).toBeUndefined();
    expect(ctx.releaseDeferredReplies).toHaveBeenCalledTimes(1);
    expect(ctx.flushBlockReplyBuffer).toHaveBeenNthCalledWith(1, { final: true });
    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "settles deferred replies without crossing delivery generations (invalidated: %s)",
    async (invalidated) => {
      emitAgentEventMock.mockClear();
      const first = createDeferred();
      const second = createDeferred();
      const onBlockReply = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const onAgentEvent = vi.fn();
      const ctx = createContext(undefined, { onAgentEvent });
      ctx.params.onBlockReply = onBlockReply;
      ctx.state.assistantTexts = [];
      ctx.state.visibleBlockReplyCount = 0;
      ctx.state.pendingCompactionRetry = 1;
      ctx.state.deferredBlockReplies = [{ text: "First answer." }, { text: "Second answer." }];
      const delivery = createReplyDelivery({ params: ctx.params, state: ctx.state, log: ctx.log });
      ctx.releaseDeferredReplies = delivery.releaseDeferredReplies;
      ctx.getBlockReplyDeliveryGeneration = delivery.getBlockReplyDeliveryGeneration;
      const completed = vi.fn();
      const endPromise = Promise.resolve(
        handleAgentEnd(ctx, undefined, { deliveryGeneration: 0 }),
      ).then(completed);

      try {
        expect(onBlockReply).toHaveBeenCalledTimes(1);
        expect(ctx.flushBlockReplyBuffer).not.toHaveBeenCalled();
        expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();
        expect(onAgentEvent).not.toHaveBeenCalled();
        if (invalidated) {
          delivery.invalidateBlockReplyDeliveries();
          delivery.emitBlockReply({ text: "Replacement answer." });
        }
        first.resolve();
        if (invalidated) {
          await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
          expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
            "First answer.",
            "Replacement answer.",
          ]);
          expect(ctx.flushBlockReplyBuffer).not.toHaveBeenCalled();
          expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();
          expect(ctx.state.blockState.thinking).toBe(true);
          expect(onAgentEvent).not.toHaveBeenCalled();
          expect(emitAgentEventMock).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledTimes(2));
          expect(onBlockReply.mock.calls[1]?.[0]).toMatchObject({ text: "Second answer." });
          expect(ctx.flushBlockReplyBuffer).not.toHaveBeenCalled();
          expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();
          expect(onAgentEvent).not.toHaveBeenCalled();
          second.resolve();
          await endPromise;
          expect(ctx.flushBlockReplyBuffer).toHaveBeenNthCalledWith(1, { final: true });
          expect(ctx.resolveCompactionRetry).toHaveBeenCalledExactlyOnceWith(0);
          expect(onAgentEvent).toHaveBeenCalledTimes(1);
          expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
        }
      } finally {
        first.resolve();
        second.resolve();
        await endPromise;
      }
    },
  );

  it.each([false, true])(
    "preserves a release error after exactly one async terminal emission (sync throw: %s)",
    async (syncThrow) => {
      emitAgentEventMock.mockClear();
      const failure = new Error("deferred release failed");
      const terminal = createDeferred();
      const onAgentEvent = vi.fn();
      const onBeforeLifecycleTerminal = vi.fn(() => terminal.promise);
      const ctx = createContext(undefined, { onAgentEvent, onBeforeLifecycleTerminal });
      ctx.releaseDeferredReplies = () => {
        if (syncThrow) {
          throw failure;
        }
        return Promise.reject(failure);
      };

      const rejected = expect(handleAgentEnd(ctx)).rejects.toBe(failure);
      await vi.waitFor(() => expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1));
      expect(onAgentEvent).not.toHaveBeenCalled();
      terminal.reject(new Error("secondary terminal hook failure"));
      await rejected;
      expect(ctx.flushBlockReplyBuffer).not.toHaveBeenCalled();
      expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
      expect(onAgentEvent).toHaveBeenCalledTimes(1);
      expect(emitAgentEventMock).toHaveBeenCalledTimes(1);
    },
  );

  it("propagates a stale release rejection without emitting a terminal", async () => {
    emitAgentEventMock.mockClear();
    const release = createDeferred();
    const failure = new Error("stale release failed");
    const onAgentEvent = vi.fn();
    const onBeforeLifecycleTerminal = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent, onBeforeLifecycleTerminal });
    const generation = vi.fn().mockReturnValue(0);
    ctx.getBlockReplyDeliveryGeneration = generation;
    ctx.releaseDeferredReplies = () => release.promise;

    const rejected = expect(handleAgentEnd(ctx, undefined, { deliveryGeneration: 0 })).rejects.toBe(
      failure,
    );
    generation.mockReturnValue(1);
    release.reject(failure);
    await rejected;
    expect(ctx.flushBlockReplyBuffer).not.toHaveBeenCalled();
    expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    expect(onBeforeLifecycleTerminal).not.toHaveBeenCalled();
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });

  it("rechecks generation after awaiting the before-lifecycle hook", async () => {
    emitAgentEventMock.mockClear();
    const terminal = createDeferred();
    const onAgentEvent = vi.fn();
    const onBeforeLifecycleTerminal = vi.fn(() => terminal.promise);
    const ctx = createContext(undefined, { onAgentEvent, onBeforeLifecycleTerminal });
    const generation = vi.fn().mockReturnValue(0);
    ctx.getBlockReplyDeliveryGeneration = generation;

    const endPromise = handleAgentEnd(ctx, undefined, { deliveryGeneration: 0 });
    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    generation.mockReturnValue(1);
    terminal.resolve();
    await endPromise;
    expect(onAgentEvent).not.toHaveBeenCalled();
    expect(emitAgentEventMock).not.toHaveBeenCalled();
  });
});
