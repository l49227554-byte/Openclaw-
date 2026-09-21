// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { assistantStreamPartOccurrence, resetWorkingProgress } from "./chat-progress.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";
import { reconcileChatRunFromSessionRow, reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { resolveAssistantTextTail } from "./stream-causal-boundary.ts";
import {
  materializeVisibleStreamState,
  visibleAssistantStreamParts,
} from "./stream-reconciliation.ts";
import { collectAssistantStreamRetirement } from "./stream-retirement.ts";
import { readLiveTerminalDisposition } from "./terminal-message-identity.ts";

function message(role: string, text: string, metadata?: Record<string, unknown>) {
  return { role, content: [{ type: "text", text }], ...(metadata ? { __openclaw: metadata } : {}) };
}

function createState(requestHandlers?: Record<string, unknown>) {
  return makeChatHost({
    requestHandlers,
    sessionKey: "agent:main:main",
    chatRunId: "run-1",
    chatStream: "The answer.",
    chatStreamStartedAt: 2,
    chatMessages: [message("user", "Ask", { id: "prompt", seq: 1, idempotencyKey: "run-1:user" })],
  });
}

function streamKeys(state: ReturnType<typeof createState>) {
  return buildChatItems({
    paneId: "occurrence-proof",
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    runLifecycleGeneration: state.chatRunLifecycleGeneration,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    streamSegments: state.chatStreamSegments,
    queue: state.chatQueue,
    showToolCalls: true,
    runWorking: true,
  }).flatMap((item) => (item.kind === "stream" ? [item.key] : []));
}

function occurrenceKeys(state: ReturnType<typeof createState>) {
  const keys = getChatSessionProjection(state).entries.flatMap((entry) =>
    entry.occurrenceKey === undefined ? [] : [entry.occurrenceKey],
  );
  expect(new Set(keys).size).toBe(keys.length);
  return keys;
}

function finish(state: ReturnType<typeof createState>, text = "The answer.") {
  handleChatGatewayEvent(state, {
    sessionKey: state.sessionKey,
    runId: state.chatRunId ?? "run-1",
    state: "final",
    message: message("assistant", text),
  });
}

afterEach(resetWorkingProgress);

describe("chat occurrence publication", () => {
  it.each([
    ["done", null],
    ["failed", "error"],
    ["killed", "aborted"],
    ["timeout", "timeout"],
  ] as const)("retains a partial body's terminal disposition for %s", (status, disposition) => {
    const state = createState();
    const before = streamKeys(state);
    reconcileChatRunFromSessionRow(
      state,
      { key: state.sessionKey, kind: "direct", hasActiveRun: false, status, lastRunId: "run-1" },
      { publishRunStatus: false },
    );
    expect(occurrenceKeys(state)).toEqual(before);
    expect(readLiveTerminalDisposition(state.chatMessages.at(-1))).toBe(disposition);
    const groups = groupMessages(
      state.chatMessages.map((entry, index) => ({
        kind: "message",
        key: `message:${index}`,
        message: entry,
      })),
    );
    const frame = coalesceAgentRunFrames(groups.filter((item) => item.kind === "group")).find(
      (item) => item.kind === "agent-run-frame",
    );
    expect(frame?.outcome.kind).toBe(status === "done" ? "completed" : "failed");
  });

  it("materializes the selected terminal row before either saved publication or final", () => {
    const state = createState();
    const before = streamKeys(state);
    expect(
      reconcileChatRunFromSessionRow(
        state,
        {
          key: state.sessionKey,
          kind: "direct",
          hasActiveRun: false,
          status: "done",
          lastRunId: "run-1",
        },
        { publishRunStatus: false },
      ),
    ).toBe(true);
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(occurrenceKeys(state)).toEqual(before);
    expect(getChatSessionProjection(state).entries.at(-1)?.live).toBe(true);
    const saved = message("assistant", "The answer.", {
      id: "answer",
      seq: 2,
      runId: "run-1",
      runTerminal: true,
    });
    reduceChatSessionProjection(state, { type: "messagePersisted", message: saved });
    expect(occurrenceKeys(state)).toEqual(before);
    finish(state);
    for (let reload = 0; reload < 2; reload += 1) {
      reduceChatSessionProjection(state, {
        type: "snapshotLoaded",
        messages: structuredClone([state.chatMessages[0], saved]),
      });
      expect(occurrenceKeys(state)).toEqual(before);
    }
  });

  it.each([false, true])(
    "reconciles combined saved output after terminal-row materialization of two bodies (later durable=%s)",
    (laterDurable) => {
      const state = createState();
      const user = state.chatMessages[0];
      const later = message("assistant", "Later durable answer.", {
        id: "later",
        seq: 3,
        runId: "run-1",
      });
      if (laterDurable) {
        state.chatMessages.push(later);
      }
      state.chatStreamSegments = [{ text: "First. ", ts: 1, runId: "run-1" }];
      state.chatStream = "First. Second.";
      expect(streamKeys(state)).toHaveLength(2);
      reconcileChatRunFromSessionRow(
        state,
        {
          key: state.sessionKey,
          kind: "direct",
          hasActiveRun: false,
          status: "done",
          lastRunId: "run-1",
        },
        { publishRunStatus: false },
      );
      expect(state.chatMessages).toHaveLength(laterDurable ? 4 : 3);
      const saved = message("assistant", "First. Second.", {
        id: "combined",
        seq: 2,
        runId: "run-1",
        runTerminal: true,
      });
      applySessionMessagePayload(
        state,
        { message: saved, runId: "run-1", messageId: "combined", messageSeq: 2 },
        false,
        { kind: "live", activeRunId: null },
      );
      expect(state.chatMessages).toEqual([user, saved, ...(laterDurable ? [later] : [])]);
      expect(occurrenceKeys(state)).toEqual([]);
    },
  );

  it("counts an adopted untokened durable target when it also consumes a fallback", () => {
    const state = createState();
    const user = state.chatMessages[0];
    state.chatMessages.push(
      message("assistant", "Earlier saved text.", { id: "answer", seq: 2, runId: "run-1" }),
    );
    reconcileChatRunFromSessionRow(
      state,
      {
        key: state.sessionKey,
        kind: "direct",
        hasActiveRun: false,
        status: "done",
        lastRunId: "run-1",
      },
      { publishRunStatus: false },
    );
    expect(occurrenceKeys(state)).toHaveLength(1);
    const saved = message("assistant", "The answer.", {
      id: "answer",
      seq: 2,
      runId: "run-1",
      runTerminal: true,
    });
    applySessionMessagePayload(
      state,
      { message: saved, runId: "run-1", messageId: "answer", messageSeq: 2 },
      false,
      { kind: "live", activeRunId: null },
    );
    expect(state.chatMessages).toEqual([user, saved]);
    expect(occurrenceKeys(state)).toEqual([]);
  });

  it.each(["failed", "killed", "timeout"] as const)(
    "marks only the last owned body terminal for a multi-body %s row",
    (status) => {
      const state = createState();
      state.chatMessages.push({
        ...message("toolResult", "Tool output", { id: "tool", seq: 2, runId: "run-1" }),
        timestamp: 1.5,
      });
      state.chatStreamSegments = [{ text: "First. ", ts: 1, runId: "run-1" }];
      state.chatStream = "First. Second.";
      reconcileChatRunFromSessionRow(
        state,
        { key: state.sessionKey, kind: "direct", hasActiveRun: false, status, lastRunId: "run-1" },
        { publishRunStatus: false },
      );
      const assistants = getChatSessionProjection(state)
        .entries.filter((entry) => entry.identity?.role === "assistant")
        .map((entry) => entry.message);
      expect(assistants).toHaveLength(2);
      expect
        .soft(assistants.map(readLiveTerminalDisposition))
        .toEqual([
          null,
          status === "timeout" ? "timeout" : status === "failed" ? "error" : "aborted",
        ]);
      const items = groupMessages(
        state.chatMessages.map((entry, index) => ({
          kind: "message",
          key: `message:${index}`,
          message: entry,
        })),
      );
      const frames = coalesceAgentRunFrames(items.filter((item) => item.kind === "group"));
      const frame = frames.find((item) => item.kind === "agent-run-frame");
      expect(frame?.outcome.kind).toBe("failed");
      expect(
        frame?.parts.flatMap((part) => (part.kind === "group" ? part.messages : [])),
      ).toHaveLength(3);
    },
  );

  it.each([1, 2, -2])(
    "does not pick a keyed occurrence owner from %i matching saved rows",
    async (count) => {
      const user = message("user", "Ask", { id: "prompt", seq: 1, idempotencyKey: "run-1:user" });
      const saved = Array.from({ length: Math.abs(count) }, (_, index) => ({
        ...message("assistant", `Saved body ${index}.`, {
          id: `saved-${index}`,
          seq: index + 2,
          runId: "run-1",
        }),
        openclawStreamFallback: { itemId: "same-item", source: "segment" },
      }));
      if (count < 0) {
        saved.reverse();
      }
      const state = createState({ "chat.history": { messages: [user, ...saved] } });
      state.chatStream = null;
      state.chatStreamSegments = [
        { itemId: "same-item", text: "Live body.", ts: 1, runId: "run-1" },
      ];
      const before = streamKeys(state);
      expect(before).toHaveLength(1);
      await loadChatHistory(state, { deferBranches: true });
      expect(state.lastError).toBeNull();
      expect(state.chatMessages).toEqual([user, ...saved]);
      expect(streamKeys(state)).toEqual([]);
      expect(occurrenceKeys(state)).toEqual(count === 1 ? before : []);
    },
  );

  it.each([false, true])(
    "does not materialize a surviving segment at terminal retirement (untagged=%s)",
    (untagged) => {
      const state = createState();
      state.chatStreamSegments = [
        {
          text: "Foreign work.",
          ts: 1,
          ...(untagged ? {} : { runId: "foreign", itemId: "foreign-item" }),
        },
      ];
      if (untagged) {
        state.toolStreamOrder = ["tool"];
        state.toolStreamById.set("tool", {
          toolCallId: "tool",
          runId: "run-1",
          name: "read",
          startedAt: 1,
          receivedAt: 1,
          message: {},
        });
      }
      const foreign = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false }).find(
        (part) => part.source === "segment",
      );
      expect(foreign).toBeDefined();
      if (!foreign) {
        throw new Error("missing foreign fixture");
      }
      const foreignKey = assistantStreamPartOccurrence(state, foreign);
      const ownKey = streamKeys(state).find((key) => key !== foreignKey);
      reconcileChatRunFromSessionRow(
        state,
        {
          key: state.sessionKey,
          kind: "direct",
          hasActiveRun: false,
          status: "done",
          lastRunId: "run-1",
        },
        { publishRunStatus: false },
      );
      expect(occurrenceKeys(state)).toEqual([ownKey]);
      expect(streamKeys(state)).toEqual([foreignKey]);
    },
  );

  it("counts untokened predecessors when a retirement combines bodies", () => {
    const state = createState();
    const part = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false })[0];
    if (!part) {
      throw new Error("missing current fixture");
    }
    const untokened = message("assistant", "Earlier body.");
    state.chatMessages.push(untokened);
    const target = message("assistant", "Earlier body. The answer.");
    const retirement = collectAssistantStreamRetirement(state);
    retirement.replace(part, [target]);
    retirement.replaceMessages([untokened], target);
    retirement.publish([state.chatMessages[0], target]);
    expect(occurrenceKeys(state)).toEqual([]);
  });

  it("keeps an existing row's occurrence when it already covers resumed output", () => {
    const state = createState();
    const before = streamKeys(state);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "run-1",
      seq: 10,
      state: "error",
      errorMessage: "Temporary failure",
    });
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "run-1",
      seq: 11,
      state: "delta",
      message: message("assistant", "The answer."),
    });
    reconcileChatRunFromSessionRow(
      state,
      {
        key: state.sessionKey,
        kind: "direct",
        hasActiveRun: false,
        status: "done",
        lastRunId: "run-1",
      },
      { publishRunStatus: false },
    );
    expect(occurrenceKeys(state)).toEqual(before);
  });

  it("does not reuse an interrupted body's occurrence when the same run resumes", () => {
    const state = createState();
    const first = streamKeys(state);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "run-1",
      seq: 10,
      state: "error",
      errorMessage: "Temporary failure",
    });
    expect(occurrenceKeys(state)).toEqual(first);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "run-1",
      seq: 11,
      state: "delta",
      message: message("assistant", "A different answer."),
    });
    const resumed = streamKeys(state);
    expect(resumed).toHaveLength(1);
    expect(resumed).not.toEqual(first);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "run-1",
      seq: 12,
      state: "final",
      message: message("assistant", "A different answer."),
    });
    expect(occurrenceKeys(state)).toEqual([...first, ...resumed]);
  });

  it("retains a current body when persistence arrives before final", () => {
    const state = createState();
    const before = streamKeys(state);
    const saved = message("assistant", "The answer.", {
      id: "answer",
      seq: 2,
      runId: "run-1",
      runTerminal: true,
    });
    applySessionMessagePayload(
      state,
      {
        message: saved,
        runId: "run-1",
        messageId: "answer",
        messageSeq: 2,
      },
      false,
      { kind: "live", activeRunId: "run-1" },
    );
    expect(state.chatStream).toBeNull();
    expect(occurrenceKeys(state)).toEqual(before);
    finish(state);
    expect(occurrenceKeys(state)).toEqual(before);
  });

  it("retains a current body when a history snapshot arrives before final", async () => {
    const state = createState({
      "chat.history": {
        messages: [
          message("user", "Ask", { id: "prompt", seq: 1, idempotencyKey: "run-1:user" }),
          message("assistant", "The answer.", {
            id: "answer",
            seq: 2,
            runId: "run-1",
            runTerminal: true,
          }),
        ],
      },
    });
    const before = streamKeys(state);
    await loadChatHistory(state, { deferBranches: true });
    expect(state.lastError).toBeNull();
    expect(streamKeys(state)).toEqual([]);
    expect(occurrenceKeys(state)).toEqual(before);
    finish(state);
    expect(occurrenceKeys(state)).toEqual(before);
  });

  it("gives a new cumulative tail its own occurrence after a persisted prefix", () => {
    const state = createState();
    const first = streamKeys(state);
    const persist = (text: string, id: string, seq: number) =>
      applySessionMessagePayload(
        state,
        {
          message: message("assistant", text, { id, seq, runId: "run-1" }),
          runId: "run-1",
          messageId: id,
          messageSeq: seq,
        },
        true,
        { kind: "live", activeRunId: "run-1" },
      );
    persist("The answer.", "first", 2);
    expect(occurrenceKeys(state)).toEqual(first);
    state.chatStream = "The answer. More output.";
    const next = streamKeys(state);
    expect(next).toHaveLength(1);
    expect(next).not.toEqual(first);
    state.chatStream += " Still more.";
    expect(streamKeys(state)).toEqual(next);
    persist("More output. Still more.", "second", 3);
    expect(occurrenceKeys(state)).toEqual([...first, ...next]);
    expect(streamKeys(state)).toEqual([]);
  });

  it("uses the raw cumulative start before whitespace and directive sanitization", () => {
    const state = createState();
    const prefix = "[[reply_to_current]]Already saved.\n\n";
    state.chatStreamSegments = [{ text: prefix, ts: 1, runId: "run-1", persisted: true }];
    state.chatStream = prefix + "   Next body.";
    const [part] = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false });
    expect(part?.sourceStart).toBe(prefix.length);
    expect(part?.text).toBe("Next body.");
    const before = streamKeys(state);
    expect(before).toEqual(part ? [assistantStreamPartOccurrence(state, part)] : []);
    state.chatStream += " More.";
    expect(streamKeys(state)).toEqual(before);
  });

  it.each([false, true])(
    "retains a foreign segment through selective cleanup (keyed=%s)",
    (keyed) => {
      const state = createState();
      state.chatStream = null;
      state.chatStreamSegments = [
        { text: "Own output.", ts: 1, runId: "run-1" },
        {
          text: "Foreign output.",
          ts: 2,
          runId: "run-other",
          ...(keyed ? { itemId: "preamble" } : {}),
        },
      ];
      const before = streamKeys(state);
      expect(before).toHaveLength(2);
      const foreign = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false }).find(
        (part) => part.runId === "run-other",
      );
      const foreignKey = foreign ? assistantStreamPartOccurrence(state, foreign) : undefined;
      expect(before).toContain(foreignKey);
      reconcileChatRunLifecycle(state, {
        runId: "run-1",
        clearLocalRun: true,
        clearChatStream: true,
        clearToolStreamForRun: true,
      });
      expect(state.chatRunLifecycleGeneration).toBe(1);
      expect(streamKeys(state)).toEqual([foreignKey]);
      expect(state.chatStreamSegments[0]?.occurrenceKey).toBe(foreignKey);
    },
  );

  it.each(["split", "combined"] as const)(
    "resets an ambiguous %s snapshot retirement",
    async (shape) => {
      const saved = (text: string, id: string, seq: number) =>
        message("assistant", text, { id, seq, runId: "run-1" });
      const state = createState({
        "chat.history": {
          messages: [
            message("user", "Ask", { id: "prompt", seq: 1, idempotencyKey: "run-1:user" }),
            ...(shape === "split"
              ? [saved("First.", "first", 2), saved("Second.", "second", 3)]
              : [saved("First. Second.", "combined", 2)]),
          ],
        },
      });
      state.chatStream = "First. Second.";
      if (shape === "combined") {
        state.chatStreamSegments = [{ text: "First. ", ts: 1, runId: "run-1" }];
      }
      expect(streamKeys(state)).toHaveLength(shape === "split" ? 1 : 2);
      await loadChatHistory(state, { deferBranches: true });
      expect(state.lastError).toBeNull();
      expect(streamKeys(state)).toEqual([]);
      expect(occurrenceKeys(state)).toEqual([]);
    },
  );

  it("resets a partly retired body without assigning its identity to the saved prefix", () => {
    const state = createState();
    state.chatStream = "First. Second.";
    const before = streamKeys(state);
    applySessionMessagePayload(
      state,
      {
        message: message("assistant", "First.", { id: "first", seq: 2, runId: "run-1" }),
        runId: "run-1",
        messageId: "first",
        messageSeq: 2,
      },
      true,
      { kind: "live", activeRunId: "run-1" },
    );
    expect(occurrenceKeys(state)).toEqual([]);
    expect(streamKeys(state)).toHaveLength(1);
    expect(streamKeys(state)).not.toEqual(before);
  });

  it.each(["session", "leaf"] as const)(
    "does not carry current identity into a replaced %s snapshot",
    async (replacement) => {
      const saved = message("assistant", "The answer.", { id: "answer", seq: 2, runId: "run-1" });
      const state = createState({
        "chat.history": {
          messages: [
            message("user", "Ask", { id: "prompt", seq: 1, idempotencyKey: "run-1:user" }),
            saved,
          ],
          sessionId: replacement === "session" ? "session-new" : "session-old",
          sessionInfo: { activeLeafEntryId: replacement === "leaf" ? "leaf-new" : "leaf-old" },
        },
      });
      state.currentSessionId = "session-old";
      state.chatDisplayedLeafEntryId = "leaf-old";
      expect(streamKeys(state)).toHaveLength(1);
      await loadChatHistory(state, { deferBranches: true });
      expect(state.lastError).toBeNull();
      expect(state.chatMessages).toContainEqual(saved);
      expect(occurrenceKeys(state)).toEqual([]);
    },
  );

  it.each([
    { candidates: [null, "First.", null, "Second."], source: "First. Second.", consumer: 3 },
    { candidates: ["Complete.", "Unrelated."], source: "Complete.", consumer: 0 },
    { candidates: ["Complete.", null], source: "Complete.", consumer: 0 },
    {
      candidates: ["First.", "Mismatch.", "Second."],
      source: "First. Second.",
      consumer: undefined,
    },
  ])("reports only an accepted consuming source $consumer", ({ candidates, source, consumer }) => {
    const receipts: number[] = [];
    resolveAssistantTextTail(candidates, source, (index) => receipts.push(index));
    expect(receipts).toEqual(consumer === undefined ? [] : [consumer]);
  });

  it("does not credit arbitrary abort replacement when old history already covers a body", () => {
    const state = createState();
    state.chatStream = null;
    state.chatStreamSegments = [{ text: "Already saved.", ts: 2, runId: "run-1" }];
    state.chatMessages.push(
      message("assistant", "Already saved.", { id: "saved", seq: 2, runId: "run-1" }),
    );
    const replacements: unknown[] = [];
    const result = materializeVisibleStreamState(state.chatMessages, state, {
      replacementMessages: [message("assistant", "An unrelated aborted answer.")],
      isHiddenStreamText: () => false,
      isHiddenAssistantMessage: () => false,
      onReplace: (_part, targets) => replacements.push(...targets),
    });
    expect(result).toBe(state.chatMessages);
    expect(replacements).toEqual([state.chatMessages[1]]);
  });
  it.each([false, true])(
    "keeps consecutive runs distinct with reused segment identity (keyed=%s)",
    (keyed) => {
      const state = createState();
      const expected: string[] = [];
      for (const runId of ["run-1", "run-2"]) {
        state.chatRunId = runId;
        state.chatStream = null;
        state.chatStreamSegments = [
          { text: "The answer.", ts: 2, runId, ...(keyed ? { itemId: "reused" } : {}) },
        ];
        if (runId === "run-2") {
          state.chatMessages.push(
            message("user", "Again", { id: "prompt-2", seq: 3, idempotencyKey: "run-2:user" }),
          );
        }
        expected.push(...streamKeys(state));
        finish(state);
        expect(occurrenceKeys(state)).toEqual(expected);
      }
      expect(new Set(expected).size).toBe(2);
    },
  );

  it("keeps unacknowledged stream and segment keys stable when the run is acknowledged", () => {
    const state = createState();
    state.chatRunId = null;
    state.chatStreamSegments = [{ itemId: "preamble", text: "Checking.", ts: 1 }];
    const before = streamKeys(state);
    state.chatRunId = "run-1";
    expect(streamKeys(state)).toEqual(before);
    finish(state);
    expect(occurrenceKeys(state)).toEqual(before);
  });
  it("transfers the rendered current body through final and repeated durable adoption", () => {
    const state = createState();
    const before = streamKeys(state);
    expect(before).toHaveLength(1);
    finish(state);
    expect(occurrenceKeys(state)).toEqual(before);
    const saved = message("assistant", "The answer.", {
      id: "answer",
      seq: 2,
      runId: "run-1",
      runTerminal: true,
    });
    for (let reload = 0; reload < 2; reload += 1) {
      reduceChatSessionProjection(state, {
        type: "snapshotLoaded",
        messages: structuredClone([state.chatMessages[0], saved]),
      });
      expect(occurrenceKeys(state)).toEqual(before);
    }
  });

  it("does not assign the first final's occurrence to another same-run final", () => {
    const state = createState();
    const before = streamKeys(state);
    finish(state);
    finish(state, "A distinct final.");
    expect(state.chatMessages).toHaveLength(3);
    expect(occurrenceKeys(state)).toEqual(before);
    expect(getChatSessionProjection(state).entries.at(-1)?.occurrenceKey).toBeUndefined();
  });

  it("keeps keyed commentary and current output as distinct occurrences", () => {
    const state = createState();
    state.chatStreamSegments = [{ itemId: "preamble-1", text: "Checking.", runId: "run-1", ts: 1 }];
    const before = streamKeys(state);
    finish(state);
    expect(occurrenceKeys(state)).toEqual(before);
  });

  it("transfers an exact keyed final only when the append owner replaces it", () => {
    const state = createState();
    state.chatStream = null;
    state.chatStreamSegments = [{ itemId: "answer-1", text: "The answer.", runId: "run-1", ts: 2 }];
    const before = streamKeys(state);
    finish(state);
    expect(state.chatMessages).toHaveLength(2);
    expect(occurrenceKeys(state)).toEqual(before);
  });

  it("does not pretend multiple stream bodies are one retained occurrence", () => {
    const state = createState();
    state.chatStreamSegments = [{ text: "First. ", runId: "run-1", ts: 1 }];
    state.chatStream = "First. Second.";
    expect(streamKeys(state)).toHaveLength(2);
    finish(state, "First. Second.");
    expect(state.chatMessages).toHaveLength(2);
    expect(occurrenceKeys(state)).toEqual([]);
  });

  it.each(["error", "aborted"] as const)(
    "materializes interrupted output once for %s",
    (status) => {
      const state = createState();
      const before = streamKeys(state);
      handleChatGatewayEvent(state, {
        sessionKey: state.sessionKey,
        runId: "run-1",
        state: status,
      });
      expect(state.chatMessages).toHaveLength(2);
      expect(occurrenceKeys(state)).toEqual(before);
    },
  );

  it.each(["error", "aborted"] as const)("retains a selected one-body %s replacement", (status) => {
    const state = createState();
    const before = streamKeys(state);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "run-1",
      state: status,
      message: message("assistant", "The answer."),
    });
    expect(occurrenceKeys(state)).toEqual(before);
  });

  it("does not retain one of several bodies suppressed by an abort replacement", () => {
    const state = createState();
    state.chatStreamSegments = [{ text: "First. ", runId: "run-1", ts: 1 }];
    state.chatStream = "First. Second.";
    expect(streamKeys(state)).toHaveLength(2);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "run-1",
      state: "aborted",
      message: message("assistant", "First. Second."),
    });
    expect(occurrenceKeys(state)).toEqual([]);
  });

  it.each(["", "NO_REPLY"])(
    "does not fabricate an occurrence for hidden or empty stream %j",
    (stream) => {
      const state = createState();
      state.chatStream = null;
      handleChatGatewayEvent(state, {
        sessionKey: state.sessionKey,
        runId: "run-1",
        state: "delta",
        message: message("assistant", stream),
      });
      expect(streamKeys(state)).toEqual([]);
      finish(state);
      expect(occurrenceKeys(state)).toEqual([]);
    },
  );

  it("retains only the current tail after a persisted steer boundary", () => {
    const state = createState();
    state.chatMessages.push(
      message("user", "Steer", { id: "steer", seq: 3, idempotencyKey: "steer-1:user" }),
    );
    state.chatStreamSegments = [
      { text: "Before steer. ", ts: 2, runId: "run-1", boundaryRunId: "steer-1" },
    ];
    state.chatStream = "Before steer. The answer.";
    const currentKey = streamKeys(state).at(-1);
    finish(state, "Before steer. The answer.");
    expect(state.chatMessages).toHaveLength(4);
    expect(getChatSessionProjection(state).entries.at(-1)?.occurrenceKey).toBe(currentKey);
    occurrenceKeys(state);
  });

  it("resets a steer tail that combines a settled segment and current body", () => {
    const state = createState();
    state.chatMessages.push(
      message("user", "Steer", { id: "steer", seq: 3, idempotencyKey: "steer-1:user" }),
    );
    state.chatStreamSegments = [
      { text: "Before steer. ", ts: 2, runId: "run-1", boundaryRunId: "steer-1" },
      { text: "Before steer. First. ", ts: 4, runId: "run-1", afterBoundaryRunId: "steer-1" },
    ];
    state.chatStream = "Before steer. First. Second.";
    expect(streamKeys(state)).toHaveLength(3);
    finish(state, "Before steer. First. Second.");
    expect(getChatSessionProjection(state).entries.at(-1)?.occurrenceKey).toBeUndefined();
    expect(occurrenceKeys(state)).toHaveLength(1);
  });
});
