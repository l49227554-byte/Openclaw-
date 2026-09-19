import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { settleRequesterTurnAfterSessionSpawns } from "../agents/subagents/registry/subagent-registry-requester-yield.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { createAgentHarnessTaskRuntime } from "../plugin-sdk/agent-harness-task-runtime.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../test-utils/task-registry-store.js";
import { createAgentHarnessTaskRuntimeScope } from "./agent-harness-task-runtime-scope.js";
import { createSubagentTaskBackingDetail } from "./task-backing-authority.js";
import * as deliveryRuntime from "./task-registry-runtime-loaders.js";
import { resetTaskRegistryListenerState } from "./task-registry-state.js";
import {
  createTaskRecord,
  getTaskById,
  markTaskTerminalById,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import { clearTaskProgressBatches } from "./task-registry.process-state.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskNotifyPolicy } from "./task-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryDeliveryRuntimeForTests,
  resetTaskRegistryForTests,
  setTaskRegistryDeliveryRuntimeForTests,
} from "./task-runtime.test-helpers.js";

vi.mock("../agents/subagents/announce/subagent-announce-delivery.js", () => ({
  loadRequesterSessionEntry: (key: string) => ({
    canonicalKey: key,
    agentId: "main",
    entry: { sessionId: "synthetic-parent", lifecycleRevision: "one" },
  }),
  deliverSubagentAnnouncement: vi.fn(),
  isInternalAnnounceRequesterSession: vi.fn(),
}));

vi.mock("../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (channel: string) => channel === "notifychat",
}));

const PARENT = "agent:main:parent";
const origin = {
  channel: "notifychat",
  to: "synthetic-recipient",
  accountId: "test",
  threadId: "test-thread",
};
const sendMessage = vi.fn<deliveryRuntime.TaskRegistryDeliveryRuntime["sendMessage"]>();

function child(name: string, notifyPolicy: TaskNotifyPolicy = "state_changes") {
  const entry: SubagentRunRecord = {
    runId: `run-${name}`,
    childSessionKey: `agent:main:subagent:${name}`,
    requesterSessionKey: PARENT,
    requesterAgentId: "main",
    requesterDisplayKey: PARENT,
    requesterTurnRunId: "parent-turn",
    requesterTurnYielded: true,
    requesterOrigin: origin,
    task: "Private child assignment",
    label: name,
    cleanup: "keep",
    createdAt: Date.now(),
    generation: 1,
    execution: { status: "running", startedAt: Date.now() },
    expectsCompletionMessage: true,
  };
  subagentRuns.set(entry.runId, entry);
  const task = createTaskRecord({
    runtime: "subagent",
    ownerKey: PARENT,
    requesterSessionKey: PARENT,
    requesterAgentId: "main",
    scopeKind: "session",
    childSessionKey: entry.childSessionKey,
    runId: entry.runId,
    label: name,
    task: entry.task,
    status: "running",
    notifyPolicy,
    deliveryStatus: "pending",
    requesterOrigin: origin,
    detail: createSubagentTaskBackingDetail(1),
  });
  if (!task) {
    throw new Error("Expected accepted task");
  }
  return { entry, task };
}

function yieldParent() {
  const entries = [...subagentRuns.values()];
  expect(
    settleRequesterTurnAfterSessionSpawns({
      requesterSessionKey: PARENT,
      requesterTurnRunId: "parent-turn",
      requesterYielded: true,
      acceptedSessionSpawns: entries.map((entry) => ({
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        expectsCompletionMessage: true,
      })),
      runs: subagentRuns,
      persistOrThrow: () => {},
      schedule: () => {},
    }),
  ).toBe(true);
}

