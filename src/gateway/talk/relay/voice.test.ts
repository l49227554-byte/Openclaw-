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
  setActiveTurn: (turnId: string | undefined) => void;
} {
  const failSession = vi.fn(() => {
    void closeRelayVoiceSession(session);
  });
  // The Talk controller exposes activeTurnId as a getter, so the fixture owns the value.
  let activeTurnId: string | undefined;
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
    // Deferring a final is only safe while a turn is live to settle it.
    harness: {
      talk: {
        get activeTurnId() {
          return activeTurnId;
        },
      },
    },
    failSession,
  } as unknown as RelaySession;
  return {
    session,
    failSession,
    setActiveTurn: (turnId) => {
      activeTurnId = turnId;
    },
  };
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

  // Regression for #150610: a realtime provider re-finalizes one growing input item, so a
  // single spoken sentence reaches the relay as several talkFinal transcripts. Only the
  // provider's own item id proves they are revisions of one utterance.
  it("keeps one user row when the provider re-finalizes one input item", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session, setActiveTurn } = createRelaySession();
    setActiveTurn("turn-1");

    for (const text of [
      "Hey chief.",
      "Hey Chief, what is the weather in New York?",
      "Hey Chief, what is the weather in New York right now?",
    ]) {
      expect(enqueueRelayVoiceTranscript(session, "user", text, "item_a")).toBe(true);
    }
    await closeRelayVoiceSession(session);

    expect(appendedUserTexts()).toEqual(["Hey Chief, what is the weather in New York right now?"]);
  });

  // Text similarity cannot stand in for identity: "Hi." is a prefix of "History please.",
  // and repeated identical speech is indistinguishable from a re-transcription.
  it("keeps distinct input items apart even when their text overlaps", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session, setActiveTurn } = createRelaySession();
    setActiveTurn("turn-1");

    expect(enqueueRelayVoiceTranscript(session, "user", "Hi.", "item_a")).toBe(true);
    expect(enqueueRelayVoiceTranscript(session, "user", "History please.", "item_b")).toBe(true);
    expect(enqueueRelayVoiceTranscript(session, "user", "History please.", "item_c")).toBe(true);
    await closeRelayVoiceSession(session);

    expect(appendedUserTexts()).toEqual(["Hi.", "History please.", "History please."]);
  });

  it("appends every final when the provider supplies no item id", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session, setActiveTurn } = createRelaySession();
    setActiveTurn("turn-1");

    expect(enqueueRelayVoiceTranscript(session, "user", "Hey chief.")).toBe(true);
    expect(enqueueRelayVoiceTranscript(session, "user", "Hey chief, the weather?")).toBe(true);
    await closeRelayVoiceSession(session);

    expect(appendedUserTexts()).toEqual(["Hey chief.", "Hey chief, the weather?"]);
  });

  // A provider may complete input transcription after the turn ended. Nothing is left to
  // settle a held final then, so it must not be deferred.
  it("appends an identified final when no turn is live to settle it", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session, setActiveTurn } = createRelaySession();
    setActiveTurn(undefined);

    expect(enqueueRelayVoiceTranscript(session, "user", "Late one.", "item_a")).toBe(true);
    expect(appendedUserTexts()).toEqual(["Late one."]);

    await closeRelayVoiceSession(session);
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
