import { relaySessions, type RelaySession } from "./state.js";

/** How long a cancelled turn waits for the provider to confirm the cancelled response. */
const TURN_BOUND_CANCELLATION_DRAIN_MS = 1_000;
/** How long a stale generation may keep the output fence before the relay reconnects. */
const STALE_OUTPUT_FENCE_MAX_MS = 30_000;

/**
 * Bounds a cancellation drain. When the provider never confirms the cancelled response,
 * the relay completes the cancellation locally instead of closing the session.
 *
 * Gemini Live has no response.cancel: its bridge interrupts through input audio
 * (server-side VAD) or, on Extended Thinking, a client turn, and only reports the response
 * done at its own turnComplete. Closing at the deadline ended every Google relay call on
 * the first stop or barge-in. Completing locally releases microphone audio and tool
 * results, and the stale generation's output stays fenced until that generation ends at a
 * provider boundary or continuity resets. Elapsed time never admits it: a provider that
 * keeps the fence past the watchdog fails the session so the client reconnects.
 */
export function scheduleRelayCancellationDeadline(
  session: RelaySession,
  params: { turnId: string; reason: string; terminalEpoch: number },
): void {
  setTimeout(() => {
    if (
      relaySessions.get(session.id) !== session ||
      session.toolResultEpoch !== params.terminalEpoch ||
      session.outputOwnership.phase !== "cancelling"
    ) {
      return;
    }
    const fenceId = session.outputOwnership.completeCancellationLocally();
    if (fenceId === undefined) {
      return;
    }
    session.context.logGateway.warn(
      `talk relay: provider did not confirm output cancellation within ${TURN_BOUND_CANCELLATION_DRAIN_MS}ms; keeping the session open and discarding stale output (reason=${params.reason}, turnId=${params.turnId})`,
    );
    setTimeout(() => {
      if (
        relaySessions.get(session.id) === session &&
        session.outputOwnership.isDiscarding(fenceId)
      ) {
        session.failSession("Realtime provider never ended a cancelled response. Reconnecting.");
      }
    }, STALE_OUTPUT_FENCE_MAX_MS).unref?.();
  }, TURN_BOUND_CANCELLATION_DRAIN_MS).unref?.();
}
