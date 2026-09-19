import { formatErrorMessage } from "../../../infra/errors.js";
import {
  appendRelayVoiceTranscript,
  closeRelayVoiceSessionRecord,
  createOrResumeClientVoiceSession,
} from "../../../talk/client-voice-session.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../talk/voice-transcript.js";
import {
  drainingRelaySessions,
  type RelayAssistantTranscriptHold,
  relaySessions,
  type RelaySession,
} from "./state.js";

const RELAY_TRANSCRIPT_RETRY_DELAYS_MS = [0, 500, 2_000] as const;
// Held finals share the queue's pending budget; a consult that outgrows it fails the session
// the same way a stalled queue does, and never silently drops a final.
const RELAY_TRANSCRIPT_HOLD_MAX_CHARS =
  VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount * VOICE_TRANSCRIPT_QUEUE_POLICY.maxEntryChars;

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
  if (!normalizedText) {
    return true;
  }
  if (role === "assistant") {
    const hold = settleRelayAssistantTranscriptHoldRuns(session);
    if (hold) {
      if (hold.heldChars + normalizedText.length > RELAY_TRANSCRIPT_HOLD_MAX_CHARS) {
        session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
        return false;
      }
      hold.held.push(normalizedText);
      hold.heldChars += normalizedText.length;
      return true;
    }
  }
  return appendRelayVoiceTranscriptEntry(session, role, normalizedText, observed) !== "rejected";
}

/**
 * Admits one normalized final into the bounded queue. Live finals seal the queue on
 * overflow (existing policy); a replayed held final asks for `capacity` instead so the
 * replay can wait for room without sealing and without losing the entry.
 */
function appendRelayVoiceTranscriptEntry(
  session: RelaySession,
  role: "user" | "assistant",
  normalizedText: string,
  observed: ReturnType<RelaySession["confirmationReadiness"]["observeUserTranscript"]>,
  options?: { sealOnOverflow: false },
): "accepted" | "capacity" | "rejected" {
  if (!ensureRelayVoiceSession(session)) {
    session.confirmationReadiness.fail(new Error("Realtime voice session could not be recorded"));
    return "accepted";
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
    { weight: normalizedText.length, ...options },
  );
  if (!admission.accepted) {
    if (admission.reason === "capacity") {
      return "capacity";
    }
    session.confirmationReadiness.fail(
      new Error("Realtime voice transcript queue is closed or full"),
    );
    if (admission.reason === "overflow") {
      session.failSession(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    }
    return "rejected";
  }
  session.voiceTranscriptSeq = transcriptSeq;
  void admission.completion.then(observed?.persisted, (error: unknown) => {
    session.confirmationReadiness.fail(error);
    logRelayVoiceFailure(session, "realtime relay transcript append failed", error);
  });
  return "accepted";
}

/**
 * Holds assistant transcript session appends while an agent consult is admitted. A spoken
 * filler persisted between the consult's keyed user turn and its adoption moves the
 * session's current-turn anchor and fails the run ("keyed user is outside the current
 * turn"). Clients, echo tracking, and spoken run control still see transcripts at once;
 * only the durable append waits. Holds nest; once the last window closes the held finals
 * replay one at a time, in their original order, through the bounded queue.
 */
export function beginRelayAssistantTranscriptHold(
  session: RelaySession | undefined,
  route: "provider" | "client" = "provider",
): () => void {
  if (!session) {
    return () => {};
  }
  settleRelayAssistantTranscriptHoldRuns(session);
  const hold = (session.assistantTranscriptHold ??= {
    depth: 0,
    held: [],
    heldChars: 0,
    runs: new Map(),
    startedAt: Date.now(),
  });
  hold.depth += 1;
  session.context.logGateway?.debug(`realtime relay transcript hold begin (${route})`, {
    relaySessionId: session.id,
    depth: hold.depth,
    held: hold.held.length,
  });
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (session.assistantTranscriptHold !== hold) {
      return;
    }
    hold.depth = Math.max(0, hold.depth - 1);
    if (hold.depth === 0) {
      void drainRelayAssistantTranscriptHold(session, hold);
    }
  };
}

/**
 * The client consult entrypoint (`talk.client.toolCall`) owns its hold from before the
 * transcript flush until the relay sees the chat run settle: a final tool result,
 * cancellation, run loss, or close. Unknown or foreign sessions get a no-op handle; the
 * caller's earlier ownership checks already rejected those.
 */
