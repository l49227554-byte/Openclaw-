import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClientVoiceConfirmationReadiness } from "../../../talk/client-voice-confirmation-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import { relaySessions, type RelaySession } from "./state.js";
import {
  beginRelayAssistantTranscriptHold,
  beginTalkRealtimeRelayConsultTranscriptHold,
  closeRelayVoiceSession,
  enqueueRelayVoiceTranscript,
  releaseRelayAgentRunTranscriptHold,
} from "./voice.js";

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
    connId: "conn-voice-bounded",
    sessionTarget: {
      agentId: "main",
      sessionKey: "main",
      canonicalKey: "agent:main:work",
      storePath: "/tmp/relay-voice-sessions.sqlite",
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn(), debug: vi.fn() },
      chatAbortControllers: new Map(),
    },
    activeAgentRuns: new Map(),
    confirmationReadiness: createClientVoiceConfirmationReadiness({
      agentId: "main",
      voiceSessionId: "relay-voice-bounded",
      flushTranscript: async () => await session.voiceTranscriptQueue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

describe("realtime relay voice transcript persistence", () => {
  beforeEach(() => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockReset();
    voiceSessionMocks.closeRelayVoiceSessionRecord.mockReset().mockResolvedValue(undefined);
    voiceSessionMocks.createOrResumeClientVoiceSession.mockReset();
  });

  it("holds assistant finals while a consult is admitted and appends them in order afterwards", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session } = createRelaySession();
    const appended = () =>
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(([params]) => [
        (params as { role: string }).role,
        (params as { text: string }).text,
      ]);
    const release = beginRelayAssistantTranscriptHold(session);
    const nested = beginRelayAssistantTranscriptHold(session);

    expect(enqueueRelayVoiceTranscript(session, "assistant", "Let me check.")).toBe(true);
    expect(enqueueRelayVoiceTranscript(session, "user", "thanks")).toBe(true);
    expect(enqueueRelayVoiceTranscript(session, "assistant", "One moment.")).toBe(true);
    await session.voiceTranscriptQueue.flush();
    // User finals keep flowing; only assistant finals wait.
    expect(appended()).toEqual([["user", "thanks"]]);

    nested();
    await session.voiceTranscriptQueue.flush();
    expect(appended()).toEqual([["user", "thanks"]]);

    release();
    release();
    await vi.waitFor(() => expect(session.assistantTranscriptHold).toBeUndefined());
    await session.voiceTranscriptQueue.flush();
    expect(appended()).toEqual([
      ["user", "thanks"],
      ["assistant", "Let me check."],
      ["assistant", "One moment."],
    ]);
    expect(session.context.logGateway?.debug).toHaveBeenCalledWith(
      "realtime relay transcript hold release",
      expect.objectContaining({ relaySessionId: "relay-voice-bounded", held: 2 }),
    );
  });

  it("replays more held finals than the queue has pending slots without losing the tail", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session, failSession } = createRelaySession();
    const heldCount = VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount + 2;
    const release = beginRelayAssistantTranscriptHold(session);
    for (let index = 0; index < heldCount; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "assistant", `held ${index}`)).toBe(true);
    }
    expect(session.assistantTranscriptHold?.held).toHaveLength(heldCount);

    release();
    // A final spoken while the replay is still running stays behind every held final.
    expect(enqueueRelayVoiceTranscript(session, "assistant", "after release")).toBe(true);
    await vi.waitFor(() => expect(session.assistantTranscriptHold).toBeUndefined());
    await session.voiceTranscriptQueue.flush();

    expect(failSession).not.toHaveBeenCalled();
    expect(session.voiceTranscriptQueue.didOverflow).toBe(false);
    expect(
      voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(
        ([params]) => (params as { text: string }).text,
      ),
    ).toEqual([
      ...Array.from({ length: heldCount }, (_, index) => `held ${index}`),
      "after release",
    ]);
  });

  it("fails the session instead of holding more text than the queue budget allows", () => {
    const { session, failSession } = createRelaySession();
    beginRelayAssistantTranscriptHold(session);
    for (let index = 0; index < VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount; index += 1) {
      expect(
        enqueueRelayVoiceTranscript(
          session,
          "assistant",
          "x".repeat(VOICE_TRANSCRIPT_QUEUE_POLICY.maxEntryChars),
        ),
      ).toBe(true);
    }
    expect(enqueueRelayVoiceTranscript(session, "assistant", "one more")).toBe(false);
    expect(failSession).toHaveBeenCalledExactlyOnceWith(
      VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage,
    );
  });

  it("keeps a client consult hold until the relay drops its run", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session } = createRelaySession();
    const chatAbortControllers = session.context.chatAbortControllers as Map<string, unknown>;
    // Unknown or foreign sessions get a no-op handle.
    beginTalkRealtimeRelayConsultTranscriptHold({
      relaySessionId: "missing",
      connId: "conn",
    }).release();
    expect(session.assistantTranscriptHold).toBeUndefined();

    relaySessions.set(session.id, session);
    try {
      const hold = beginTalkRealtimeRelayConsultTranscriptHold({
        relaySessionId: session.id,
        connId: session.connId,
      });
      expect(session.assistantTranscriptHold?.depth).toBe(1);
      session.activeAgentRuns.set("run-1", "agent:main:work");
      chatAbortControllers.set("run-1", {});
      hold.adoptRun("run-1");
      expect(enqueueRelayVoiceTranscript(session, "assistant", "checking")).toBe(true);
      await session.voiceTranscriptQueue.flush();
      expect(voiceSessionMocks.appendRelayVoiceTranscript).not.toHaveBeenCalled();

      // The relay drops the run (final tool result, cancellation, or run loss).
      session.activeAgentRuns.delete("run-1");
      releaseRelayAgentRunTranscriptHold(session, "run-1");
      await vi.waitFor(() => expect(session.assistantTranscriptHold).toBeUndefined());
      expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ role: "assistant", text: "checking" }),
      );

      // A run that vanished without a relay hook releases lazily on the next final.
      const second = beginTalkRealtimeRelayConsultTranscriptHold({
        relaySessionId: session.id,
        connId: session.connId,
      });
      second.adoptRun("run-2");
      expect(enqueueRelayVoiceTranscript(session, "assistant", "direct")).toBe(true);
      await session.voiceTranscriptQueue.flush();
      expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "direct" }),
      );
      expect(session.assistantTranscriptHold).toBeUndefined();
    } finally {
      relaySessions.delete(session.id);
    }
  });

  it.each([
    ["release", (session: RelaySession) => beginRelayAssistantTranscriptHold(session)],
    ["close", () => () => {}],
  ])(
    "waits for queue capacity behind a blocked write instead of sealing on %s",
    async (mode, begin) => {
      const firstAppend = deferred();
      voiceSessionMocks.appendRelayVoiceTranscript.mockImplementation(
        async ({ entryId }: { entryId: string }) => {
          if (entryId === "1") {
            await firstAppend.promise;
          }
        },
      );
      const { session, failSession } = createRelaySession();
      const release = begin(session);
      if (mode === "close") {
        beginRelayAssistantTranscriptHold(session);
      }
      expect(enqueueRelayVoiceTranscript(session, "assistant", "held while blocked")).toBe(true);
      expect(enqueueRelayVoiceTranscript(session, "assistant", "held second")).toBe(true);
      // A blocked first write and a full pending queue of live user finals.
      for (let index = 0; index <= VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount; index += 1) {
        expect(enqueueRelayVoiceTranscript(session, "user", `user ${index}`)).toBe(true);
      }

      const closing = mode === "close" ? closeRelayVoiceSession(session) : undefined;
      release();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(session.voiceTranscriptQueue.didOverflow).toBe(false);
      expect(failSession).not.toHaveBeenCalled();
      expect(session.assistantTranscriptHold?.held).toEqual(["held while blocked", "held second"]);

      firstAppend.resolve();
      await (closing ?? vi.waitFor(() => expect(session.assistantTranscriptHold).toBeUndefined()));
      await session.voiceTranscriptQueue.flush();
      const texts = voiceSessionMocks.appendRelayVoiceTranscript.mock.calls.map(
        ([params]) => (params as { text: string }).text,
      );
      expect(texts).toHaveLength(VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount + 3);
      expect(texts.slice(-2)).toEqual(["held while blocked", "held second"]);
      expect(failSession).not.toHaveBeenCalled();
      if (mode === "close") {
        expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
      }
    },
  );

  it("replays held finals before sealing the queue on close", async () => {
    voiceSessionMocks.appendRelayVoiceTranscript.mockResolvedValue(undefined);
    const { session } = createRelaySession();
    beginRelayAssistantTranscriptHold(session);
    const heldCount = VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount + 1;
    for (let index = 0; index < heldCount; index += 1) {
      expect(enqueueRelayVoiceTranscript(session, "assistant", `held ${index}`)).toBe(true);
    }

    await closeRelayVoiceSession(session);

    expect(voiceSessionMocks.appendRelayVoiceTranscript).toHaveBeenCalledTimes(heldCount);
    expect(voiceSessionMocks.closeRelayVoiceSessionRecord).toHaveBeenCalledOnce();
    expect(session.assistantTranscriptHold).toBeUndefined();
    expect(enqueueRelayVoiceTranscript(session, "assistant", "too late")).toBe(false);
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
