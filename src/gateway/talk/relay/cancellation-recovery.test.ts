/**
 * Tests relay output cancellation when the provider cannot confirm the cancelled response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { resolveRealtimeVoiceProviderCapabilities } from "../../../talk/provider-resolver.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import {
  cancelTalkRealtimeRelayTurn,
  createTalkRealtimeRelaySession,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
} from "./index.js";
import { drainingRelaySessions, relaySessions } from "./state.js";

const activeRelaySessions = new Map<string, string>();

function makeRelayTransport(overrides: Partial<RealtimeVoiceBridge> = {}) {
  return {
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    handleBargeIn: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  };
}

function createRelayFixture(transportOverrides: Partial<RealtimeVoiceBridge> = {}) {
  let request: RealtimeVoiceBridgeCreateRequest | undefined;
  const transport = makeRelayTransport(transportOverrides);
  const provider: RealtimeVoiceProviderPlugin = {
    id: "relay-test",
    label: "Relay Test",
    isConfigured: () => true,
    createBridge: (bridgeRequest) => {
      request = bridgeRequest;
      return transport;
    },
  };
  const broadcastToConnIds = vi.fn();
  const warn = vi.fn();
  const cfg = { agents: { entries: { main: { default: true } } } } as OpenClawConfig;
  const capabilities = resolveRealtimeVoiceProviderCapabilities({
    provider,
    providerConfig: {},
    cfg,
    surface: "gateway-relay",
  });
  const session = createTalkRealtimeRelaySession({
    context: {
      broadcastToConnIds,
      broadcast: vi.fn(),
      logGateway: { warn },
      chatAbortControllers: new Map(),
    } as never,
    connId: "conn-1",
    provider,
    providerConfig: {},
    instructions: "brief",
    tools: [],
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    cfg,
    sessionTarget: prepareTalkSessionTarget(cfg, "agent:main:main"),
  });
  activeRelaySessions.set(session.relaySessionId, "conn-1");
  const relay = relaySessions.get(session.relaySessionId);
  if (!request || !relay) {
    throw new Error("expected the relay to create its bridge");
  }
  const payloadsOfType = (type: string) =>
    broadcastToConnIds.mock.calls
      .map(([, payload]) => payload)
      .filter(
        (payload): payload is Record<string, unknown> =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as Record<string, unknown>).type === type,
      );
  return {
    relaySessionId: session.relaySessionId,
    relay,
    request,
    transport,
    warn,
    payloadsOfType,
  };
}

function ensureActiveRelayTurnId(relaySessionId: string): string {
  const relay = relaySessions.get(relaySessionId);
  if (!relay) {
    throw new Error(`Missing relay test session ${relaySessionId}`);
  }
  if (!relay.harness.talk.activeTurnId) {
    relay.harness.talk.startTurn({ turnId: "turn-1" });
  }
  return relay.harness.talk.activeTurnId ?? "turn-1";
}

async function cancelPastDeadline(fixture: ReturnType<typeof createRelayFixture>) {
  const cancellation = cancelTalkRealtimeRelayTurn({
    relaySessionId: fixture.relaySessionId,
    connId: "conn-1",
    turnId: ensureActiveRelayTurnId(fixture.relaySessionId),
  });
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
  expect(fixture.relay.outputOwnership.discarding).toBe(true);
}

/** The phone captures continuously; a microphone frame re-arms a turn, then the reply speaks. */
async function speakFreshReply(fixture: ReturnType<typeof createRelayFixture>) {
  await sendTalkRealtimeRelayAudio({
    relaySessionId: fixture.relaySessionId,
    connId: "conn-1",
    audioBase64: "AQI=",
  });
  fixture.request.onAudio(Buffer.from("fresh audio"));
}

