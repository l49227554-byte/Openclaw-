import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isIndexedSessionEntry } from "../../../agents/sessions/session-manager-codec.js";
import { formatSqliteSessionFileMarker } from "../../../config/sessions/legacy-sqlite-marker.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { controlBridge, controlContext } from "../client-gateway-control.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createTalkRealtimeRelaySession, flushTalkRealtimeRelayVoiceWrites } from "./index.js";
import { closeRelaySession } from "./operations.js";
import { relaySessions, type RelaySession } from "./state.js";

const connId = "relay-voice-persistence-client";
const agentId = "main";
const sessionKey = "agent:main:main";

/**
 * Regression for #150610, driven through the registered relay entry point against a real
 * transcript store. A realtime provider re-finalizes one growing input item, so a single
 * spoken sentence arrives as several talkFinal transcripts. Only the provider's own input
 * item id can tell a revision from a distinct utterance, so these exercise the real
 * provider callback rather than a mocked append.
 */
describe("realtime relay voice transcript rows", () => {
  let state: OpenClawTestState;
  let ownedRelay: RelaySession | undefined;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-voice-rows", applyEnv: true });
    await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey });
  });

  afterEach(async () => {
    if (ownedRelay) {
      await closeRelaySession(ownedRelay, "completed");
      ownedRelay = undefined;
    }
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  async function startRelay() {
    const cfg = { agents: { entries: { main: { default: true } } } };
    let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
    const session = createTalkRealtimeRelaySession({
      cfg,
      context: controlContext(),
      connId,
      sessionTarget: prepareTalkSessionTarget(cfg, sessionKey),
      controlSource: "delegation",
      provider: {
        id: "relay-voice-rows-provider",
        label: "Relay voice rows provider",
        isConfigured: () => true,
        createBridge: (options) => {
          bridgeRequest = options;
          return controlBridge();
        },
      },
      providerConfig: {},
      instructions: "Answer briefly.",
      tools: [],
    });
    const relay = relaySessions.get(session.relaySessionId);
    const onTranscript = bridgeRequest?.onTranscript;
    const onEvent = bridgeRequest?.onEvent;
    if (!relay || !bridgeRequest || !onTranscript || !onEvent) {
      throw new Error("expected a registered relay with transcript and event callbacks");
    }
    ownedRelay = relay;
    bridgeRequest.onReady?.();
    onEvent({ direction: "server", type: "response.created", responseId: "response-1" });
    const scope = {
      agentId,
      sessionId: "main",
      sessionKey,
      storePath: relay.sessionTarget.storePath,
    };
    await upsertSessionEntryCore(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const userRows = async () =>
      (await loadTranscriptEvents(scope))
        .filter(isIndexedSessionEntry)
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message as { role: string; content?: { text?: string }[] })
        .filter((message) => message.role === "user")
        .map((message) => message.content?.[0]?.text ?? "");
    const flush = () => flushTalkRealtimeRelayVoiceWrites({ relaySessionId: relay.id, connId });
    return { relay, request: bridgeRequest, onTranscript, onEvent, flush, userRows };
  }

  it("persists one row when the provider re-finalizes one input item", async () => {
    const { onTranscript, flush, userRows } = await startRelay();

    for (const text of [
      "What is the current date and",
      "What is the current date and time on the gateway machine?",
      "What is the current date and time on the Gateway machine? Please check.",
    ]) {
      onTranscript("user", text, true, "item_a");
    }
    await flush();

    expect(await userRows()).toEqual([
      "What is the current date and time on the Gateway machine? Please check.",
    ]);
  });

  it("persists a row per input item even when their text overlaps", async () => {
    const { onTranscript, flush, userRows } = await startRelay();

    // "Hi." is a text prefix of "History please." — only the item id separates them.
    onTranscript("user", "Hi.", true, "item_a");
    onTranscript("user", "History please.", true, "item_b");
    onTranscript("user", "History please.", true, "item_c");
    await flush();

    expect(await userRows()).toEqual(["Hi.", "History please.", "History please."]);
  });

  // OpenAI allows input transcription to finish after the response events, so a completed
  // user transcript can arrive once the turn has already ended. Nothing is left to settle a
  // held final at that point, so it must persist immediately. Drained directly rather than
  // through flushTalkRealtimeRelayVoiceWrites, which would settle it and hide the defect.
  it("persists a completed final that arrives after the response ended", async () => {
    const { relay, request, onTranscript, userRows } = await startRelay();

    request.onResponseDone?.({ responseId: "response-1", status: "completed" });
    onTranscript("user", "Late transcription of my question.", true, "item_a");
    await relay.voiceTranscriptQueue.flush();

    expect(await userRows()).toEqual(["Late transcription of my question."]);
  });

  it("persists a held final when its response is cancelled", async () => {
    const { relay, request, onTranscript, userRows } = await startRelay();

    onTranscript("user", "Cancel that and check the time.", true, "item_a");
    // A cancelled response suppresses assistant transcripts, so nothing else would settle
    // the held final. The response terminal must drain it on its own -- so this drains the
    // queue directly rather than through flushTalkRealtimeRelayVoiceWrites, which settles
    // the pending final itself and would mask a missing drain.
    request.onResponseDone?.({ responseId: "response-1", status: "cancelled" });
    await relay.voiceTranscriptQueue.flush();

    expect(await userRows()).toEqual(["Cancel that and check the time."]);
  });
});