function tool(entry: SubagentRunRecord, index = 1) {
  emitAgentEvent({
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    stream: "tool",
    data: {
      phase: "start",
      name: "read",
      toolCallId: `call-${index}`,
      args: { secret: "private-tool-arguments" },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
  resetGatewayWorkAdmission();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  subagentRuns.clear();
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
  configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
  sendMessage.mockReset().mockImplementation(async (params) => {
    params.assertDirectAdapterHandoff?.();
    return {
      channel: "notifychat",
      to: params.to,
      via: "direct",
      mediaUrl: null,
      deliveryStatus: "sent",
    };
  });
  setTaskRegistryDeliveryRuntimeForTests({ sendMessage });
});

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetTaskRegistryDeliveryRuntimeForTests();
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  subagentRuns.clear();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("yielded subagent progress delivery", () => {
  it("coalesces progress at the original audience after the yielded requester closes without completing or waking it", async () => {
    const first = child("First");
    vi.setSystemTime(Date.now() + 1);
    const second = child("Second");
    child("Quiet", "silent");
    // The slow tool starts before the parent yields and need not produce another event.
    tool(first.entry);
    const requester = new AsyncWorkScope();
    const root = tryBeginGatewayRootWorkAdmission("test:yielded-requester");
    if (!root) {
      throw new Error("Expected admitted requester");
    }
    let requesterContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
    try {
      requesterContext = await root.run(async () =>
        requester.run(() => {
          const context = AsyncLocalStorage.snapshot();
          yieldParent();
          return context;
        }),
      );
    } finally {
      root.release();
      await requester.drain();
    }
    expect(requester.signal.aborted).toBe(true);
    for (let index = 0; index < 40; index++) {
      tool(second.entry, index);
    }
    emitAgentEvent({
      runId: first.entry.runId,
      stream: "assistant",
      data: { text: "private-child-text" },
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sendMessage).not.toHaveBeenCalled();
    // Fake timers do not restore native timer ALS; the progress timer retains its yield owner.
    await requesterContext(() => {
      expect(getAsyncWorkSignal()).toBe(requester.signal);
      return vi.advanceTimersByTimeAsync(1);
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    const message = sendMessage.mock.calls[0]![0];
    expect(message).toMatchObject({
      ...origin,
      skipQueue: true,
      gatewayOwnedDelivery: true,
      mirror: { sessionKey: PARENT, agentId: "main" },
    });
    expect(message.content).toBe(
      "Background work is still in progress:\n- First: running read; 1 tool call started.\n- Second: running read; 40 tool calls started.",
    );
    expect(message.content).not.toMatch(/Quiet|private-/);
    expect(getTaskById(first.task.taskId)).toMatchObject({
      status: "running",
      deliveryStatus: "pending",
    });
    expect(first.entry.requesterSettleWake).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(peekSystemEvents(PARENT)).toEqual([]);
  });

  it.each(["done_only", "silent"] as const)(
    "preserves %s notification policy across yield",
    async (policy) => {
      const item = child("Worker", policy);
      yieldParent();
      tool(item.entry);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "finish", "rearm", "replace", "resume", "mute", "drain", "reset"] as const)(
    "drops queued progress after %s",
    async (change) => {
      const item = child("Worker");
      tool(item.entry);
      yieldParent();
      switch (change) {
        case "cancel":
          item.entry.killIntent = { requestedAt: Date.now(), reason: "operator cancelled" };
          break;
        case "finish":
          markTaskTerminalById({
            taskId: item.task.taskId,
            status: "succeeded",
            endedAt: Date.now(),
          });
          break;
        case "rearm":
          item.entry.requesterSettleWake!.rearmGeneration = 2;
          break;
        case "replace":
          subagentRuns.set(item.entry.runId, { ...item.entry, generation: 2 });
          break;
        case "resume":
          registerAgentRunContext("parent-resumed", {
            sessionKey: PARENT,
            agentId: "main",
            projectSessionActive: true,
          });
          break;
        case "mute":
          updateTaskNotifyPolicyById({ taskId: item.task.taskId, notifyPolicy: "silent" });
          break;
        case "drain":
          markGatewayRestartDraining();
          break;
        case "reset":
          resetTaskRegistryListenerState();
          break;
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it("revalidates after runtime loading and at adapter handoff", async () => {
    const first = child("First");
    yieldParent();
    const loaded = createDeferred<deliveryRuntime.TaskRegistryDeliveryRuntime>();
    vi.spyOn(deliveryRuntime, "loadTaskRegistryDeliveryRuntime").mockReturnValueOnce(
      loaded.promise,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    first.entry.killIntent = { requestedAt: Date.now(), reason: "cancelled during load" };
    loaded.resolve({ sendMessage });
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).not.toHaveBeenCalled();

    subagentRuns.clear();
    const second = child("Second");
    yieldParent();
    let visibleSends = 0;
    sendMessage.mockImplementationOnce(async (params) => {
      second.entry.requesterSettleWake = undefined;
      params.assertDirectAdapterHandoff?.();
      visibleSends++;
      return { channel: "notifychat", to: params.to, via: "direct", mediaUrl: null };
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(visibleSends).toBe(0);
    expect(getTaskById(second.task.taskId)?.deliveryStatus).toBe("pending");
  });

  it("bounds a large batch and keeps publishing when newer activity arrives during transport work", async () => {
    const items = Array.from({ length: 35 }, (_, index) => {
      vi.setSystemTime(Date.now() + 1);
      return child(`Worker ${index + 1}`);
    });
    yieldParent();
    const first = items[0]!;
    sendMessage.mockImplementationOnce(async (params) => {
      tool(first.entry);
      params.assertDirectAdapterHandoff?.();
      return { channel: "notifychat", to: params.to, via: "direct", mediaUrl: null };
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![0].content.split("\n")).toHaveLength(10);
    expect(sendMessage.mock.calls[0]![0].content).toContain(
      "More task activity is available in Tasks.",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]![0].content).toContain(
      "Worker 1: running read; 1 tool call started.",
    );
  });
});

describe("yield-authorized harness progress", () => {
  function harness() {
    const runtime = createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: "test-native",
      runIdPrefix: "native:",
      scope: createAgentHarnessTaskRuntimeScope({
        requesterSessionKey: PARENT,
        requesterOrigin: origin,
      }),
    });
    const task = runtime.createRunningTaskRun({
      runId: "native:one",
      task: "private assignment",
      label: "Worker",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
    });
    return { runtime, task };
  }

  it("updates one silent native task card through completion without a second announcement", async () => {
    const editTaskProgressMessage = vi.fn(async () => {});
    sendMessage.mockResolvedValue({
      channel: "notifychat",
      to: origin.to,
      via: "direct",
      mediaUrl: null,
      result: {
        channel: "notifychat",
        messageId: "card-1",
        target: { kind: "channel", id: "test-thread" },
      },
    });
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage,
      editTaskProgressMessage,
      isTaskProgressEnabled: () => true,
    });
    const { runtime, task } = harness();
    const stopped = vi.fn();
    const progress = runtime.registerProgressOwner?.({
      runIds: [task.runId!],
      isCurrent: () => true,
      onStopped: stopped,
    });
    progress?.notify();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).toHaveBeenCalledOnce();
    emitAgentEvent({
      runId: task.runId!,
      stream: "tool",
      data: {
        phase: "start",
        name: "read",
        toolCallId: "native-tool",
        args: { secret: "do-not-publish" },
      },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(editTaskProgressMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "card-1",
        to: "channel:test-thread",
        content: expect.stringContaining("read"),
      }),
    );
    runtime.finalizeTaskRunByRunId({
      runId: task.runId!,
      status: "succeeded",
      endedAt: Date.now(),
    });
    progress?.notify();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(editTaskProgressMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: "card-1",
        content: expect.stringContaining("succeeded"),
      }),
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    expect(getTaskById(task.taskId)?.notifyPolicy).toBe("silent");
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("private assignment");
    expect(JSON.stringify(editTaskProgressMessage.mock.calls)).not.toContain("do-not-publish");
  });

  it.each(["send", "edit"])(
    "publishes completion arriving during an in-flight %s",
    async (phase) => {
      const pending = createDeferred();
      const receipt = {
        channel: "notifychat",
        to: origin.to,
        via: "direct" as const,
        mediaUrl: null,
        result: {
          channel: "notifychat",
          messageId: "card-1",
          target: { kind: "channel" as const, id: "test-thread" },
        },
      };
      sendMessage.mockImplementation(async () => {
        if (phase === "send") {
          await pending.promise;
        }
        return receipt;
      });
      const editTaskProgressMessage = vi.fn(async () => {});
      if (phase === "edit") {
        editTaskProgressMessage.mockImplementationOnce(() => pending.promise);
      }
      setTaskRegistryDeliveryRuntimeForTests({
        sendMessage,
        editTaskProgressMessage,
        isTaskProgressEnabled: () => true,
      });
      const { runtime, task } = harness();
      const stopped = vi.fn();
      const progress = runtime.registerProgressOwner?.({
        runIds: [task.runId!],
        isCurrent: () => true,
        onStopped: stopped,
      });
      progress?.notify();
      await vi.advanceTimersByTimeAsync(15_000);
      if (phase === "edit") {
        emitAgentEvent({
          runId: task.runId!,
          stream: "tool",
          data: { phase: "start", name: "read", toolCallId: "in-flight-tool" },
        });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(editTaskProgressMessage).toHaveBeenCalledOnce();
      }
      runtime.finalizeTaskRunByRunId({
        runId: task.runId!,
        status: "succeeded",
        endedAt: Date.now(),
      });
      progress?.notify();
      pending.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(editTaskProgressMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messageId: "card-1",
          content: expect.stringContaining("succeeded"),
        }),
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(stopped).toHaveBeenCalledOnce();
    },
  );

  it("retires harness ownership when the registry clears progress batches", async () => {
    const { runtime, task } = harness();
    const stopped = vi.fn();
    const progress = runtime.registerProgressOwner?.({
      runIds: [task.runId!],
      isCurrent: () => true,
      onStopped: stopped,
    });
    progress?.notify();
    clearTaskProgressBatches();
    expect(stopped).toHaveBeenCalledOnce();
    progress?.notify();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledOnce();
    expect(getTaskById(task.taskId)?.status).toBe("running");
  });

  it.each(["notify", "timer", "handoff"])(
    "releases an invalid nonterminal owner at %s",
    async (boundary) => {
      const { runtime, task } = harness();
      let current = true;
      const stopped = vi.fn();
      sendMessage.mockImplementation(async (params) => {
        current = false;
        params.assertDirectAdapterHandoff?.();
        throw new Error("Invalidated before dispatch");
      });
      setTaskRegistryDeliveryRuntimeForTests({ sendMessage, isTaskProgressEnabled: () => true });
      const progress = runtime.registerProgressOwner?.({
        runIds: [task.runId!],
        isCurrent: () => current,
        onStopped: stopped,
      });
      progress?.notify();
      if (boundary !== "handoff") {
        current = false;
      }
      if (boundary === "notify") {
        progress?.notify();
        expect(stopped).toHaveBeenCalledOnce();
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stopped).toHaveBeenCalledOnce();
      expect(getTaskById(task.taskId)?.status).toBe("running");
      progress?.notify();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(stopped).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledTimes(boundary === "handoff" ? 1 : 0);
    },
  );

  it.each(["revoked", "disabled"])("does not send when progress is %s", async (mode) => {
    setTaskRegistryDeliveryRuntimeForTests({
      sendMessage,
      isTaskProgressEnabled: () => mode !== "disabled",
    });
    const { runtime, task } = harness();
    let current = true;
    const progress = runtime.registerProgressOwner?.({
      runIds: [task.runId!],
      isCurrent: () => current,
      onStopped: () => {},
    });
    progress?.notify();
    current = mode !== "revoked";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendMessage).not.toHaveBeenCalled();
    progress?.dispose();
  });
});
