import { emitContinuationDisabledSpan } from "../../infra/continuation-tracer.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import type { ContinuationSignalExtraction } from "../continuation/signal.js";
import { withContinuationOwner } from "../continuation/system-event-ownership.js";

// Emits the shared bracket continuation cap-gate rejection diagnostics
// (log line + trusted system event + `continuation.disabled` span). Split out
// of agent-runner-continuation-signal.ts to keep it within the max-lines
// budget. Behavior/order is identical to the monolith's inline reject paths.
export function emitBracketContinuationRejected(params: {
  sessionKey: string;
  ownerAgentId: string | undefined;
  signal: NonNullable<ContinuationSignalExtraction["signal"]>;
  defaultDelayMs: number;
  chainId: string | undefined;
  chainStepRemaining: number;
  disabledReason: "cap.chain" | "cap.cost";
  logMessage: string;
  systemEventMessage: string;
}): void {
  const {
    sessionKey,
    ownerAgentId,
    signal,
    defaultDelayMs,
    chainId,
    chainStepRemaining,
    disabledReason,
    logMessage,
    systemEventMessage,
  } = params;
  defaultRuntime.log(logMessage);
  enqueueSystemEvent(
    systemEventMessage,
    withContinuationOwner({ sessionKey, trusted: true }, ownerAgentId),
  );
  const isDelegate = signal.kind === "delegate";
  const delegateMode = isDelegate
    ? signal.silentWake
      ? "silent-wake"
      : signal.silent
        ? "silent"
        : "normal"
    : undefined;
  const delegateDelivery: "immediate" | "timer" | undefined = isDelegate
    ? (signal.delayMs ?? defaultDelayMs) > 0
      ? "timer"
      : "immediate"
    : undefined;
  emitContinuationDisabledSpan({
    chainId,
    chainStepRemaining,
    disabledReason,
    signalKind: isDelegate ? "bracket-delegate" : "bracket-work",
    delegateDelivery,
    delegateMode,
    log: defaultRuntime.log,
  });
}
