import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import type { RelaySession } from "./state.js";
import { closeRelayVoiceSession, enqueueRelayVoiceTranscript } from "./voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
}));

vi.mock("../../../talk/client-voice-session.js", () => voiceSessionMocks);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function createRelaySession(): {
  session: RelaySession;
  failSession: ReturnType<typeof vi.fn>;
} {
  const failSession = vi.fn(() => {
    void closeRelayVoiceSession(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionTarget: {
      agentId: "main",
      sessionKey: "main",
      canonicalKey: "agent:main:work",
      storePath: "/tmp/relay-voice-sessions.sqlite",
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    confirmationReadiness: createClientVoiceConfirmationReadiness({
      agentId: "main",
      voiceSessionId: "relay-voice-bounded",
      flushTranscript: async () => await session.voiceTranscriptQueue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    // The relay turn owner delimits one spoken utterance; see ensureRelayTurn.
    harness: { talk: { activeTurnId: undefined as string | undefined } },
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

function appendedUserTexts(): string[] {
  return voiceSessionMocks.appendRelayVoiceTranscript.mock.calls
    .map(([params]) => params as { role: string; text: string })
    .filter((params) => params.role === "user")
    .map((params) => params.text);
}

describe("realtime relay voice transcript persistence", () => {
  beforeEach(() => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockReset();
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReset();
  });

  it("bounds stalled finals, drains the accepted prefix, and closes once", async () => {
    const firstAppend = deferred();
    voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(
      async ({ entryId }: { entryId: string }) => {
        if (entryId === "1") {
          await firstAppend.promise;
        }
      },
    );
    const { session, failSession } = createRelaySession();
    let accepted = enqueueRelayVoiceTranscript(session, "user", `  ${"x".repeat(9_000)}  `) ? 1 : 0;

    for (let index = 0; index < 10_000; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "user", " \t\n ")).toBe(true);
    }

    for (let index = 1; index < 10_000; index += 1) {
      if (
        enqueueRelayVoiceTranscript(
          session,
          index % 2 === 0 ? "user" : "assistant",
          `  ${"x".repeat(9_000)}  `,
        )
      ) {
        accepted += 1;
      }
    }

    expect(accepted).toBe(41);
    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "main",
        sessionTarget: {
          sessionKey: "agent:main:work",
          storePath: "/tmp/relay-voice-sessions.sqlite",
        },
      }),
    );
    expect(failSession).toHaveBeenCalledOnce();
    const close = session.voiceSessionClose;
    expect(close).toBeDefined();
    expect(closeRelayVoiceSession(session)).toBe(close);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).not.toHaveBeenCalled();

    firstAppend.resolve();
    await close;

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(41);
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(
        ([params]) => (params as { entryId: string }).entryId,
      ),
    ).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.every(
        ([params]) => (params as { text: string }).text.length === 8_000,
      ),
    ).toBe(true);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
    expect(enqueueRelayVoiceTranscript(session, "user", "too late")).toBe(false);
  });

  // Regression for #150610: xAI server VAD re-finalizes one growing input item, so a
  // single spoken sentence reaches the relay as several talkFinal transcripts inside
  // one turn.started -> turn.ended window.
  it("keeps one user row when a turn re-finalizes the same utterance", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session } = createRelaySession();
    session.harness.talk.activeTurnId = "turn-1";

    for (const text of [
      "Hey chief.",
      "Hey Chief, what is the weather in New York?",
      "Hey Chief, what is the weather in New York right now?",
    ]) {
      expect(enqueueRelayVoiceTranscript(session, "user", text)).toBe(true);
    }
    await closeRelayVoiceSession(session);

    expect(appendedUserTexts()).toEqual(["Hey Chief, what is the weather in New York right now?"]);
  });

  // The turn is open before the first final only because every inbound mic frame calls
  // ensureRelayTurn (operations.ts). enqueueRelayVoiceTranscript itself runs before the
  // ensureRelayTurn in session-create.ts, so without a live turn there is no window to
  // supersede within and each final keeps its own row. Pin that boundary explicitly.
  it("appends every final when no turn is live", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session } = createRelaySession();
    session.harness.talk.activeTurnId = undefined;

    expect(enqueueRelayVoiceTranscript(session, "user", "Hey chief.")).toBe(true);
    expect(enqueueRelayVoiceTranscript(session, "user", "Hey Chief, what is the weather?")).toBe(
      true,
    );
    await closeRelayVoiceSession(session);

    expect(appendedUserTexts()).toEqual(["Hey chief.", "Hey Chief, what is the weather?"]);
  });

  it("keeps a separate user row per turn and per distinct utterance", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session } = createRelaySession();

    session.harness.talk.activeTurnId = "turn-1";
    expect(enqueueRelayVoiceTranscript(session, "user", "What is the weather?")).toBe(true);
    // A genuine second utterance inside the same turn is not a refinement of the first.
    expect(enqueueRelayVoiceTranscript(session, "user", "Also, cancel my alarm.")).toBe(true);
    session.harness.talk.activeTurnId = "turn-2";
    expect(enqueueRelayVoiceTranscript(session, "user", "What is the weather?")).toBe(true);
    await closeRelayVoiceSession(session);

    expect(appendedUserTexts()).toEqual([
      "What is the weather?",
      "Also, cancel my alarm.",
      "What is the weather?",
    ]);
  });

  it("terminally closes the durable record after bounded transcript retries fail", async () => {
    vi.useFakeTimers();
    try {
      voiceSessionMocks.appendRelayVoiceTranscript.mockRejectedValue(
        new Error("transcript write failed"),
      );
      const { session } = createRelaySession();

      expect(enqueueRelayVoiceTranscript(session, "user", "persist me")).toBe(true);
      const close = closeRelayVoiceSession(session);
      await vi.runAllTimersAsync();
      await close;

      expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(3);
      expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
      expect(session.context.logGateway?.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("realtime relay transcript append failed"),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