describe("talk realtime relay cancellation recovery", () => {
  let testState: OpenClawTestState | undefined;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "talk-realtime-relay-cancellation",
      scenario: "minimal",
    });
    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  });

  afterEach(async () => {
    try {
      for (const [relaySessionId, connId] of activeRelaySessions) {
        try {
          await stopTalkRealtimeRelaySession({ relaySessionId, connId });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("Unknown realtime relay session")
          ) {
            throw error;
          }
        }
      }
      await Promise.all(
        [...drainingRelaySessions].map(
          (session) =>
            session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
        ),
      );
    } finally {
      activeRelaySessions.clear();
      vi.useRealTimers();
      clientVoiceSessionTesting.reset();
      resetClientVoiceConfirmationStateForTest();
      await testState?.cleanup();
      testState = undefined;
    }
  });

  it("keeps a stalled turn-bound cancellation open after its drain deadline and discards the stale generation", async () => {
    vi.useFakeTimers();
    const pending = createDeferred();
    const fixture = createRelayFixture({ submitToolResult: vi.fn(() => pending.promise) });
    const { relaySessionId, relay, request, transport, payloadsOfType } = fixture;

    let cancellationSettled = false;
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId,
      connId: "conn-1",
      reason: "android-stop-tts",
      turnId: ensureActiveRelayTurnId(relaySessionId),
    });
    void cancellation.then(() => (cancellationSettled = true));
    const pendingAudio = Promise.resolve(
      sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" }),
    );
    let audioSettled = false;
    void pendingAudio.then(
      () => (audioSettled = true),
      () => (audioSettled = true),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(cancellationSettled).toBe(false);
    expect(audioSettled).toBe(false);
    expect(transport.sendAudio).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    // The session stays open, microphone audio flows again, and the stall is logged.
    await expect(pendingAudio).resolves.toBeUndefined();
    expect(transport.sendAudio).toHaveBeenCalledOnce();
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(transport.close).not.toHaveBeenCalled();
    expect(fixture.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not confirm output cancellation"),
    );

    // Output from the interrupted generation is dropped until the provider reports it done.
    const audioBefore = payloadsOfType("audio").length;
    const transcriptsBefore = payloadsOfType("transcript").length;
    request.onAudio(Buffer.from("stale audio"));
    request.onTranscript?.("assistant", "stale words", true);
    request.onToolCall?.({
      itemId: "stale-item",
      callId: "stale-call",
      name: "custom_tool",
      args: {},
    });
    expect(payloadsOfType("audio")).toHaveLength(audioBefore);
    expect(payloadsOfType("transcript")).toHaveLength(transcriptsBefore);
    expect(payloadsOfType("toolCall")).toHaveLength(0);
    expect(relay.outputOwnership.discarding).toBe(true);

    const freshTurnId = relay.harness.talk.activeTurnId;
    expect(freshTurnId).toBeDefined();
    request.onResponseDone?.({ status: "cancelled" });
    expect(relay.outputOwnership.discarding).toBe(false);
    // The stale generation's boundary retires the fence without settling the fresh turn.
    expect(relay.harness.talk.activeTurnId).toBe(freshTurnId);
    // The phone captures continuously; the next microphone frame re-arms a turn for the reply.
    await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" });
    request.onAudio(Buffer.from("fresh audio"));
    expect(payloadsOfType("audio")).toHaveLength(audioBefore + 1);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    pending.resolve();
  });

  it("keeps an exact-response relay open when cancellation is never confirmed", async () => {
    vi.useFakeTimers();
    const { relaySessionId, relay, request, transport, payloadsOfType } = createRelayFixture();
    request.onEvent?.({ direction: "server", type: "response.created", responseId: "response-1" });

    let cancellationSettled = false;
    const cancellation = cancelTalkRealtimeRelayTurn({
      relaySessionId,
      connId: "conn-1",
      turnId: ensureActiveRelayTurnId(relaySessionId),
    });
    void cancellation.then(() => (cancellationSettled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(cancellationSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(cancellation).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(transport.close).not.toHaveBeenCalled();

    // The stale response's late audio is discarded until a replacement response starts.
    const before = payloadsOfType("audio").length;
    request.onAudio(Buffer.from("stale audio"));
    expect(payloadsOfType("audio")).toHaveLength(before);
    relay.harness.talk.startTurn({ turnId: "turn-next" });
    request.onEvent?.({ direction: "server", type: "response.created", responseId: "response-2" });
    request.onAudio(Buffer.from("fresh audio"));
    expect(payloadsOfType("audio")).toHaveLength(before + 1);
  });

  it("keeps a still-generating stale reply fenced and reconnects instead of admitting it", async () => {
    vi.useFakeTimers();
    const fixture = createRelayFixture();
    const { relaySessionId, request, transport, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);
    // Microphone input opened another turn; the cancelled reply is still generating.
    await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" });
    const before = payloadsOfType("audio").length;
    for (let second = 0; second < 29; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      request.onAudio(Buffer.from("stale audio"));
      request.onTranscript?.("assistant", "stale words", true);
    }
    expect(payloadsOfType("audio")).toHaveLength(before);
    expect(payloadsOfType("transcript").filter((p) => p.role === "assistant")).toHaveLength(0);
    expect(payloadsOfType("error")).toHaveLength(0);
    expect(transport.close).not.toHaveBeenCalled();

    // Elapsed time never admits the stale generation: the watchdog reconnects instead.
    await vi.advanceTimersByTimeAsync(1_000);
    request.onAudio(Buffer.from("stale audio"));
    expect(payloadsOfType("audio")).toHaveLength(before);
    expect(payloadsOfType("error")).toEqual([
      expect.objectContaining({ message: expect.stringContaining("Reconnecting") }),
    ]);
    expect(relaySessions.has(relaySessionId)).toBe(false);
  });

  it("does not let an earlier cancellation's watchdog retire a later cancellation's fence", async () => {
    vi.useFakeTimers();
    const fixture = createRelayFixture();
    const { relaySessionId, relay, request, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);
    // Cancellation A's generation ends at its provider boundary.
    request.onResponseDone?.({ status: "completed" });
    expect(relay.outputOwnership.discarding).toBe(false);
    const beforeFresh = payloadsOfType("audio").length;
    await speakFreshReply(fixture);
    expect(payloadsOfType("audio")).toHaveLength(beforeFresh + 1);

    // Cancellation B stalls too and fences its own generation.
    await cancelPastDeadline(fixture);
    await vi.advanceTimersByTimeAsync(29_500);
    // A's watchdog has fired and must leave B's fence and the session alone.
    expect(relay.outputOwnership.discarding).toBe(true);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    const beforeStale = payloadsOfType("audio").length;
    request.onAudio(Buffer.from("stale audio from B"));
    expect(payloadsOfType("audio")).toHaveLength(beforeStale);

    request.onResponseDone?.({ status: "cancelled" });
    await vi.advanceTimersByTimeAsync(1_000);
    // B's watchdog is a no-op once B's generation has retired.
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(payloadsOfType("error")).toHaveLength(0);
    await speakFreshReply(fixture);
    expect(payloadsOfType("audio")).toHaveLength(beforeStale + 1);
  });

  it("clears the discard fence when provider continuity resets during a discard", async () => {
    vi.useFakeTimers();
    const fixture = createRelayFixture();
    const { relaySessionId, relay, request, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);

    // A non-resumable reconnect replaces the provider generation without a response.created.
    request.onEvent?.({ direction: "client", type: "session.continuity.reset" });
    expect(relay.outputOwnership.discarding).toBe(false);
    request.onEvent?.({ direction: "server", type: "session.created" });
    request.onReady?.();

    const before = payloadsOfType("audio").length;
    await speakFreshReply(fixture);
    request.onTranscript?.("assistant", "replacement words", true);
    expect(payloadsOfType("audio")).toHaveLength(before + 1);
    expect(payloadsOfType("transcript").filter((p) => p.role === "assistant")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(payloadsOfType("error")).toHaveLength(0);
  });

  it("settles a cancellation that overlaps a fence when the fenced generation ends", async () => {
    vi.useFakeTimers();
    const fixture = createRelayFixture();
    const { relaySessionId, relay, request, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);
    // Microphone input opens turn B while A is still fenced, and B is cancelled before A ends.
    await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" });
    let settled = false;
    const cancellationB = cancelTalkRealtimeRelayTurn({ relaySessionId, connId: "conn-1" });
    void cancellationB.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);

    // A's end is the only generation boundary B can get; it settles B without a new fence.
    request.onResponseDone?.({ status: "cancelled" });
    await expect(cancellationB).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    expect(relay.outputOwnership.phase).toBe("unowned");
    expect(relay.outputOwnership.discarding).toBe(false);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fixture.warn).toHaveBeenCalledOnce();
    expect(relay.outputOwnership.discarding).toBe(false);
    const before = payloadsOfType("audio").length;
    await speakFreshReply(fixture);
    expect(payloadsOfType("audio")).toHaveLength(before + 1);
    expect(payloadsOfType("error")).toHaveLength(0);
  });

  it("coalesces an overlapping cancellation's deadline into the held fence", async () => {
    vi.useFakeTimers();
    const fixture = createRelayFixture();
    const { relaySessionId, relay, request, payloadsOfType } = fixture;
    await cancelPastDeadline(fixture);
    await sendTalkRealtimeRelayAudio({ relaySessionId, connId: "conn-1", audioBase64: "AQI=" });
    const cancellationB = cancelTalkRealtimeRelayTurn({ relaySessionId, connId: "conn-1" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(cancellationB).resolves.toEqual({ status: "applied", turnId: expect.any(String) });
    expect(relay.outputOwnership.discarding).toBe(true);

    // A's end retires the one shared fence; no fence is left for a generation that ended.
    request.onResponseDone?.({ status: "cancelled" });
    expect(relay.outputOwnership.discarding).toBe(false);
    const before = payloadsOfType("audio").length;
    await speakFreshReply(fixture);
    expect(payloadsOfType("audio")).toHaveLength(before + 1);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(relaySessions.has(relaySessionId)).toBe(true);
    expect(payloadsOfType("error")).toHaveLength(0);
  });
});
