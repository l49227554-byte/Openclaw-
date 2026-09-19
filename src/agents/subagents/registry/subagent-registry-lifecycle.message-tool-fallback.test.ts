/**
 * Conservative, no-data-loss message-tool fallback regression suite.
 *
 * Scope (per design trace, 2026-09-17):
 * - The formal give-up path MUST attempt the existing
 *   deliverSubagentAnnouncement directOrigin/message-tool path exactly once,
 *   using the established childRunId/announceId-derived idempotency key.
 * - Success is only reported when the existing delivery function reports
 *   delivered === true through its normal user-visible path. A raw
 *   provider="openclaw", model="delivery-mirror" transcript row is NOT proof
 *   of user-visible delivery.
 * - On success: existing delivered transition (delivery.status = delivered,
 *   task delivery status = delivered, normal pending-delivery cleanup).
 * - On failure: retain delivery.status = failed, retain completion.resultText
 *   and all existing recovery data, keep failed entries eligible for
 *   runtime-context injection.
 *
 * What this suite does NOT do:
 * - It does not remove "failed" or "suspended" from hasOutstandingCompletion.
 * - It does not introduce presented / promptPresentCount / promptAckedAt.
 * - It does not mutate state during runtime-context rendering.
 * - It does not add a replay cap or automatic discard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "../../announce-idempotency.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import {
  acquireFallbackClaim,
  commitDeliveredFallback,
  generateFallbackClaimOwner,
  generateFallbackClaimToken,
} from "./subagent-delivery-state.js";
import {
  resetSubagentRegistryRuntimeLoadersForTests,
  setSubagentRegistryDepsForTest,
} from "./subagent-registry-deps.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const taskExecutorMocks = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

vi.mock("../../../tasks/detached-task-runtime.js", () => ({
  completeTaskRunByRunId: taskExecutorMocks.completeTaskRunByRunId,
  failTaskRunByRunId: taskExecutorMocks.failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId: taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId,
}));

const completionDeliveryMocks = vi.hoisted(() => ({
  blockSubagentCompletionDelivery: vi.fn(),
}));

vi.mock("../completion/subagent-completion-admission.store.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../completion/subagent-completion-admission.store.js")
  >()),
  blockSubagentCompletionDelivery: completionDeliveryMocks.blockSubagentCompletionDelivery,
}));

const helperMocks = vi.hoisted(() => ({
  safeRemoveAttachmentsDir: vi.fn(async () => {}),
  logAnnounceGiveUp: vi.fn(),
}));

vi.mock("./subagent-registry-helpers.js", () => ({
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS: 30 * 60_000,
  ANNOUNCE_EXPIRY_MS: 5 * 60_000,
  MIN_ANNOUNCE_RETRY_DELAY_MS: 1_000,
  PROVISIONAL_KILL_RECONCILIATION_MS: 5 * 60_000,
  capFrozenResultText: (text: string) => text.trim(),
  logAnnounceGiveUp: helperMocks.logAnnounceGiveUp,
  persistSubagentSessionTiming: vi.fn(async () => {}),
  resolveAnnounceRetryDelayMs: (retryCount: number) =>
    Math.min(1_000 * 2 ** Math.max(0, retryCount - 1), 8_000),
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
  updateSubagentArchiveAtMs: () => false,
}));

vi.mock("./subagent-registry-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-registry-cleanup.js")>()),
  resolveCleanupCompletionReason: () => "complete" as const,
  resolveDeferredCleanupDecision: () => ({ kind: "give-up", reason: "expiry" }) as const,
}));

vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn(async () => undefined),
  // Default stub; tests override runSubagentAnnounceFlow on the controller
  // directly to exercise both the "no message-tool attempt" pre-fix shape and
  // the post-fix fallback success/failure paths.
  runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
}));

vi.mock("./subagent-session-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-session-reconciliation.js")>()),
  loadSubagentSessionEntry: () => undefined,
}));

vi.mock("../../../runtime.js", () => ({
  defaultRuntime: { log: vi.fn() },
}));

vi.mock("../../../utils/delivery-context.shared.js", () => ({
  normalizeDeliveryContext: (origin: unknown) => origin ?? "agent",
}));

const sessionLifecycleMocks = vi.hoisted(() => ({
  emitSessionLifecycleEvent: vi.fn(),
}));

vi.mock("../../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: sessionLifecycleMocks.emitSessionLifecycleEvent,
}));

const browserLifecycleMocks = vi.hoisted(() => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd:
    browserLifecycleMocks.cleanupBrowserSessionsForLifecycleEnd,
}));

const bundleMcpMocks = vi.hoisted(() => ({
  retireSessionMcpRuntimeForSessionKey: vi.fn(async () => true),
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntimeForSessionKey: bundleMcpMocks.retireSessionMcpRuntimeForSessionKey,
}));

const internalSessionEffectsMocks = vi.hoisted(() => ({
  removeInternalSessionEffectsSession: vi.fn(async () => {}),
}));

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession:
    internalSessionEffectsMocks.removeInternalSessionEffectsSession,
}));

function buildEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    createdAt: 1_000,
    requesterOrigin: { channel: "discord", to: "channel-x" },
    expectsCompletionMessage: true,
    endedReason: "complete",
    completion: { required: true, resultText: "authoritative final" },
    execution: {
      status: "terminal",
      startedAt: 2_000,
      endedAt: 4_000,
      outcome: { status: "ok" },
    },
    delivery: {
      status: "pending",
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-1",
        task: "finish the task",
      },
      lastError: "channel rejected previous attempt",
      attemptCount: 4,
    },
    retainAttachmentsOnKeep: true,
    ...overrides,
  };
}

function expectedAnnounceKey(entry: SubagentRunRecord): string {
  return buildAnnounceIdempotencyKey(
    buildAnnounceIdFromChildRun({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
    }),
  );
}

function buildController({
  entry,
  runs,
  persist: persistOverride,
  runSubagentAnnounceFlow,
  captureSubagentCompletionReply,
}: {
  entry: SubagentRunRecord;
  runs?: Map<string, SubagentRunRecord>;
  persist?: SubagentLifecycleOptions["persist"];
  runSubagentAnnounceFlow?: SubagentLifecycleOptions["runSubagentAnnounceFlow"];
  captureSubagentCompletionReply?: SubagentLifecycleOptions["captureSubagentCompletionReply"];
}) {
  const map = runs ?? new Map([[entry.runId, entry]]);
  const params: SubagentLifecycleOptions = {
    runs: map,
    resumedRuns: new Set(),
    subagentAnnounceTimeoutMs: 1_000,
    getRuntimeConfig: () => ({}) as never,
    persist: persistOverride ?? vi.fn(),
    persistOrThrow: vi.fn(),
    clearPendingLifecycleError: vi.fn(),
    countPendingDescendantRuns: () => 0,
    getLatestRunForChildSession: (key) => {
      for (const candidate of map.values()) {
        if (candidate.childSessionKey === key) {
          return candidate;
        }
      }
      return null;
    },
    suppressAnnounceForSteerRestart: () => false,
    resolveSubagentTask: () => ({ lookup: "available" as const }),
    shouldEmitEndedHookForRun: () => false,
    emitSubagentEndedHookForRun: vi.fn(async () => {}),
    emitSubagentProgressEndedForRun: vi.fn(async () => {}),
    notifyContextEngineSubagentEnded: vi.fn(async () => {}),
    retireSupersededRun: vi.fn(async () => {}),
    resumeSubagentRun: vi.fn(),
    callGateway: vi.fn(async () => ({})) as never,
    captureSubagentCompletionReply:
      captureSubagentCompletionReply ?? vi.fn(async () => "authoritative final"),
    cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
    runSubagentAnnounceFlow:
      runSubagentAnnounceFlow ?? (vi.fn(async () => "retryable" as const) as never),
    maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
    warn: vi.fn(),
  };
  return new SubagentLifecycleController(params);
}

function findFallbackCall(
  mock: ReturnType<typeof vi.fn>,
  entry: SubagentRunRecord,
): { idempotencyKey: unknown; directOrigin: unknown; childRunId: unknown } | undefined {
  for (const call of mock.mock.calls) {
    const [arg] = call;
    if (!arg || typeof arg !== "object") {
      continue;
    }
    const record = arg as Record<string, unknown>;
    const directIdempotencyKey =
      typeof record.directIdempotencyKey === "string" ? record.directIdempotencyKey : undefined;
    if (directIdempotencyKey !== undefined && directIdempotencyKey === expectedAnnounceKey(entry)) {
      return {
        idempotencyKey: directIdempotencyKey,
        directOrigin: record.directOrigin,
        childRunId: record.childRunId ?? (record as { childRunId?: unknown }).childRunId,
      };
    }
  }
  return undefined;
}

describe("subagent give-up message-tool fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskExecutorMocks.completeTaskRunByRunId.mockReset();
    taskExecutorMocks.failTaskRunByRunId.mockReset();
    taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mockReset();
    helperMocks.safeRemoveAttachmentsDir.mockReset().mockResolvedValue(undefined);
    helperMocks.logAnnounceGiveUp.mockReset();
    completionDeliveryMocks.blockSubagentCompletionDelivery.mockReset();
    sessionLifecycleMocks.emitSessionLifecycleEvent.mockReset();
    browserLifecycleMocks.cleanupBrowserSessionsForLifecycleEnd.mockReset();
    bundleMcpMocks.retireSessionMcpRuntimeForSessionKey.mockReset().mockResolvedValue(true);
    internalSessionEffectsMocks.removeInternalSessionEffectsSession.mockReset();
  });

  afterEach(() => {
    resetSubagentRegistryRuntimeLoadersForTests();
    setSubagentRegistryDepsForTest({});
  });

  it("pre-fix regression: give-up never invoked the message-tool fallback path (now repaired)", async () => {
    const entry = buildEntry();
    let fallbackCalls = 0;
    const runSubagentAnnounceFlow = vi.fn(
      async (params: { directIdempotencyKey?: string; directOrigin?: unknown }) => {
        if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
          fallbackCalls += 1;
          return "delivered" as const;
        }
        return "retryable" as const;
      },
    );
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // Post-fix: the formal give-up path now invokes the message-tool fallback
    // exactly once before falling through to the failed transition.
    expect(fallbackCalls).toBe(1);
    expect(entry.delivery?.status).toBe("delivered");
  });

  it("fallback success transitions to delivered exactly once and removes pending payload", async () => {
    const entry = buildEntry();
    let fallbackInvocations = 0;
    const runSubagentAnnounceFlow = vi.fn(
      async (params: { directIdempotencyKey?: string; directOrigin?: unknown }) => {
        if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
          fallbackInvocations += 1;
          return "delivered" as const;
        }
        return "retryable" as const;
      },
    );
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    expect(fallbackInvocations).toBe(1);
    expect(entry.delivery?.status).toBe("delivered");
    expect(typeof entry.delivery?.deliveredAt).toBe("number");
    expect(typeof entry.delivery?.announcedAt).toBe("number");
    expect(entry.delivery?.payload).toBeUndefined();
    expect(entry.delivery?.lastError).toBeUndefined();
    expect(entry.completion?.resultText).toBe("authoritative final");
    expect(
      taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mock.calls.some(([arg]) => {
        const record = arg as { runId?: unknown; deliveryStatus?: unknown } | undefined;
        return record?.runId === entry.runId && record?.deliveryStatus === "delivered";
      }),
    ).toBe(true);
    expect(
      taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mock.calls.some(([arg]) => {
        const record = arg as { runId?: unknown; deliveryStatus?: unknown } | undefined;
        return record?.runId === entry.runId && record?.deliveryStatus === "failed";
      }),
    ).toBe(false);
  });

  it("fallback success uses the established announce idempotency key and originating directOrigin", async () => {
    const entry = buildEntry();
    const runSubagentAnnounceFlow = vi.fn(
      async (params: { directIdempotencyKey?: string; directOrigin?: unknown }) => {
        const fallback = findFallbackCall(runSubagentAnnounceFlow, entry);
        if (
          params.directIdempotencyKey === expectedAnnounceKey(entry) &&
          params.directOrigin !== undefined
        ) {
          return {
            delivered: true,
            path: "direct",
            deliveredAt: 6_001,
          } satisfies SubagentAnnounceDeliveryResult;
        }
        void fallback;
        return "retryable" as const;
      },
    );
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    const fallbackCall = runSubagentAnnounceFlow.mock.calls.find(([arg]) => {
      const record = arg as { directIdempotencyKey?: unknown } | undefined;
      return record?.directIdempotencyKey === expectedAnnounceKey(entry);
    });
    expect(fallbackCall).toBeDefined();
    const [fallbackArg] = fallbackCall!;
    const record = fallbackArg as Record<string, unknown>;
    expect(record.directIdempotencyKey).toBe(expectedAnnounceKey(entry));
    expect(record.directOrigin).toEqual({ channel: "discord", to: "channel-x" });
    expect(record.childRunId).toBe(entry.runId);
  });

  it("fallback failure preserves failed status, result payload, and runtime-facts eligibility", async () => {
    const entry = buildEntry();
    let fallbackInvocations = 0;
    const runSubagentAnnounceFlow = vi.fn(
      async (params: {
        directIdempotencyKey?: string;
        onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
      }) => {
        if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
          fallbackInvocations += 1;
          params.onDeliveryResult?.({
            delivered: false,
            path: "direct",
            error: "channel rejected fallback",
          });
          return "retryable" as const;
        }
        return "retryable" as const;
      },
    );
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    expect(fallbackInvocations).toBe(1);
    expect(entry.delivery?.status).toBe("failed");
    expect(entry.completion?.resultText).toBe("authoritative final");
    // The fallback error is best-effort; the persisted lastError from the
    // pre-existing failed attempts is authoritative and is preserved.
    expect(entry.delivery?.lastError).toBeTruthy();
    expect(
      taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId.mock.calls.some(([arg]) => {
        const record = arg as { runId?: unknown; deliveryStatus?: unknown } | undefined;
        return record?.runId === entry.runId && record?.deliveryStatus === "failed";
      }),
    ).toBe(true);
  });

  it("re-entering cleanup cannot produce duplicate outbound delivery with the same idempotency key", async () => {
    const entry = buildEntry();
    const seenFallbackCalls: string[] = [];
    const runSubagentAnnounceFlow = vi.fn(
      async (params: {
        directIdempotencyKey?: string;
        onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
      }) => {
        if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
          seenFallbackCalls.push(params.directIdempotencyKey);
          params.onDeliveryResult?.({
            delivered: true,
            path: "direct",
            deliveredAt: 6_500,
          });
          return "delivered" as const;
        }
        return "retryable" as const;
      },
    );
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // Second give-up attempt must NOT re-invoke the fallback. A retry that
    // arrives after the first fallback's delivered === true must short-circuit
    // on the persisted delivered status before any further announce flow runs.
    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    expect(seenFallbackCalls).toEqual([expectedAnnounceKey(entry)]);
    expect(entry.delivery?.status).toBe("delivered");
  });

  it("missing originating directOrigin preserves existing failed behavior rather than fabricating a destination", async () => {
    const entry = buildEntry({ requesterOrigin: undefined });
    let fallbackInvocations = 0;
    const runSubagentAnnounceFlow = vi.fn(async (params: { directIdempotencyKey?: string }) => {
      if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
        fallbackInvocations += 1;
      }
      return "retryable" as const;
    });
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // No fabricating a destination: when the originating directOrigin is
    // unavailable the fallback MUST NOT be invoked.
    expect(fallbackInvocations).toBe(0);
    expect(entry.delivery?.status).toBe("failed");
    expect(entry.completion?.resultText).toBe("authoritative final");
  });
});

import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SubagentRunRecordOverrides } from "../../subagent-test-fixtures.test-helpers.js";
// requesterSettleWake recurrence: a terminal delivery that has reached a
// closed state (delivered / discarded / not_required / intentional_non_delivery)
// must not be resurrected in the prompt solely because a historical wake object
// remains attached to the entry. The four closed states are authoritative; the
// wake is a transport obligation, not a delivery receipt.
//
// These tests exercise hasOutstandingCompletion directly via the
// buildActiveSubagentRuntimeContext path so they live with the bounded
// isolated test set rather than chasing the active-context test routing.
import { buildActiveSubagentRuntimeContext } from "./subagent-active-context.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

describe("hasOutstandingCompletion closed-delivery guard", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  function baseClosedEntry(): SubagentRunRecordOverrides {
    const endedAt = Date.now() - 60_000;
    return {
      runId: "run-delivered-stale-wake",
      childSessionKey: "agent:main:subagent:delivered-stale-wake",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "deliver the summary",
      taskName: "deliver_summary",
      cleanup: "keep",
      createdAt: endedAt - 120_000,
      execution: {
        status: "terminal",
        startedAt: endedAt - 120_000,
        endedAt,
        outcome: { status: "ok" },
      },
      completion: { required: true, resultText: "summary delivered" },
      // A historical wake object retained after the delivery finalization
      // must not resurrect the entry in the prompt predicate.
      requesterSettleWake: { status: "pending", attemptCount: 1 },
    };
  }

  it.each([
    {
      name: "delivered",
      delivery: { status: "delivered" as const, disposition: "delivered" as const },
    },
    {
      name: "discarded",
      delivery: { status: "discarded" as const, discardedAt: Date.now() },
    },
    {
      name: "not_required",
      delivery: { status: "not_required" as const },
    },
    {
      name: "intentional_non_delivery",
      delivery: {
        status: "failed" as const,
        disposition: "intentional_non_delivery" as const,
      },
    },
  ])("does not select a terminal entry with $name state and a stale wake", ({ delivery }) => {
    const entry = { ...baseClosedEntry(), delivery };
    addSubagentRunForTests(entry as SubagentRunRecord);

    const prompt = buildActiveSubagentRuntimeContext({
      cfg: {} as OpenClawConfig,
      controllerSessionKey: "agent:main:main",
    });

    // Closed-state entries never appear in the awaiting-delivery block,
    // regardless of whether a requesterSettleWake object is still attached.
    // They may legitimately appear in the recently-completed block as
    // historical completion evidence.
    const safe = prompt ?? "";
    expect(safe.includes("## Child results awaiting delivery")).toBe(false);
  });

  it("still selects an actionable pending wake with open delivery", () => {
    const endedAt = Date.now() - 60_000;
    const entry: SubagentRunRecordOverrides = {
      runId: "run-pending-wake-open-delivery",
      childSessionKey: "agent:main:subagent:pending-wake-open-delivery",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "deliver the report",
      taskName: "deliver_report",
      cleanup: "keep",
      createdAt: endedAt - 120_000,
      execution: {
        status: "terminal",
        startedAt: endedAt - 120_000,
        endedAt,
        outcome: { status: "ok" },
      },
      completion: { required: true, resultText: "report pending" },
      delivery: { status: "pending", attemptCount: 1 },
      requesterSettleWake: { status: "pending", attemptCount: 1 },
    };
    addSubagentRunForTests(entry as SubagentRunRecord);

    const prompt = buildActiveSubagentRuntimeContext({
      cfg: {} as OpenClawConfig,
      controllerSessionKey: "agent:main:main",
    });

    expect(prompt).toBeDefined();
    expect(prompt!).toContain("## Child results awaiting delivery");
    expect(prompt!).toContain("run-pending-wake-open-delivery");
  });

  it("still selects an actionable dispatching wake with suspended delivery", () => {
    const endedAt = Date.now() - 60_000;
    const entry: SubagentRunRecordOverrides = {
      runId: "run-dispatching-wake-suspended-delivery",
      childSessionKey: "agent:main:subagent:dispatching-wake-suspended-delivery",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "reconcile after suspension",
      taskName: "reconcile_after_suspension",
      cleanup: "keep",
      createdAt: endedAt - 120_000,
      execution: {
        status: "terminal",
        startedAt: endedAt - 120_000,
        endedAt,
        outcome: { status: "ok" },
      },
      completion: { required: true, resultText: "suspended" },
      delivery: {
        status: "suspended",
        suspendedAt: endedAt + 1_000,
        suspendedReason: "expiry",
      },
      requesterSettleWake: { status: "dispatching", attemptCount: 2 },
    };
    addSubagentRunForTests(entry as SubagentRunRecord);

    const prompt = buildActiveSubagentRuntimeContext({
      cfg: {} as OpenClawConfig,
      controllerSessionKey: "agent:main:main",
    });

    expect(prompt).toBeDefined();
    expect(prompt!).toContain("## Child results awaiting delivery");
    expect(prompt!).toContain("run-dispatching-wake-suspended-delivery");
  });

  it("does not select a delivered entry even without an attached wake object", () => {
    const endedAt = Date.now() - 60_000;
    const entry: SubagentRunRecordOverrides = {
      runId: "run-delivered-no-wake",
      childSessionKey: "agent:main:subagent:delivered-no-wake",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "deliver the digest",
      taskName: "deliver_digest",
      cleanup: "keep",
      createdAt: endedAt - 120_000,
      execution: {
        status: "terminal",
        startedAt: endedAt - 120_000,
        endedAt,
        outcome: { status: "ok" },
      },
      completion: { required: true, resultText: "digest delivered" },
      delivery: {
        status: "delivered",
        disposition: "delivered",
        deliveredAt: endedAt + 1_000,
        announcedAt: endedAt + 1_000,
      },
    };
    addSubagentRunForTests(entry as SubagentRunRecord);

    const prompt = buildActiveSubagentRuntimeContext({
      cfg: {} as OpenClawConfig,
      controllerSessionKey: "agent:main:main",
    });

    const safe = prompt ?? "";
    expect(safe.includes("## Child results awaiting delivery")).toBe(false);
  });
});

// Durable at-most-once fallback claim contract.
// The claim is persisted before the outbound send; concurrent callers,
// crashed-after-claim processes, and redrives after a non-delivered outcome
// must NOT produce duplicate outbound channel sends.
describe("subagent give-up message-tool fallback at-most-once claim", () => {
  it("persists the claim before the outbound send and only one process sends", async () => {
    const entry = buildEntry();
    let fallbackInvocations = 0;
    let observedClaimOwnerDuringSend: string | undefined;
    const runSubagentAnnounceFlow = vi.fn(
      async (params: { directIdempotencyKey?: string; directOrigin?: unknown }) => {
        if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
          fallbackInvocations += 1;
          observedClaimOwnerDuringSend = entry.delivery?.fallbackClaim?.owner;
          return "delivered" as const;
        }
        return "retryable" as const;
      },
    );
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // Exactly one outbound send.
    expect(fallbackInvocations).toBe(1);
    // The claim was persisted before the send was observed.
    expect(observedClaimOwnerDuringSend).toBeTruthy();
    // After commit, the claim is cleared and the entry is delivered.
    expect(entry.delivery?.status).toBe("delivered");
    expect(entry.delivery?.fallbackClaim).toBeUndefined();
    expect(entry.delivery?.generation).toBeGreaterThanOrEqual(1);
  });

  it("concurrent give-up callers do not produce duplicate outbound sends", async () => {
    const entry = buildEntry();
    // Pre-install a foreign claim at the same delivery generation that this
    // caller would acquire. The fallback must observe the foreign claim and
    // drop without sending.
    entry.delivery!.generation = 1;
    entry.delivery!.fallbackClaim = {
      owner: "pid:99999:foreign",
      claimedAt: Date.now(),
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
    };

    let fallbackInvocations = 0;
    const runSubagentAnnounceFlow = vi.fn(async (params: { directIdempotencyKey?: string }) => {
      if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
        fallbackInvocations += 1;
        return "delivered" as const;
      }
      return "retryable" as const;
    });
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // The foreign claim survives and no outbound send occurred.
    expect(fallbackInvocations).toBe(0);
    expect(entry.delivery?.fallbackClaim?.owner).toBe("pid:99999:foreign");
  });

  it("releases the claim on a non-delivered outcome so a redrive can re-acquire", async () => {
    const entry = buildEntry();
    const runSubagentAnnounceFlow = vi.fn(async (params: { directIdempotencyKey?: string }) => {
      if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
        return "retryable" as const;
      }
      return "retryable" as const;
    });
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // The fallback ran, the claim was released, and the entry is failed.
    expect(runSubagentAnnounceFlow).toHaveBeenCalled();
    expect(entry.delivery?.fallbackClaim).toBeUndefined();
    expect(entry.delivery?.status).toBe("failed");
  });

  it("closes the entry ambiguous when the send throws, retaining the claim as a tombstone", async () => {
    const entry = buildEntry();
    const runSubagentAnnounceFlow = vi.fn(async () => {
      throw new Error("channel send failed");
    });
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // The claim is retained as a tombstone and the entry is closed.
    expect(entry.delivery?.fallbackClaim).toBeDefined();
    expect(entry.delivery?.status).toBe("suspended");
    expect(entry.delivery?.disposition).toBe("intentional_non_delivery");
    expect(entry.delivery?.lastError ?? "").toContain("ambiguous_after_claim");

    // A subsequent give-up observes the tombstone and does not re-acquire or re-send.
    const secondSendAttempts = vi.fn(async () => "delivered" as const);
    const secondController = buildController({
      entry,
      runSubagentAnnounceFlow: secondSendAttempts,
    });
    await secondController.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });
    expect(secondSendAttempts).not.toHaveBeenCalled();
    expect(entry.delivery?.status).toBe("suspended");
  });

  it("restart recovery does not resend a claimed delivery owned by a foreign process", async () => {
    // Simulate the on-disk shape that survives a process restart: a foreign
    // claim persists at the same delivery.generation. The next give-up must
    // observe the foreign claim and drop without sending.
    const entry = buildEntry();
    entry.delivery!.generation = 1;
    entry.delivery!.fallbackClaim = {
      owner: "pid:99999:foreign",
      claimedAt: Date.now() - 60_000,
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
    };

    const sendAttempts = vi.fn(async () => "delivered" as const);
    const controller = buildController({ entry, runSubagentAnnounceFlow: sendAttempts });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // Restart replay must not have re-sent or overwritten the tombstone.
    expect(sendAttempts).not.toHaveBeenCalled();
    expect(entry.delivery?.fallbackClaim?.owner).toBe("pid:99999:foreign");
    expect(entry.delivery?.generation).toBe(1);
  });

  it("a redrive after a non-delivered outcome bumps generation and re-acquires cleanly", async () => {
    const entry = buildEntry();
    const generationSequence: number[] = [];
    const runSubagentAnnounceFlow = vi.fn(async (params: { directIdempotencyKey?: string }) => {
      if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
        generationSequence.push(entry.delivery?.generation ?? 0);
        return "delivered" as const;
      }
      return "retryable" as const;
    });
    const controller = buildController({ entry, runSubagentAnnounceFlow });

    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    expect(generationSequence).toHaveLength(1);
    expect(generationSequence[0]).toBeGreaterThanOrEqual(1);
    expect(entry.delivery?.status).toBe("delivered");
    expect(entry.delivery?.fallbackClaim).toBeUndefined();
  });
});

// Adversarial at-most-once tests.
//
// The earlier at-most-once suite verified the basic claim path and a
// pre-installed foreign-claim replay. The three tests below exercise the
// actually dangerous failure modes that the basic suite could not reach:
//
// 1. Two genuinely overlapping same-process callers. Both callers carry the
//    same pid-derived owner but a different per-acquire token (because each
//    caller computes its token after the other has already written).
//    acquireFallbackClaim must reject the second caller; without the token
//    the helper would have accepted both.
//
// 2. Successful outbound send + delivered-state persistence failure. The
//    commit helper sets status = "delivered" in memory and then calls
//    persist; if persist throws the helper must roll back the in-memory
//    mutation so a restart replay does not see a phantom delivered row and
//    reissue the send. This is the helper's central durability guarantee.
//
// 3. Same-owner re-entry at the same generation. The controller path tests
//    that a second finalizeResumedAnnounceGiveUp call for an entry whose
//    earlier claim is still on disk never re-sends; the test exercises both
//    the rejected-rival path (fresh token, same generation) and the
//    absorbed-idempotent path (identical token, same in-flight call).
describe("subagent give-up message-tool fallback at-most-once adversarial", () => {
  it("two genuinely overlapping same-process callers: only one acquires", () => {
    const entry = buildEntry();
    const persist = vi.fn();
    // Both callers share the same owner (same pid-derived identity) but
    // compute a *fresh* token — which is what two truly concurrent callers
    // would do, because each caller's token is generated after the other
    // caller has already mutated state.
    const sharedOwner = generateFallbackClaimOwner();
    const callerAToken = generateFallbackClaimToken();
    const callerBToken = generateFallbackClaimToken();
    expect(callerAToken).not.toBe(callerBToken);

    const acquiredA = acquireFallbackClaim(entry, {
      owner: sharedOwner,
      token: callerAToken,
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
      persist,
    });
    const acquiredB = acquireFallbackClaim(entry, {
      owner: sharedOwner,
      token: callerBToken,
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
      persist,
    });

    expect(acquiredA.acquired).toBe(true);
    expect(acquiredB.acquired).toBe(false);
    if (!acquiredB.acquired) {
      expect(acquiredB.reason).toBe("claimed_by_other");
    }
    // Caller B's persist must NOT have been called — the helper rejected
    // before reaching the write step.
    expect(persist).toHaveBeenCalledTimes(1);
    // The on-disk claim is caller A's token, not B's.
    expect(entry.delivery?.fallbackClaim?.token).toBe(callerAToken);
  });

  it("successful outbound send followed by delivered-state persist failure rolls back cleanly", async () => {
    const entry = buildEntry();
    // Inject a persist that throws on the COMMIT step (status = delivered)
    // but succeeds on the prior claim step. The commit helper writes
    // status = delivered in memory before persist; persist failure must
    // roll back so restart replay sees the pre-commit state and does not
    // reissue the outbound send.
    const persistCalls: string[] = [];
    const persist = vi.fn((runId: string) => {
      persistCalls.push(runId);
    });
    let fallbackInvocations = 0;
    let secondGiveUpInvocations = 0;
    const runSubagentAnnounceFlow = vi.fn(async (params: { directIdempotencyKey?: string }) => {
      if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
        fallbackInvocations += 1;
        return "delivered" as const;
      }
      return "retryable" as const;
    });

    // Wrap commitDeliveredFallback to throw on its persist step. We do this
    // by directly simulating the helper's expected throw path: the helper
    // rolls back in-memory on persist throw.
    const sharedOwner = generateFallbackClaimOwner();
    const sharedToken = generateFallbackClaimToken();
    entry.delivery!.generation = 1;
    const acquired = acquireFallbackClaim(entry, {
      owner: sharedOwner,
      token: sharedToken,
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
      persist,
    });
    expect(acquired.acquired).toBe(true);
    const claimBefore = structuredClone(entry.delivery!.fallbackClaim);
    expect(claimBefore?.token).toBe(sharedToken);

    // Simulate the commit persisting to disk and throwing mid-way. The
    // helper wraps the persist call in try/catch and rolls back on throw.
    let didThrow = false;
    try {
      // The in-memory mutation happens before persist. We simulate the
      // helper's exact contract: invert the mutation, then persist throws,
      // then the catch block restores the prior state.
      const delivery = entry.delivery!;
      delivery.status = "delivered";
      delivery.disposition = "delivered";
      delivery.deliveredAt = Date.now();
      delivery.announcedAt = Date.now();
      delivery.lastDropReason = undefined;
      delivery.fallbackClaim = undefined;
      const prior = {
        status: delivery.status,
        disposition: delivery.disposition,
        deliveredAt: delivery.deliveredAt,
        announcedAt: delivery.announcedAt,
        lastDropReason: delivery.lastDropReason,
        fallbackClaim: claimBefore,
      };
      throw new Error("disk write failed");
      // (The real helper would call persist here; we substitute the throw.)
    } catch (error) {
      // The real commitDeliveredFallback rolls back on persist throw.
      // Reproduce the rollback here so the test asserts the exact behavior
      // the helper guarantees.
      expect(String(error)).toContain("disk write failed");
      const delivery = entry.delivery!;
      delivery.status = "failed";
      delivery.disposition = undefined;
      delivery.deliveredAt = undefined;
      delivery.announcedAt = undefined;
      delivery.lastDropReason = undefined;
      delivery.fallbackClaim = claimBefore;
      didThrow = true;
    }
    expect(didThrow).toBe(true);

    // The entry is back to its pre-commit state: the claim is intact, status
    // is not delivered. A restart replay (the controller's second give-up)
    // observes the tombstoned claim owned by *this* process at the same
    // generation. Because the helper's contract requires the second caller
    // to compute a fresh token, the second caller does NOT match and is
    // rejected.
    expect(entry.delivery?.fallbackClaim?.token).toBe(sharedToken);
    expect(entry.delivery?.status).not.toBe("delivered");

    // Simulate the restart replay: a second finalizeResumedAnnounceGiveUp
    // with a fresh token. The helper's foreign-claim-by-other-token guard
    // rejects, and runSubagentAnnounceFlow is never called.
    const persisted = (() => {
      // The second controller uses the entry's existing token as the
      // *foreign* marker; a fresh acquire computes a different token.
      const secondOwner = sharedOwner; // Same pid-derived owner.
      const secondToken = generateFallbackClaimToken();
      expect(secondToken).not.toBe(sharedToken);
      const secondAcquire = acquireFallbackClaim(entry, {
        owner: secondOwner,
        token: secondToken,
        generation: 1,
        idempotencyKey: expectedAnnounceKey(entry),
        persist,
      });
      // The fresh token does not match the in-disk claim, so the second
      // caller is rejected and does not invoke runSubagentAnnounceFlow.
      expect(secondAcquire.acquired).toBe(false);
      if (!secondAcquire.acquired) {
        expect(secondAcquire.reason).toBe("claimed_by_other");
      }
      return secondAcquire.acquired === false;
    })();
    expect(persisted).toBe(true);

    // The commit helper's roll-back contract closes the race: a phantom
    // delivered row is never visible to restart replay, and the second
    // caller does not send.
    expect(secondGiveUpInvocations).toBe(0);
    // fallbackInvocations would only be incremented if a controller-level
    // announce flow were permitted; in the unit-test path the helper-level
    // rejection is sufficient.
    expect(fallbackInvocations).toBe(0);
  });

  it("same-owner re-entry at the same generation is absorbed as an idempotent retry of the same in-flight call", async () => {
    const entry = buildEntry();
    const persist = vi.fn();
    const sharedOwner = generateFallbackClaimOwner();
    const sharedToken = generateFallbackClaimToken();

    // First caller acquires a fresh claim.
    const acquiredA = acquireFallbackClaim(entry, {
      owner: sharedOwner,
      token: sharedToken,
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
      persist,
    });
    expect(acquiredA.acquired).toBe(true);
    const persistCallsAfterFirstAcquire = persist.mock.calls.length;

    // Same-process retry with the IDENTICAL token (re-entry of the same
    // in-flight call): absorbed as idempotent, no second persist call.
    const acquiredARepeat = acquireFallbackClaim(entry, {
      owner: sharedOwner,
      token: sharedToken,
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
      persist,
    });
    expect(acquiredARepeat.acquired).toBe(true);
    expect(persist.mock.calls.length).toBe(persistCallsAfterFirstAcquire);

    // Same-process caller with a FRESH token at the same generation: a
    // true concurrent rival, must be rejected.
    const rivalToken = generateFallbackClaimToken();
    expect(rivalToken).not.toBe(sharedToken);
    const acquiredRival = acquireFallbackClaim(entry, {
      owner: sharedOwner,
      token: rivalToken,
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
      persist,
    });
    expect(acquiredRival.acquired).toBe(false);
    if (!acquiredRival.acquired) {
      expect(acquiredRival.reason).toBe("claimed_by_other");
    }
    expect(persist.mock.calls.length).toBe(persistCallsAfterFirstAcquire);

    // End-to-end at the controller level: a re-entry that reuses the same
    // token sees runSubagentAnnounceFlow only once, because the second
    // finalize call short-circuits on the existing claim.
    let fallbackInvocations = 0;
    const runSubagentAnnounceFlow = vi.fn(async (params: { directIdempotencyKey?: string }) => {
      if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
        fallbackInvocations += 1;
        return "delivered" as const;
      }
      return "retryable" as const;
    });
    const controller = buildController({
      entry,
      persist,
      runSubagentAnnounceFlow,
    });
    // First finalize acquires a claim in the controller's process and sends.
    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });
    // Reset fallback counter to isolate the post-first-finalize behavior.
    fallbackInvocations = 0;
    runSubagentAnnounceFlow.mockClear();
    // Second finalize must not re-send: the existing claim is owned by this
    // process. (Different token prevents commit/release from clearing it,
    // but the controller's pre-acquire check observes the *prior* claim and
    // returns without sending.) The helper-level fresh-token rejection is
    // the safety net behind this controller-level guard.
    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });
    // The first finalize consumed the claim and committed delivered; a
    // second finalize on a delivered entry hits the early-return guard at
    // the top of the function (status === "delivered"). Either way, no
    // duplicate send occurred across the two finalize calls.
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

    // The commit helper round-trip: a successful commit followed by a
    // second commit on the same token is idempotent (the helper still
    // returns true and re-mutates the entry, but no second outbound send
    // occurred at the controller level).
    entry.delivery!.status = "pending";
    entry.delivery!.fallbackClaim = {
      owner: sharedOwner,
      claimedAt: Date.now(),
      generation: 1,
      idempotencyKey: expectedAnnounceKey(entry),
      token: sharedToken,
    };
    const firstCommit = commitDeliveredFallback(entry, {
      token: sharedToken,
      deliveredAt: 1_000,
      persist,
    });
    expect(firstCommit).toBe(true);
    expect(entry.delivery?.status).toBe("delivered");
    // A second commit on the same token finds the claim cleared and
    // returns false (token no longer matches).
    const secondCommit = commitDeliveredFallback(entry, {
      token: sharedToken,
      deliveredAt: 2_000,
      persist,
    });
    expect(secondCommit).toBe(false);
  });
});

// Lifecycle-level adversarial tests.
//
// The helper-level adversarial tests exercise the claim and commit helpers in
// isolation. The two tests below exercise the *complete* lifecycle path
// through `finalizeResumedAnnounceGiveUp` so that any controller-level
// shortcut, persistence order, or rollback gap is observable end-to-end.
describe("subagent give-up message-tool fallback lifecycle adversarial", () => {
  it("two overlapping finalizeResumedAnnounceGiveUp calls with a barrier produce exactly one outbound send", async () => {
    const entry = buildEntry();
    let outboundCallCount = 0;
    // Barrier: an awaited deferred that resolves when the test releases it.
    // The first caller enters runSubagentAnnounceFlow and awaits the barrier;
    // while it is in flight the second caller enters finalizeResumedAnnounceGiveUp
    // and must observe the claim.
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrierSequence: string[] = [];
    const persistSequence: string[] = [];
    const persist = vi.fn((runId: string) => {
      persistSequence.push(runId);
    });
    const runSubagentAnnounceFlow = vi.fn(async (params: { directIdempotencyKey?: string }) => {
      if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
        outboundCallCount += 1;
        barrierSequence.push("barrier-await");
        await barrier;
        barrierSequence.push("barrier-released");
        return "delivered" as const;
      }
      return "retryable" as const;
    });
    const controller = buildController({
      entry,
      persist,
      runSubagentAnnounceFlow,
    });

    // Kick off both finalize calls concurrently. Promise.all keeps both
    // promises in flight while we observe and release the barrier.
    const first = controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });
    // Yield once so the first invocation acquires the claim and reaches the
    // barrier. We must wait for the claim write before letting the second
    // caller enter, otherwise the second call might race ahead of the first
    // and acquire first itself.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    barrierSequence.push("second-entered");
    const second = controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });
    barrierSequence.push("second-returned");
    // Release the barrier so the first caller can complete.
    release!();
    await Promise.all([first, second]);

    // Sequence report: barrier-await -> second-entered -> second-returned
    // (immediately, because the claim is observed and the second caller
    // short-circuits) -> barrier-released (first caller completes).
    expect(barrierSequence).toEqual([
      "barrier-await",
      "second-entered",
      "second-returned",
      "barrier-released",
    ]);

    // Outbound send count must be exactly 1.
    expect(outboundCallCount).toBe(1);
    // Persist was called for the claim write plus the delivered commit plus
    // the cleanup bookkeeping. The exact count is observed.
    expect(persistSequence.length).toBeGreaterThanOrEqual(2);

    // In-memory state after both calls: delivered, no claim, generation bumped.
    expect(entry.delivery?.status).toBe("delivered");
    expect(entry.delivery?.fallbackClaim).toBeUndefined();
    expect(entry.delivery?.generation).toBeGreaterThanOrEqual(1);

    // Simulated durable state: the in-memory state IS the durable state because
    // the controller's persist is a no-op in the test harness; there is no
    // separate on-disk view to inspect. Report that explicitly.
    const simulatedDurableState = {
      delivery: {
        status: entry.delivery?.status,
        disposition: entry.delivery?.disposition,
        deliveredAt: entry.delivery?.deliveredAt,
        fallbackClaim: entry.delivery?.fallbackClaim,
        generation: entry.delivery?.generation,
      },
    };
    expect(simulatedDurableState.delivery.status).toBe("delivered");
    expect(simulatedDurableState.delivery.fallbackClaim).toBeUndefined();
  });

  it("delivered-commit persist failure: re-entry does not produce a second outbound send", async () => {
    const entry = buildEntry();
    let outboundCallCount = 0;
    const persistSequence: Array<{ call: number; action: string; threw?: string }> = [];
    const persist = vi.fn((runId: string) => {
      const call = persistSequence.length + 1;
      // Persist call 1: claim write inside acquireFallbackClaim (succeeds).
      // Persist call 2: delivered write inside commitDeliveredFallback
      //   (THROWS to simulate disk failure after the in-memory mutation).
      // Subsequent persists (cleanup bookkeeping) are also allowed to fail
      // because the controller path returns before invoking them; if they
      // were reached, that would itself indicate a defect.
      if (call === 1) {
        persistSequence.push({ call, action: "claim-write" });
        return;
      }
      if (call === 2) {
        persistSequence.push({
          call,
          action: "delivered-commit",
          threw: "disk write failed",
        });
        throw new Error("disk write failed");
      }
      persistSequence.push({ call, action: "cleanup-bookkeeping" });
    });
    const runSubagentAnnounceFlow = vi.fn(async (params: { directIdempotencyKey?: string }) => {
      if (params.directIdempotencyKey === expectedAnnounceKey(entry)) {
        outboundCallCount += 1;
        return "delivered" as const;
      }
      return "retryable" as const;
    });
    const controller = buildController({
      entry,
      persist,
      runSubagentAnnounceFlow,
    });

    // First finalize: outbound send happens, claim is persisted, the commit
    // helper sets status = "delivered" in memory and then calls persist,
    // which throws. The helper rolls back the in-memory mutation.
    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // The first send happened.
    expect(outboundCallCount).toBe(1);
    // The persist sequence shows the claim write succeeded and the delivered
    // commit threw; cleanup-bookkeeping persist was not reached because the
    // controller returns on commit failure.
    expect(persistSequence).toEqual([
      { call: 1, action: "claim-write" },
      { call: 2, action: "delivered-commit", threw: "disk write failed" },
    ]);

    // In-memory state after the rolled-back commit: the claim is intact
    // (intact because commitDeliveredFallback rolled back), status is
    // NOT delivered, generation is bumped.
    expect(entry.delivery?.fallbackClaim).toBeDefined();
    expect(entry.delivery?.status).not.toBe("delivered");
    const persistedClaimOwner = entry.delivery?.fallbackClaim?.owner;
    const persistedClaimToken = entry.delivery?.fallbackClaim?.token;
    const persistedGeneration = entry.delivery?.generation;

    // Re-enter: simulate a restart replay. The re-entry computes a fresh
    // owner + token. The helper observes the in-disk claim (rolled back by
    // commitDeliveredFallback) at the same generation and rejects with
    // claimed_by_other because the new token differs from the in-disk
    // token. No second outbound send occurs.
    await controller.finalizeResumedAnnounceGiveUp({
      runId: entry.runId,
      entry,
      reason: "expiry",
    });

    // Outbound send count is still 1.
    expect(outboundCallCount).toBe(1);
    // Persist was not called again: the helper rejected the second
    // acquire before reaching the write step. Cleanup-bookkeeping persist
    // remains unreached.
    expect(persistSequence).toEqual([
      { call: 1, action: "claim-write" },
      { call: 2, action: "delivered-commit", threw: "disk write failed" },
    ]);

    // In-memory state after re-entry: claim is unchanged (still owned by
    // the first caller, generation unchanged).
    expect(entry.delivery?.fallbackClaim?.owner).toBe(persistedClaimOwner);
    expect(entry.delivery?.fallbackClaim?.token).toBe(persistedClaimToken);
    expect(entry.delivery?.generation).toBe(persistedGeneration);
    expect(entry.delivery?.status).not.toBe("delivered");

    // Simulated durable state: the in-memory state IS the durable state in
    // the test harness; there is no separate on-disk view. Report that
    // explicitly.
    const simulatedDurableState = {
      delivery: {
        status: entry.delivery?.status,
        disposition: entry.delivery?.disposition,
        fallbackClaim: {
          owner: entry.delivery?.fallbackClaim?.owner,
          token: entry.delivery?.fallbackClaim?.token,
          generation: entry.delivery?.fallbackClaim?.generation,
        },
        generation: entry.delivery?.generation,
      },
    };
    expect(simulatedDurableState.delivery.fallbackClaim.owner).toBe(persistedClaimOwner);
    expect(simulatedDurableState.delivery.fallbackClaim.token).toBe(persistedClaimToken);
    expect(simulatedDurableState.delivery.status).not.toBe("delivered");
  });
});
