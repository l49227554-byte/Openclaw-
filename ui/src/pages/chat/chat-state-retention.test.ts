import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as assistantIdentity from "../../app/assistant-identity.ts";
import { buildFallbackSlashCommands, replaceSlashCommands } from "../../lib/chat/commands.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { assistantStreamPartOccurrence } from "./chat-progress.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

beforeEach(() => {
  vi.spyOn(assistantIdentity, "loadLocalAssistantIdentity").mockReturnValue({
    avatar: "data:image/png;base64,bG9jYWw=",
  });
});

afterEach(() => {
  replaceSlashCommands(buildFallbackSlashCommands());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal stream occurrence retention", () => {
  function createSessionEventState(overrides: Partial<ChatPageHost> = {}) {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      sessionId: "selected-session",
      thinkingLevel: null,
    });
    const requestUpdate = overrides.requestUpdate ?? vi.fn();
    const host = makeChatHost({
      client: createTestGatewayClient(request),
      connectionEpoch: 1,
      sessionKey: "agent:main:main",
      ...overrides,
    });
    if (!overrides.sessions) {
      vi.spyOn(host.sessions, "reconcileChanged").mockImplementation(() => ({
        applied: false,
        result: host.sessions.state.result,
      }));
      vi.spyOn(host.sessions, "refresh").mockResolvedValue(undefined);
      vi.spyOn(host.sessions, "listBranches").mockResolvedValue([]);
    }
    const state = {
      ...host,
      currentSessionId: "selected-session",
      chatMessagesBySession: new Map(),
      chatThinkingLevel: null,
      chatVerboseLevel: null,
      chatStreamStartedAt: null,
      renderLifecycle: { invalidate: requestUpdate },
      requestUpdate,
      ...overrides,
    };
    return { request, state };
  }

  it("retires the complete transient projection when the durable terminal arrives", () => {
    const runId = "active-run";
    const siblingRunId = "sibling-run";
    const finalText = "The durable terminal reply.";
    const toolMessage = { role: "assistant", runId, toolCallId: "tool-1" };
    const siblingToolMessage = {
      role: "assistant",
      runId: siblingRunId,
      toolCallId: "tool-2",
    };
    const toolIdentity = buildToolStreamIdentity(runId, "tool-1");
    const siblingToolIdentity = buildToolStreamIdentity(siblingRunId, "tool-2");
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [],
      chatRunId: runId,
      chatStream: finalText,
      chatStreamStartedAt: 1,
      chatStreamSegments: [
        { text: "Commentary", ts: 1, runId, itemId: "commentary-1" },
        {
          text: "Sibling commentary",
          ts: 1,
          runId: siblingRunId,
          itemId: "commentary-2",
        },
      ],
      chatToolMessages: [toolMessage, siblingToolMessage],
      toolStreamById: new Map([
        [
          toolIdentity,
          {
            message: toolMessage,
            name: "exec",
            receivedAt: 1,
            runId,
            startedAt: 1,
            toolCallId: "tool-1",
          },
        ],
        [
          siblingToolIdentity,
          {
            message: siblingToolMessage,
            name: "read",
            receivedAt: 1,
            runId: siblingRunId,
            startedAt: 1,
            toolCallId: "tool-2",
          },
        ],
      ]),
      toolStreamOrder: [toolIdentity, siblingToolIdentity],
      activityEventSeqById: new Map([
        [`tool:${JSON.stringify([runId, "tool-1"])}:result`, 2],
        [`tool:${JSON.stringify([siblingRunId, "tool-2"])}:result`, 2],
      ]),
      knownAgentRunIds: new Set([runId, siblingRunId]),
      waitingApprovalStatuses: new Map([
        ["approval-1", { approvalId: "approval-1", toolCallId: "tool-1", runId }],
        ["approval-2", { approvalId: "approval-2", toolCallId: "tool-2", runId: siblingRunId }],
      ]),
    });
    const part = expectDefined(
      visibleAssistantStreamParts(state, { isHiddenStreamText: () => false }).find(
        (candidate) => candidate.segmentIndex === 1,
      ),
      "sibling commentary",
    );
    const occurrenceKey = assistantStreamPartOccurrence(state, part);

    applySessionMessagePayload(
      state,
      {
        sessionKey: state.sessionKey,
        runId,
        messageId: "terminal-message",
        messageSeq: 2,
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          timestamp: 2,
        },
      },
      false,
      { kind: "live", activeRunId: runId },
    );

    expect(state.chatMessages.filter((message) => extractText(message) === finalText)).toHaveLength(
      1,
    );
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamSegments).toEqual([
      {
        text: "Sibling commentary",
        ts: 1,
        runId: siblingRunId,
        itemId: "commentary-2",
        occurrenceKey,
      },
    ]);
    expect(state.chatToolMessages).toEqual([siblingToolMessage]);
    expect(state.toolStreamById.has(toolIdentity)).toBe(false);
    expect(state.toolStreamById.has(siblingToolIdentity)).toBe(true);
    expect(state.toolStreamOrder).toEqual([siblingToolIdentity]);
    expect(state.knownAgentRunIds).toEqual(new Set([siblingRunId]));
    expect([
      ...expectDefined(state.waitingApprovalStatuses, "remaining approval statuses").keys(),
    ]).toEqual(["approval-2"]);
    expect([...(state.activityEventSeqById?.keys() ?? [])]).toEqual([
      `tool:${JSON.stringify([siblingRunId, "tool-2"])}:result`,
    ]);
  });
});
