import { formatErrorMessage } from "../../../infra/errors.js";
import { createClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation-readiness.js";
import { readClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation.js";
import {
  appendRelayVoiceTranscript,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
} from "../../../talk/client-voice-session.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../talk/voice-transcript.js";
import { drainingRelaySessions, type RelaySession } from "./state.js";

const RELAY_TRANSCRIPT_RETRY_DELAYS_MS = [0, 500, 2_000] as const;

function logRelayVoiceFailure(session: RelaySession, message: string, error: unknown): void {
  session.context.logGateway?.warn(`${message}: ${formatErrorMessage(error)}`);
}

export function ensureRelayVoiceSession(session: RelaySession): boolean {
  if (session.voiceSessionCreated) {
    return true;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  try {
    createOrResumeClientVoiceSession({
      agentId,
      sessionKey,
      provider: session.provider,
      origin: "relay",
      voiceSessionId: session.id,
    });
    session.voiceSessionCreated = true;
    return true;
  } catch (error) {
    logRelayVoiceFailure(session, "realtime relay voice session create failed", error);
    return false;
  }
}

/**
 * Server VAD re-finalizes one growing input item, so a single spoken sentence can
 * reach the relay as several finals. The durable transcript is append-only and
 * idempotent by event id -- re-appending one entry id with revised text is rejected
 * as an admission conflict -- so the refinement must win before the row is written.
 */
function continuesPendingUtterance(pendingText: string, nextText: string): boolean {
  const comparable = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const pending = comparable(pendingText);
  return pending.length > 0 && comparable(nextText).startsWith(pending);
}

/** Write the turn's held user final once the utterance can no longer grow. */
export function commitPendingRelayVoiceTranscript(session: RelaySession | undefined): boolean {
  const pending = session?.voicePendingUserFinal;
  if (!session || !pending) {
    return true;
  }
  session.voicePendingUserFinal = undefined;
  return appendRelayVoiceTranscriptEntry(session, "user", pending.text, pending.observed);
}

/**
 * Anything that gates on finalized user speech must settle the held final first:
 * readiness blocks on the pending observation before it ever flushes the queue.
 */
export function settleRelayVoiceSpeech(
  session: RelaySession | undefined,
  gate: (session: RelaySession) => Promise<void>,
): Promise<void> {
  commitPendingRelayVoiceTranscript(session);
  return session ? gate(session) : Promise.resolve();
}

/** Readiness for one relay session; its flush contract owns the held final. */
export function createRelayVoiceConfirmationReadiness(
  agentId: string,
  voiceSessionId: string,
  getActiveRelay: () => RelaySession | undefined,
): RelaySession["confirmationReadiness"] {
  return createClientVoiceConfirmationReadiness({
    agentId,
    voiceSessionId,
    flushTranscript: () =>
      settleRelayVoiceSpeech(getActiveRelay(), (relay) => relay.voiceTranscriptQueue.flush()),
  });
}

export function enqueueRelayVoiceTranscript(
  session: RelaySession,
  role: "user" | "assistant",
  text: string,
): boolean {
  const observed =
    role === "user" && !session.closing
      ? session.confirmationReadiness.observeUserTranscript(text, true)
      : undefined;
  const normalizedText = normalizeVoiceTranscriptText(text);
  if (role !== "user") {
    // Assistant output never joins a held user utterance, but it must not overtake one.
    if (!commitPendingRelayVoiceTranscript(session)) {
      return false;
    }
    return normalizedText
      ? appendRelayVoiceTranscriptEntry(session, role, normalizedText, observed)
      : true;
  }
  if (!normalizedText) {
    return true;
  }
  // A live spoken-confirmation challenge is already blocked on this final's durable
  // row, so it keeps the immediate append; only ordinary speech is held and refined.
  const turnId = readClientVoiceConfirmationReadiness(session.sessionTarget.agentId, session.id)
    ? undefined
    : session.harness?.talk?.activeTurnId;
  const pending = session.voicePendingUserFinal;
  if (
    pending &&
    pending.turnId !== undefined &&
    pending.turnId === turnId &&
    continuesPendingUtterance(pending.text, normalizedText)
  ) {
    // The superseded observation owns no row; release it so readiness never waits on it.
    pending.observed?.persisted();
    session.voicePendingUserFinal = { turnId, text: normalizedText, observed };
    return true;
  }
  if (!commitPendingRelayVoiceTranscript(session)) {
    return false;
  }
  if (turnId === undefined) {
    // No live turn owns this final, so there is no window to supersede within.
    return appendRelayVoiceTranscriptEntry(session, role, normalizedText, observed);
  }
  session.voicePendingUserFinal = { turnId, text: normalizedText, observed };
  return true;
}

function appendRelayVoiceTranscriptEntry(
  session: RelaySession,
  role: "user" | "assistant",
  normalizedText: string,
  observed: ReturnType<RelaySession["confirmationReadiness"]["observeUserTranscript"]>,
): boolean {
  if (!ensureRelayVoiceSession(session)) {
    session.confirmationReadiness.fail(new Error("Realtime voice session could not be recorded"));
    return true;
  }
  const transcriptSeq = session.voiceTranscriptSeq + 1;
  const entryId = String(transcriptSeq);
  const { agentId, sessionKey, canonicalKey, storePath } = session.sessionTarget;
  const admission = session.voiceTranscriptQueue.enqueue(
    async () => {
      let lastError: unknown;
      for (const delayMs of RELAY_TRANSCRIPT_RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        try {
          await appendRelayVoiceTranscript({
            agentId,
            sessionKey,
            sessionTarget: { sessionKey: canonicalKey, storePath },
            voiceSessionId: session.id,
            entryId,
            role,
            text: normalizedText,
            confirmation: observed?.confirmation ?? null,
            ...(session.voiceConfig ? { config: session.voiceConfig } : {}),
          });
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
    { weight: normalizedText.length },
  );
  if (!admission.accepted) {
    session.confirmationReadiness.fail(
      new Error("Realtime voice transcript queue is closed or full"),
    );
    if (admission.reason === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return false;
  }
  session.voiceTranscriptSeq = transcriptSeq;
  void admission.completion.then(observed?.persisted, (error: unknown) => {
    session.confirmationReadiness.fail(error);
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  });
  return true;
}

export function closeRelayVoiceSession(session: RelaySession): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  commitPendingRelayVoiceTranscript(session);
  session.voiceTranscriptQueue.seal();
  if (!ensureRelayVoiceSession(session)) {
    session.voiceSessionClose = Promise.resolve();
    return session.voiceSessionClose;
  }
  const { agentId, sessionKey } = session.sessionTarget;
  session.voiceSessionClose = session.voiceTranscriptQueue
    .flush()
    .then(async () => {
      const config = session.voiceConfig ?? session.context.getRuntimeConfig();
      await closeRelayVoiceSessionRecord({
        agentId,
        sessionKey,
        voiceSessionId: session.id,
        config,
      });
    })
    .catch((error: unknown) => {
      logRelayVoiceFailure(session, "realtime relay voice session close failed", error);
    });
  drainingRelaySessions.add(session);
  void session.voiceSessionClose.finally(() => {
    drainingRelaySessions.delete(session);
  });
  return session.voiceSessionClose;
}
