import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { testing as embeddedRunTesting } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resetClientVoiceConfirmationStateForTest } from "../../../talk/client-voice-confirmation.test-support.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/shared-types.js";
import {
  createTalkRealtimeRelaySession,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "../relay/index.js";
import { relaySessions } from "../relay/state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { talkClientHandlers } from "./client.js";

const mocks = vi.hoisted(() => ({
  chatSend: vi.fn(),
  appendRelayVoiceTranscript: vi.fn<(params: { role: string; text: string }) => Promise<void>>(
    async () => undefined,
  ),
}));

vi.mock("../../server-methods/chat-send-handler.js", () => ({
  handleTrustedInternalChatSend: mocks.chatSend,
}));

vi.mock("../../../talk/client-voice-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/client-voice-session.js")>()),
  appendRelayVoiceTranscript: mocks.appendRelayVoiceTranscript,
}));

const CFG = { agents: { entries: { main: { default: true } } } };
const toolCall = talkClientHandlers["talk.client.toolCall"];
if (!toolCall) {
  throw new Error("talk.client.toolCall handler is not registered");
}

describe("talk.client.toolCall transcript hold", () => {
  let testState: OpenClawTestState | undefined;
  let relaySessionId: string | undefined;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "talk-client-consult-hold",
      scenario: "minimal",
    });
    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
  });

  afterEach(async () => {
    if (relaySessionId) {
      try {
        await stopTalkRealtimeRelaySession({ relaySessionId, connId: "conn-1" });
      } catch {
        // already closed by the test
      }
      relaySessionId = undefined;
    }
    vi.clearAllMocks();
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    await testState?.cleanup();
    testState = undefined;
  });

  it("holds an assistant final persisted after the keyed prompt until the run settles", async () => {
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: (request) => {
        bridgeRequest = request;
        return {
          connect: vi.fn(async () => undefined),
          sendAudio: vi.fn(),
          setMediaTimestamp: vi.fn(),
          handleBargeIn: vi.fn(),
          submitToolResult: vi.fn(),
          acknowledgeMark: vi.fn(),
          close: vi.fn(),
          isConnected: vi.fn(() => true),
        };
      },
    };
    const chatAbortControllers = new Map<string, unknown>();
    const debug = vi.fn();
    const context = {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers,
      getRuntimeConfig: () => CFG,
      logGateway: { warn: vi.fn(), debug },
    };
    const sessionTarget = prepareTalkSessionTarget(CFG, "agent:main:main");
    const session = createTalkRealtimeRelaySession({
      context: context as never,
      connId: "conn-1",
      cfg: CFG,
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      sessionTarget,
      controlSource: "transcript",
    });
    relaySessionId = session.relaySessionId;
    const relay = relaySessions.get(session.relaySessionId);
    if (!relay || !bridgeRequest) {
      throw new Error("relay session did not start");
    }
    const appendedTexts = () =>
      mocks.appendRelayVoiceTranscript.mock.calls.map(([params]) => params.text);

    // The consult's keyed user turn is staged inside chat.send before the ACK; a voice
    // final that lands in that window is the reported race (#150204).
    const acked = createDeferred();
    mocks.chatSend.mockImplementationOnce(async (request: GatewayRequestHandlerOptions) => {
      expect(relay.assistantTranscriptHold?.depth).toBe(1);
      bridgeRequest?.onTranscript?.("assistant", "Let me check that for you.", true);
      await relay.voiceTranscriptQueue.flush();
      expect(appendedTexts()).toEqual([]);
      chatAbortControllers.set("run-1", {
        controller: new AbortController(),
        sessionId: "embedded-1",
        sessionKey: "agent:main:main",
        agentId: "main",
        ownerConnId: "conn-1",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        startedAtMs: 1,
        expiresAtMs: Date.now() + 60_000,
      });
      request.respond(true, { runId: "run-1", status: "started" }, undefined);
      acked.resolve();
    });

    const respond = vi.fn();
    relay.harness.talk.startTurn({ turnId: "turn-1" });
    await toolCall({
      req: { type: "req", id: "1", method: "talk.client.toolCall" },
      params: {
        sessionKey: "agent:main:main",
        relaySessionId: session.relaySessionId,
        voiceSessionId: session.relaySessionId,
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "what time is it on the gateway machine" },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond,
      context: context as never,
      sessionMutationAuthorization: {
        talkSessionTarget: sessionTarget,
        assertCurrent: () => {},
        assertTargetCurrent: () => {},
      },
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "run-1" }),
      undefined,
    );
    await acked.promise;
    expect(debug).toHaveBeenCalledWith(
      "realtime relay transcript hold begin (client)",
      expect.objectContaining({ relaySessionId: session.relaySessionId, depth: 1 }),
    );

    // The run is registered and still active: the final keeps waiting.
    expect(relay.activeAgentRuns.get("run-1")).toBe("agent:main:main");
    bridgeRequest.onTranscript?.("assistant", "Still checking.", true);
    await relay.voiceTranscriptQueue.flush();
    expect(appendedTexts()).toEqual([]);
    expect(relay.assistantTranscriptHold?.held).toHaveLength(2);

    // The client submits the run's final result; the relay drops the run and the held
    // finals replay in order behind the consult.
    await submitTalkRealtimeRelayToolResult({
      relaySessionId: session.relaySessionId,
      connId: "conn-1",
      callId: "call-1",
      result: { text: "It is 10:13 PM." },
    });
    expect(relay.activeAgentRuns.size).toBe(0);
    await vi.waitFor(() => expect(relay.assistantTranscriptHold).toBeUndefined());
    await relay.voiceTranscriptQueue.flush();
    expect(appendedTexts()).toEqual(["Let me check that for you.", "Still checking."]);
    expect(debug).toHaveBeenCalledWith(
      "realtime relay transcript hold release",
      expect.objectContaining({ relaySessionId: session.relaySessionId, held: 2 }),
    );
  });

  it("releases the hold when chat.send never starts a run", async () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "relay-test",
      label: "Relay Test",
      isConfigured: () => true,
      createBridge: () => ({
        connect: vi.fn(async () => undefined),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        handleBargeIn: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        isConnected: vi.fn(() => true),
      }),
    };
    const context = {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => CFG,
      logGateway: { warn: vi.fn(), debug: vi.fn() },
    };
    const sessionTarget = prepareTalkSessionTarget(CFG, "agent:main:main");
    const session = createTalkRealtimeRelaySession({
      context: context as never,
      connId: "conn-1",
      cfg: CFG,
      provider,
      providerConfig: {},
      instructions: "brief",
      tools: [],
      sessionTarget,
      controlSource: "transcript",
    });
    relaySessionId = session.relaySessionId;
    const relay = relaySessions.get(session.relaySessionId);
    mocks.chatSend.mockImplementationOnce(async (request: GatewayRequestHandlerOptions) => {
      expect(relay?.assistantTranscriptHold?.depth).toBe(1);
      request.respond(false, undefined, { code: "UNAVAILABLE", message: "no run" });
    });

    const respond = vi.fn();
    await toolCall({
      req: { type: "req", id: "2", method: "talk.client.toolCall" },
      params: {
        sessionKey: "agent:main:main",
        relaySessionId: session.relaySessionId,
        callId: "call-2",
        name: "openclaw_agent_consult",
        args: { question: "anything" },
      },
      client: { connId: "conn-1" } as never,
      isWebchatConnect: () => false,
      respond,
      context: context as never,
      sessionMutationAuthorization: {
        talkSessionTarget: sessionTarget,
        assertCurrent: () => {},
        assertTargetCurrent: () => {},
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "no run" }),
    );
    await vi.waitFor(() => expect(relay?.assistantTranscriptHold).toBeUndefined());
  });
});
