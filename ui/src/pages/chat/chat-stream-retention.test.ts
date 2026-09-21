// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { loadChatHistory } from "./chat-history.ts";
import { assistantStreamPartOccurrence } from "./chat-progress.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { buildCachedChatItems, coalesceStreamRuns, resetChatThreadState } from "./chat-thread.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunStartup: null,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    client: null,
    connected: true,
    connectionEpoch: 0,
    hello: null,
    lastError: null,
    sessionKey: "main",
    ...overrides,
  };
}

function createTextChatMessage(
  role: "assistant" | "user",
  text: string,
  metadata?: Record<string, unknown>,
  timestamp?: number,
) {
  return {
    role,
    content: [{ type: "text" as const, text }],
    ...(metadata ? { __openclaw: metadata } : {}),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

type CachedChatItemsProps = Parameters<typeof buildCachedChatItems>[0];

function createProps(overrides: Partial<CachedChatItemsProps> = {}): CachedChatItemsProps {
  return {
    paneId: "pane-a",
    sessionKey: "main",
    runId: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

describe("stream occurrence retention", () => {
  const readingIndicator = (props: Partial<CachedChatItemsProps>) =>
    buildCachedChatItems(createProps(props)).find((item) => item.kind === "reading-indicator");

  it("keeps live tool cards when only older history has a persisted tool result", async () => {
    const olderUser = createTextChatMessage("user", "older ask", { seq: 1 });
    const olderToolResult = {
      role: "toolResult",
      toolCallId: "call_old",
      toolName: "shell",
      content: [{ type: "text", text: "old tool output" }],
      __openclaw: { seq: 2 },
    };
    const latestUser = createTextChatMessage("user", "latest ask", { seq: 3 });
    const liveToolMessage = {
      role: "assistant",
      toolCallId: "call_current",
      runId: "run-1",
      content: [{ type: "toolcall", name: "shell", arguments: {} }],
    };
    const messages = [olderUser, olderToolResult, latestUser];
    const client = createTestGatewayClient(
      vi.fn().mockResolvedValue({ messages, thinkingLevel: "low" }),
    );
    const baseState = createState({
      client,
      chatMessages: messages,
      chatRunId: "run-1",
      chatStream: "Still answering.",
      chatStreamStartedAt: 100,
    });
    const sessions = createTestSessionCapability({
      snapshot: {
        client: baseState.client,
        phase: baseState.connected ? "connected" : "reconnecting",
        hello: baseState.hello,
        sessionKey: baseState.sessionKey,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
    vi.spyOn(sessions, "listBranches").mockResolvedValue([]);
    onTestFinished(() => sessions.dispose());
    const state = {
      ...baseState,
      sessions,
      chatStreamSegments: [{ text: "before current tool", ts: 1 }],
      chatToolMessages: [liveToolMessage],
      toolStreamById: new Map([["call_current", { message: liveToolMessage }]]),
      toolStreamOrder: ["call_current"],
      toolStreamSyncTimer: null,
    };
    const part = expectDefined(
      visibleAssistantStreamParts(state, { isHiddenStreamText: () => false }).find(
        (candidate) => candidate.segmentIndex === 0,
      ),
      "live tool preamble",
    );
    const occurrenceKey = assistantStreamPartOccurrence(state, part);

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([olderUser, olderToolResult, latestUser]);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBe("Still answering.");
    expect(state.chatStreamStartedAt).toBe(100);
    expect(state.chatToolMessages).toEqual([liveToolMessage]);
    expect(state.chatStreamSegments).toEqual([
      { text: "before current tool", ts: 1, occurrenceKey },
    ]);
    expect(state.toolStreamById.size).toBe(1);
    expect(state.toolStreamOrder).toEqual(["call_current"]);
  });

  it("keeps one working row from optimistic send through acknowledgement", () => {
    resetChatThreadState();
    const sessionKey = "agent:main:working-row";
    const pendingItems = buildCachedChatItems(
      createProps({
        sessionKey,
        queue: [
          {
            id: "queued-send-1",
            text: "keep the row stable",
            createdAt: 1_000,
            sendRunId: "run-1",
            sendState: "sending",
            sendSubmittedAtMs: 10,
          },
        ],
        runWorking: true,
      }),
    );
    const pendingIndicator = expectDefined(
      pendingItems.find((item) => item.kind === "reading-indicator"),
      "pending working indicator",
    );
    const pendingRun = expectDefined(
      coalesceStreamRuns(pendingItems).find((item) => item.kind === "stream-run"),
      "pending stream run",
    );
    const pendingFrame = expectDefined(
      coalesceAgentRunFrames(coalesceStreamRuns(pendingItems)).find(
        (item) => item.kind === "agent-run-frame",
      ),
      "pending agent run frame",
    );

    const acknowledgedItems = buildCachedChatItems(
      createProps({
        sessionKey,
        runId: "run-1",
        runWorking: true,
        stream: "",
        streamStartedAt: 2_000,
      }),
    );
    const acknowledgedIndicator = expectDefined(
      acknowledgedItems.find((item) => item.kind === "reading-indicator"),
      "acknowledged working indicator",
    );
    const acknowledgedRun = expectDefined(
      coalesceStreamRuns(acknowledgedItems).find((item) => item.kind === "stream-run"),
      "acknowledged stream run",
    );
    const acknowledgedFrame = expectDefined(
      coalesceAgentRunFrames(coalesceStreamRuns(acknowledgedItems)).find(
        (item) => item.kind === "agent-run-frame",
      ),
      "acknowledged agent run frame",
    );

    expect(acknowledgedIndicator).toMatchObject({
      key: pendingIndicator.key,
      startedAt: pendingIndicator.startedAt,
    });
    expect(acknowledgedRun.key).toBe(pendingRun.key);
    expect(acknowledgedFrame.key).toBe(pendingFrame.key);

    const streamingItems = buildCachedChatItems(
      createProps({
        sessionKey,
        runId: "run-1",
        runWorking: true,
        stream: "The reply has started.",
        streamStartedAt: 2_000,
      }),
    );
    const visibleStream = expectDefined(
      streamingItems.find((item) => item.kind === "stream" && item.isStreaming),
      "visible live stream",
    );
    const streamingIndicator = expectDefined(
      streamingItems.find((item) => item.kind === "reading-indicator"),
      "streaming working indicator",
    );
    const streamingRun = expectDefined(
      coalesceStreamRuns(streamingItems).find((item) => item.kind === "stream-run"),
      "streaming run",
    );

    expect(visibleStream.key).not.toBe(pendingIndicator.key);
    expect(streamingIndicator.key).toBe(pendingIndicator.key);
    expect(streamingRun).toMatchObject({
      key: pendingRun.key,
      parts: [{ kind: "stream" }, { kind: "reading-indicator" }],
    });
    const nextDelta = buildCachedChatItems(
      createProps({
        sessionKey,
        runId: "run-1",
        runWorking: true,
        stream: "The reply has started. More detail.",
        streamStartedAt: 2_000,
      }),
    );
    expect(
      expectDefined(
        nextDelta.find((item) => item.kind === "stream" && item.isStreaming),
        "next live delta",
      ).key,
    ).toBe(visibleStream.key);

    const nextRunIndicator = expectDefined(
      readingIndicator({
        sessionKey,
        runId: "run-2",
        runWorking: true,
        stream: "",
        streamStartedAt: 3_000,
      }),
      "next run working indicator",
    );
    const otherSessionIndicator = expectDefined(
      readingIndicator({
        sessionKey: "agent:other:working-row",
        runId: "run-1",
        runWorking: true,
        stream: "",
        streamStartedAt: 2_000,
      }),
      "other session working indicator",
    );

    expect(nextRunIndicator.key).not.toBe(pendingIndicator.key);
    expect(otherSessionIndicator.key).not.toBe(pendingIndicator.key);
  });
});
