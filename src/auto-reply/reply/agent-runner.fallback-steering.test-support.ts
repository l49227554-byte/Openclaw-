import { expect, it, vi, type Mock } from "vitest";
import { enqueueFollowupRun, type FollowupRun } from "./queue.js";
import {
  createReplyOperation,
  replyRunRegistry,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

type FallbackSteeringFixture = {
  createMinimalRun: (params: {
    isActive: boolean;
    shouldSteer: boolean;
    resolvedQueueMode: string;
    bindActiveAuthority: boolean;
    attachSteerBackend?: boolean;
    runOverrides?: Partial<FollowupRun["run"]>;
  }) => { followupRun: FollowupRun; run: () => Promise<unknown> };
  state: { runEmbeddedAgentMock: Mock; queueEmbeddedAgentMessageMock: Mock };
  parkedSteer: { fallback: Mock; admit: Mock<() => Promise<"steer">> };
};

export function defineFallbackSteeringTests({
  createMinimalRun,
  state,
  parkedSteer,
}: FallbackSteeringFixture) {
  function createFallbackRun(
    options: Partial<Parameters<FallbackSteeringFixture["createMinimalRun"]>[0]> = {},
    fallback = "established",
  ) {
    const fixture = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      bindActiveAuthority: false,
      ...options,
    });
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    const route = { provider: "fallback-provider", model: "fallback-model" };
    active.bindToolAuthoritySnapshot(prepareReplyToolAuthority(fixture.followupRun));
    if (fallback !== "unproven") {
      active.setAutomaticFallbackRoute({
        ...route,
        model: fallback === "stale" ? "old-fallback" : route.model,
      });
    }
    active.bindToolAuthorityRoute(route);
    active.setPhase("running");
    return { ...fixture, active, route };
  }

  it.each([
    { withImage: false, fallback: "established" },
    { withImage: true, fallback: "established" },
    { withImage: false, fallback: "unproven" },
    { withImage: false, fallback: "stale" },
  ])(
    "steers unchanged selected route only with established fallback (images=$withImage, fallback=$fallback)",
    async ({ withImage, fallback }) => {
      const { followupRun, run, active } = createFallbackRun(
        { attachSteerBackend: false },
        fallback,
      );
      const consumed: string[] = [];
      const queueMessage = vi.fn(async (text: string) => {
        consumed.push(text);
      });
      active.attachBackend({
        kind: "embedded",
        runId: "already-running-fallback",
        cancel: vi.fn(),
        supportsQueueMessageImages: true,
        messageInjection: { isAvailable: () => true, queueMessage },
      });
      if (withImage) {
        followupRun.images = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
      }
      await run();
      if (fallback !== "established") {
        expect(consumed).toEqual([]);
        expect(parkedSteer.fallback).toHaveBeenCalledOnce();
        active.complete();
        return;
      }
      expect(consumed).toEqual(["hello"]);
      expect(queueMessage).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          toolAuthorityFingerprint: active.toolAuthorityFingerprint,
          ...(withImage ? { images: followupRun.images } : {}),
        }),
      );
      expect(replyRunRegistry.get("main")).toBe(active);
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(parkedSteer.fallback).not.toHaveBeenCalled();
      active.complete();
    },
  );

  it.each(["other-model", "fallback-model"])(
    "queues an explicit selected-model change to %s during fallback",
    async (model) => {
      const { followupRun, run, active } = createFallbackRun();
      followupRun.run.provider = "fallback-provider";
      followupRun.run.model = model;
      await run();
      expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
      active.complete();
    },
  );

  it.each(["allowlist", "permission", "sender", "binding", "policy"])(
    "does not project a real %s change into the fallback owner",
    async (change) => {
      const { followupRun, run, active } = createFallbackRun({
        runOverrides: {
          senderIsOwner: true,
          clientCaps: ["ui-commands"],
          gatewayUiCommandTarget: { connId: "browser", profileId: "profile" },
        },
      });
      if (change === "allowlist") {
        followupRun.toolsAllow = ["read"];
      }
      if (change === "permission") {
        followupRun.run.permissionMode = "guarded";
      }
      if (change === "sender") {
        followupRun.run.senderIsOwner = false;
      }
      if (change === "binding") {
        followupRun.run.toolBindings = { browser: { clientId: "other" } };
      }
      if (change === "policy") {
        followupRun.run.config = { tools: { deny: ["exec"] } };
      }
      await run();
      expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueFollowupRun)).toHaveBeenCalledOnce();
      active.complete();
    },
  );

  it("does not retarget fallback steering when its captured owner is replaced during admission", async () => {
    const { followupRun, run, active } = createFallbackRun();
    const successorQueue = vi.fn(async () => {});
    let successor: ReplyOperation | undefined;
    parkedSteer.admit.mockImplementationOnce(async () => {
      active.complete();
      successor = createReplyOperation({
        sessionKey: "main",
        sessionId: "successor",
        resetTriggered: false,
      });
      successor.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
      successor.bindToolAuthorityRoute({ provider: "fallback-provider", model: "fallback-model" });
      successor.setPhase("running");
      successor.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        messageInjection: { isAvailable: () => true, queueMessage: successorQueue },
      });
      return "steer";
    });
    await run();
    expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
    expect(successorQueue).not.toHaveBeenCalled();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    successor?.complete();
  });

  it("keeps fallback authority bound to its owner across the question-input await", async () => {
    const { followupRun, run, active } = createFallbackRun();
    let successor: ReplyOperation | undefined;
    const successorQueue = vi.fn(async () => {});
    const questionInput = await import("./agent-runner-question-input.js");
    const questionSpy = vi
      .spyOn(questionInput, "runReplyQuestionInput")
      .mockImplementationOnce(async () => {
        active.complete();
        successor = createReplyOperation({
          sessionKey: "main",
          sessionId: "successor",
          resetTriggered: false,
        });
        successor.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
        successor.bindToolAuthorityRoute({
          provider: "fallback-provider",
          model: "fallback-model",
        });
        successor.setPhase("running");
        successor.attachBackend({
          kind: "embedded",
          cancel: vi.fn(),
          messageInjection: { isAvailable: () => true, queueMessage: successorQueue },
        });
        return { handled: false };
      });
    try {
      await run();
      expect(successorQueue).not.toHaveBeenCalled();
      expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    } finally {
      questionSpy.mockRestore();
      active.complete();
      successor?.complete();
    }
  });

  it.each(["question", "admission"])(
    "invalidates same-owner promotion after the %s await even with equal backend authority",
    async (awaitPoint) => {
      const { run, active, route } = createFallbackRun();
      const fingerprint = active.toolAuthorityFingerprint;
      const replaceAttempt = () => {
        active.setAutomaticFallbackRoute(undefined);
        active.setAutomaticFallbackRoute(route);
        expect(active.toolAuthorityFingerprint).toBe(fingerprint);
      };
      const questionInput = await import("./agent-runner-question-input.js");
      const spy =
        awaitPoint === "question"
          ? vi.spyOn(questionInput, "runReplyQuestionInput").mockImplementationOnce(async () => {
              replaceAttempt();
              return { handled: false };
            })
          : undefined;
      if (awaitPoint === "admission") {
        parkedSteer.admit.mockImplementationOnce(async () => {
          replaceAttempt();
          return "steer";
        });
      }
      try {
        await run();
        expect(state.queueEmbeddedAgentMessageMock).not.toHaveBeenCalled();
        expect(parkedSteer.fallback).toHaveBeenCalledOnce();
      } finally {
        spy?.mockRestore();
        active.complete();
      }
    },
  );
  it("offers a route-only mismatch to the pending-input owner", async () => {
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const activeRoute = { provider: "openai", model: "gpt-fallback" };
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      bindActiveAuthority: false,
    });
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
    active.bindToolAuthorityRoute(activeRoute);
    active.setPhase("running");

    await expect(run()).resolves.toBeUndefined();

    expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledWith(
      "session",
      "hello",
      expect.objectContaining({
        pendingInputAuthorityFingerprint: active.toolAuthorityFingerprint,
      }),
    );
    expect(vi.mocked(enqueueFollowupRun)).not.toHaveBeenCalled();
    active.complete();
  });
}