export function beginTalkRealtimeRelayConsultTranscriptHold(params: {
  relaySessionId: string;
  connId: string;
}): { adoptRun: (runId: string) => void; release: () => void } {
  const session = relaySessions.get(params.relaySessionId);
  if (!session || session.connId !== params.connId) {
    return { adoptRun: () => {}, release: () => {} };
  }
  const release = beginRelayAssistantTranscriptHold(session, "client");
  let settled = false;
  const settle = () => {
    settled = true;
    release();
  };
  return {
    release: settle,
    adoptRun: (runId) => {
      const hold = session.assistantTranscriptHold;
      if (settled || !hold) {
        return;
      }
      hold.runs.set(runId, () => {
        hold.runs.delete(runId);
        settle();
      });
    },
  };
}

/** Releases the hold window owned by a chat run the relay has just dropped. */
export function releaseRelayAgentRunTranscriptHold(session: RelaySession, runId: string): void {
  session.assistantTranscriptHold?.runs.get(runId)?.();
}

/** Run-bound windows whose run already left the relay must not keep finals waiting. */
function settleRelayAssistantTranscriptHoldRuns(
  session: RelaySession,
): RelayAssistantTranscriptHold | undefined {
  const hold = session.assistantTranscriptHold;
  if (!hold) {
    return undefined;
  }
  for (const [runId, release] of hold.runs) {
    if (!session.activeAgentRuns.has(runId) || !session.context.chatAbortControllers.has(runId)) {
      release();
    }
  }
  return session.assistantTranscriptHold;
}

/**
 * Ends every hold window now and replays the held finals; close paths await the result
 * before sealing the queue so no accepted final is lost.
 */
export function releaseRelayAssistantTranscriptHold(
  session: RelaySession,
): Promise<void> | undefined {
  const hold = session.assistantTranscriptHold;
  if (!hold) {
    return undefined;
  }
  hold.runs.clear();
  hold.depth = 0;
  hold.forced = true;
  return drainRelayAssistantTranscriptHold(session, hold);
}

/**
 * Replays held finals through bounded admission: each entry stays held until the queue
 * accepts it, and a full queue (live user finals behind a blocked write) makes the replay
 * wait for the accepted prefix to settle instead of sealing on overflow. Assistant finals
 * that arrive meanwhile join the tail; a new consult window pauses the replay until it
 * closes, unless the session is closing.
 */
function drainRelayAssistantTranscriptHold(
  session: RelaySession,
  hold: RelayAssistantTranscriptHold,
): Promise<void> {
  if (hold.drain) {
    return hold.drain;
  }
  let appended = 0;
  const drain = (async () => {
    while (session.assistantTranscriptHold === hold && (hold.depth === 0 || hold.forced)) {
      const text = hold.held[0];
      if (text === undefined) {
        session.assistantTranscriptHold = undefined;
        session.context.logGateway?.debug("realtime relay transcript hold release", {
          relaySessionId: session.id,
          held: appended,
          heldMs: Date.now() - hold.startedAt,
        });
        return;
      }
      const admission = appendRelayVoiceTranscriptEntry(session, "assistant", text, undefined, {
        sealOnOverflow: false,
      });
      if (admission === "rejected") {
        session.assistantTranscriptHold = undefined;
        session.context.logGateway?.warn(
          `realtime relay transcript hold lost ${hold.held.length} held finals: the voice transcript queue is closed`,
        );
        return;
      }
      if (admission === "accepted") {
        hold.held.shift();
        hold.heldChars -= text.length;
        appended += 1;
      }
      await session.voiceTranscriptQueue.flush();
    }
  })().finally(() => {
    if (hold.drain === drain) {
      hold.drain = undefined;
    }
  });
  hold.drain = drain;
  return drain;
}

export function closeRelayVoiceSession(session: RelaySession): Promise<void> {
  if (session.voiceSessionClose) {
    return session.voiceSessionClose;
  }
  const drained = releaseRelayAssistantTranscriptHold(session);
  const close = (): Promise<void> => {
    session.voiceTranscriptQueue.seal();
    if (!ensureRelayVoiceSession(session)) {
      return Promise.resolve();
    }
    const { agentId, sessionKey } = session.sessionTarget;
    return session.voiceTranscriptQueue
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
  };
  session.voiceSessionClose = drained ? drained.then(close) : close();
  drainingRelaySessions.add(session);
  void session.voiceSessionClose.finally(() => {
    drainingRelaySessions.delete(session);
  });
  return session.voiceSessionClose;
}
