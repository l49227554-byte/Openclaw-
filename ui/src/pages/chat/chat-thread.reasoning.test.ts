// @vitest-environment node
// Control UI tests cover live reasoning placement and retirement in the thread.
import { describe, expect, it } from "vitest";
import type { ChatReasoningSegment } from "../../lib/chat/chat-types.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { pruneReplacedReasoningSegments } from "./reasoning-segments.ts";

const RUN_ID = "run-reasoning";

function baseProps(overrides: Partial<BuildChatItemsProps> = {}): BuildChatItemsProps {
  return {
    paneId: "pane",
    sessionKey: "agent:main:main",
    runId: RUN_ID,
    messages: [
      {
        role: "user",
        content: "Read the file.",
        timestamp: 1_000,
        __openclaw: { id: "user-1", seq: 1, idempotencyKey: `${RUN_ID}:user` },
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    runActive: true,
    runWorking: true,
    ...overrides,
  };
}

function reasoning(text: string, ts: number, settled?: true): ChatReasoningSegment {
  return { runId: RUN_ID, text, ts, seq: ts, ...(settled ? { settled } : {}) };
}

function kinds(items: ReturnType<typeof buildChatItems>): string[] {
  return items.map((item) => item.kind);
}

describe("live reasoning items", () => {
  it("renders reasoning blocks before the live answer and marks the open block streaming", () => {
    const items = buildChatItems(
      baseProps({
        reasoningSegments: [
          reasoning("Plan the read.", 1_100, true),
          reasoning("Summarize.", 1_300),
        ],
        stream: "The file says hello.",
        streamStartedAt: 1_400,
      }),
    );
    const reasoningItems = items.filter((item) => item.kind === "reasoning");
    expect(reasoningItems.map((item) => [item.text, item.isStreaming])).toEqual([
      ["Plan the read.", false],
      ["Summarize.", true],
    ]);
    expect(kinds(items)).toEqual([
      "group",
      "reasoning",
      "reasoning",
      "stream",
      "reading-indicator",
    ]);
  });

  it("omits reasoning when the pane passes none", () => {
    const items = buildChatItems(baseProps({ stream: "Hello.", streamStartedAt: 1_200 }));
    expect(items.some((item) => item.kind === "reasoning")).toBe(false);
  });

  it("retires a live block once the transcript persists the same thinking for the run", () => {
    const persisted = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "\n\nPlan the read.\nThen summarize.\n" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } },
      ],
      timestamp: 1_150,
      __openclaw: { runId: RUN_ID, id: "assistant-1", seq: 2 },
    };
    const props = baseProps({
      messages: [...baseProps().messages, persisted],
      reasoningSegments: [
        reasoning("Plan the read. Then summarize.", 1_100, true),
        reasoning("Now the answer.", 1_300),
      ],
    });
    const items = buildChatItems(props);
    expect(items.filter((item) => item.kind === "reasoning").map((item) => item.text)).toEqual([
      "Now the answer.",
    ]);
    expect(
      pruneReplacedReasoningSegments(props.reasoningSegments, props.messages)?.map(
        (segment) => segment.text,
      ),
    ).toEqual(["Now the answer."]);
    expect(pruneReplacedReasoningSegments(props.reasoningSegments, [])).toBeUndefined();
  });

  it("keeps reasoning from another run apart from this run's persisted thinking", () => {
    const persisted = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan the read." }],
      timestamp: 900,
      __openclaw: { runId: "run-earlier", id: "assistant-0", seq: 0 },
    };
    const items = buildChatItems(
      baseProps({
        messages: [persisted, ...baseProps().messages],
        reasoningSegments: [reasoning("Plan the read.", 1_100)],
      }),
    );
    expect(items.filter((item) => item.kind === "reasoning")).toHaveLength(1);
  });
});
