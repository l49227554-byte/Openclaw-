import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticToolStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { startDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle as createUnboundEmbeddedRunHandle,
  testing,
} from "../embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

function createEmbeddedRunHandle(
  overrides: Parameters<typeof createUnboundEmbeddedRunHandle>[0] = {},
) {
  const handle = createUnboundEmbeddedRunHandle(overrides);
  return { ...handle, kind: "embedded" as const, cancel: () => handle.abort() };
}

const ref = { sessionId: "native-progress-session", sessionKey: "agent:main:native-progress" };
const attempt = {
  ...ref,
  runId: "native-progress-run",
  agentId: "main",
  config: {},
  sessionFile: "/tmp/native-progress-session.jsonl",
  workspaceDir: "/tmp/native-progress-workspace",
  provider: "openai",
  modelId: "test-model",
  sandboxSessionKey: ref.sessionKey,
  senderIsOwner: true,
  messageProvider: "slack",
  traceAuthorized: false,
};
const progress = { reason: "notification:item/started", backend: "codex-app-server" };

async function admitted<T>(
  run: (context: {
    admittedRunContext: Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
    close: () => void;
  }) => Promise<T>,
) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
    facts: {
      agentId: attempt.agentId,
      runId: attempt.runId,
      ingress: { kind: "system", state: "present", boundary: "native-progress-test" },
    },
  });
  try {
    return await run({
      admittedRunContext: await admission.admit("embedded", "progress-test"),
      close: admission.close,
    });
  } finally {
    admission.close();
  }
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("host-bound native progress", () => {
  it("keeps the real diagnostic watchdog alive from progress, then recovers genuinely idle work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-01T00:00:00Z"));
    // Liveness is a synchronous host fact, not optional exported telemetry.
    setDiagnosticsEnabledForProcess(true);
    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession: recoverStuckDiagnosticSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      },
    );
    const operation = createReplyOperation({ ...ref, resetTriggered: false });
    const snapshot = prepareReplyToolAuthority({ run: { ...attempt, model: attempt.modelId } });
    operation.bindToolAuthoritySnapshot(snapshot);
    operation.setPhase("running");
    const abort = vi.fn();
    await admitted(async ({ admittedRunContext }) =>
      withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext, replyOperation: operation },
        {
          ...attempt,
          toolAuthorityFingerprint: snapshot.fingerprint(),
          onRunProgress: () => operation.recordActivity(),
        },
        undefined,
        async (prepared) => {
          let runtimeWaiting = false;
          const handle = {
            ...createEmbeddedRunHandle({
              runId: attempt.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              abort,
            }),
            ownsLiveness: () => runtimeWaiting,
          };
          abort.mockImplementation(() => {
            clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
            operation.complete();
          });
          operation.attachBackend(handle);
          setActiveEmbeddedRun(
            ref.sessionId,
            handle,
            ref.sessionKey,
            attempt.sessionFile,
            attempt.agentId,
          );
          for (let i = 0; i < 12; i += 1) {
            await vi.advanceTimersByTimeAsync(20_000);
            prepared.onRunProgress(progress);
            expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
              activeWorkKind: "embedded_run",
              lastProgressAgeMs: 0,
            });
            expect(operation.lastActivityAtMs).toBe(Date.now());
            expect(abort).not.toHaveBeenCalled();
          }
          runtimeWaiting = true;
          await vi.advanceTimersByTimeAsync(90_000);
          expect(abort).not.toHaveBeenCalled();
          runtimeWaiting = false;
          await vi.advanceTimersByTimeAsync(90_000);
          expect(abort).toHaveBeenCalledOnce();
          expect(operation.result).not.toBeNull();
        },
      ),
    );
  });

  it.each(["replacement", "admission", "lifecycle", "stopped", "return"] as const)(
    "ignores retained progress after %s without refreshing a successor",
    async (closure) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-09-01T00:00:00Z"));
      const source = vi.fn();
      let retained: (() => void) | undefined;
      await admitted(async ({ admittedRunContext, close }) => {
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          { ...attempt, onRunProgress: source },
          undefined,
          async (prepared) => {
            let stopped = false;
            const handle = createEmbeddedRunHandle({
              runId: attempt.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              isStopped: () => stopped,
            });
            setActiveEmbeddedRun(
              ref.sessionId,
              handle,
              ref.sessionKey,
              attempt.sessionFile,
              attempt.agentId,
            );
            retained = () => prepared.onRunProgress(progress);
            if (closure === "replacement") {
              // Identical session/run strings do not make this a continuation of the old handle.
              setActiveEmbeddedRun(
                ref.sessionId,
                createEmbeddedRunHandle({
                  runId: attempt.runId,
                  toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                }),
                ref.sessionKey,
                attempt.sessionFile,
                attempt.agentId,
              );
            } else if (closure === "admission") {
              close();
            } else if (closure === "lifecycle") {
              rotateAgentEventLifecycleGeneration();
            } else if (closure === "stopped") {
              stopped = true;
            }
            if (closure !== "return") {
              vi.advanceTimersByTime(10_000);
              const before = getDiagnosticSessionActivitySnapshot(ref);
              retained();
              expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual(before);
              expect(source).not.toHaveBeenCalled();
            }
          },
        );
        if (closure === "return") {
          vi.advanceTimersByTime(10_000);
          const before = getDiagnosticSessionActivitySnapshot(ref);
          retained?.();
          expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual(before);
          expect(source).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each(["replace", "close"] as const)(
    "rechecks ownership after a runtime probe can %s it",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-09-01T00:00:00Z"));
      const source = vi.fn();
      await admitted(async ({ admittedRunContext, close }) =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          { ...attempt, onRunProgress: source },
          undefined,
          async (prepared) => {
            let probe = () => {};
            const handle = createEmbeddedRunHandle({
              runId: attempt.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              isStopped: () => {
                probe();
                return false;
              },
            });
            setActiveEmbeddedRun(
              ref.sessionId,
              handle,
              ref.sessionKey,
              attempt.sessionFile,
              attempt.agentId,
            );
            let afterProbe: ReturnType<typeof getDiagnosticSessionActivitySnapshot> | undefined;
            probe = () => {
              probe = () => {};
              if (change === "close") {
                close();
              } else {
                setActiveEmbeddedRun(
                  ref.sessionId,
                  createEmbeddedRunHandle({
                    runId: attempt.runId,
                    toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                  }),
                  ref.sessionKey,
                  attempt.sessionFile,
                  attempt.agentId,
                );
              }
              vi.advanceTimersByTime(10_000);
              afterProbe = getDiagnosticSessionActivitySnapshot(ref);
            };
            prepared.onRunProgress(progress);
            expect(source).not.toHaveBeenCalled();
            expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual(afterProbe);
          },
        ),
      );
    },
  );

  it.each(["backend", "operation", "route"] as const)(
    "ignores reply progress after its %s changes",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-09-01T00:00:00Z"));
      const operation = createReplyOperation({ ...ref, resetTriggered: false });
      const snapshot = prepareReplyToolAuthority({ run: { ...attempt, model: attempt.modelId } });
      operation.bindToolAuthoritySnapshot(snapshot);
      const source = vi.fn();
      await admitted(async ({ admittedRunContext }) =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          { ...attempt, toolAuthorityFingerprint: snapshot.fingerprint(), onRunProgress: source },
          undefined,
          async (prepared) => {
            const handle = createEmbeddedRunHandle({
              runId: attempt.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
            });
            setActiveEmbeddedRun(
              ref.sessionId,
              handle,
              ref.sessionKey,
              attempt.sessionFile,
              attempt.agentId,
            );
            operation.attachBackend(handle);
            prepared.onRunProgress(progress);
            expect(source).toHaveBeenCalledOnce();
            source.mockClear();
            if (change === "backend") {
              operation.attachBackend({ ...handle });
            } else if (change === "route") {
              operation.bindToolAuthorityRoute({ provider: "openai", model: "other-model" });
            } else {
              operation.complete();
              createReplyOperation({ ...ref, resetTriggered: false });
            }
            const before = getDiagnosticSessionActivitySnapshot(ref);
            prepared.onRunProgress(progress);
            expect(source).not.toHaveBeenCalled();
            expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual(before);
          },
        ),
      );
    },
  );

  it("does not renew a stuck tool from native notification traffic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-01T00:00:00Z"));
    await admitted(async ({ admittedRunContext }) =>
      withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        { ...attempt, onRunProgress: vi.fn() },
        undefined,
        async (prepared) => {
          const handle = createEmbeddedRunHandle({
            runId: attempt.runId,
            toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
          });
          setActiveEmbeddedRun(
            ref.sessionId,
            handle,
            ref.sessionKey,
            attempt.sessionFile,
            attempt.agentId,
          );
          markDiagnosticToolStartedForTest({
            ...ref,
            runId: attempt.runId,
            toolName: "blocked",
            toolCallId: "blocked-call",
          });
          vi.advanceTimersByTime(50_000);
          const before = getDiagnosticSessionActivitySnapshot(ref);
          prepared.onRunProgress(progress);
          expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual(before);
        },
      ),
    );
  });
});
