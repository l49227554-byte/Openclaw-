import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearAgentRunContext,
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { registerHarnessTaskProgress } from "../tasks/task-registry-progress.js";
import { createAgentHarnessTaskRuntime } from "./agent-harness-task-runtime.js";

const state = vi.hoisted(() => ({
  sessionId: "original",
  lifecycleRevision: "one",
  readError: false,
}));
vi.mock("../agents/subagents/announce/subagent-announce-delivery.js", () => ({
  loadRequesterSessionEntry: (key: string) => {
    if (state.readError) {
      throw new Error("synthetic requester read failure");
    }
    return {
      canonicalKey: key,
      agentId: "main",
      entry: { sessionId: state.sessionId, lifecycleRevision: state.lifecycleRevision },
    };
  },
  deliverSubagentAnnouncement: vi.fn(),
  isInternalAnnounceRequesterSession: vi.fn(),
}));
vi.mock("../tasks/task-registry-progress.js", () => ({
  registerHarnessTaskProgress: vi.fn((params) => ({
    notify: vi.fn(),
    dispose: vi.fn(() => params.onStopped()),
  })),
}));
vi.mock("../tasks/runtime-internal.js", () => ({ listTaskRecords: () => [] }));
vi.mock("../tasks/detached-task-runtime.js", () => ({
  createRunningTaskRun: vi.fn(),
  finalizeTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const sessionKey = "agent:main:synthetic";
const stop: Array<() => void> = [];
beforeEach(() => {
  resetAgentRunRegistryForTest();
  vi.clearAllMocks();
  state.readError = false;
  state.sessionId = "original";
  state.lifecycleRevision = "one";
});
afterEach(() => {
  stop.splice(0).forEach((dispose) => dispose());
  resetAgentRunRegistryForTest();
});

function register() {
  const runtime = createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: "synthetic-native",
    scope: createAgentHarnessTaskRuntimeScope({
      requesterSessionKey: sessionKey,
      requesterOrigin: { channel: "discord", to: "channel:synthetic" },
    }),
  });
  const onStopped = vi.fn();
  const owner = runtime.registerProgressOwner!({
    runIds: [],
    agentId: "main",
    isCurrent: () => true,
    onStopped,
  });
  if (owner) {
    stop.push(owner.dispose);
  }
  return {
    owner,
    onStopped,
    admitted: vi.mocked(registerHarnessTaskProgress).mock.calls.at(-1)![0],
  };
}

it("permanently retires post-yield progress on a requester run using another native thread or client", () => {
  registerAgentRunContext("old-run", { sessionKey, sessionId: "original", agentId: "main" });
  const { owner, admitted, onStopped } = register();
  expect(admitted.isCurrent()).toBe(true);
  clearAgentRunContext("old-run");
  expect(admitted.isCurrent()).toBe(true);
  registerAgentRunContext("new-run", { sessionKey, sessionId: "original", agentId: "main" });
  clearAgentRunContext("new-run");
  expect(admitted.isCurrent()).toBe(false);
  expect(owner?.dispose).toHaveBeenCalledOnce();
  expect(onStopped).toHaveBeenCalledOnce();
});

it("ignores unrelated requester runs", () => {
  const { admitted, onStopped } = register();
  registerAgentRunContext("other-run", { sessionKey: "agent:main:other", agentId: "main" });
  expect(admitted.isCurrent()).toBe(true);
  expect(onStopped).not.toHaveBeenCalled();
});

it.each(["sessionId", "lifecycleRevision"] as const)(
  "retires on requester %s replacement and never reactivates",
  (field) => {
    const { admitted, onStopped } = register();
    const original = state[field];
    state[field] = "replaced";
    sessionChanges.emit({ sessionKey, agentId: "main" });
    state[field] = original;
    expect(admitted.isCurrent()).toBe(false);
    expect(onStopped).toHaveBeenCalledOnce();
  },
);

it("rejects progress registration for a foreign agent", () => {
  const runtime = createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: "synthetic-native",
    scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: sessionKey }),
  });
  expect(
    runtime.registerProgressOwner!({
      runIds: [],
      agentId: "foreign",
      isCurrent: () => true,
      onStopped: vi.fn(),
    }),
  ).toBeUndefined();
  expect(registerHarnessTaskProgress).not.toHaveBeenCalled();
});

it("does not retire for maintenance that cannot project requester lifecycle", () => {
  const { admitted, onStopped } = register();
  registerAgentRunContext("maintenance", {
    sessionKey,
    sessionId: "original",
    agentId: "main",
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  });
  expect(admitted.isCurrent()).toBe(true);
  expect(onStopped).not.toHaveBeenCalled();
});

it("still retires for a real requester turn hidden from the UI", () => {
  const { admitted } = register();
  registerAgentRunContext("hidden-requester", {
    sessionKey,
    sessionId: "original",
    agentId: "main",
    isControlUiVisible: false,
  });
  expect(admitted.isCurrent()).toBe(false);
});

it("declines optional progress if the initial requester lookup fails", () => {
  state.readError = true;
  const runtime = createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: "synthetic-native",
    scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: sessionKey }),
  });
  expect(
    runtime.registerProgressOwner?.({ runIds: [], isCurrent: () => true, onStopped: vi.fn() }),
  ).toBeUndefined();
  expect(registerHarnessTaskProgress).not.toHaveBeenCalled();
});

it("retires without throwing when a requester read fails after registration", () => {
  const { admitted, onStopped } = register();
  state.readError = true;
  expect(admitted.isCurrent()).toBe(false);
  sessionChanges.emit({ sessionKey, agentId: "main" });
  state.readError = false;
  expect(admitted.isCurrent()).toBe(false);
  expect(onStopped).toHaveBeenCalledOnce();
});
