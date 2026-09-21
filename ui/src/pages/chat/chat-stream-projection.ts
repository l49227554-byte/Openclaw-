import type { ChatQueueItem, ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import { assistantStreamPartOccurrence } from "./chat-progress.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";

export type ChatStreamProjectionProps = {
  sessionKey: string;
  runId?: string | null;
  runLifecycleGeneration?: number;
  stream: string | null;
  streamStartedAt: number | null;
  streamSegments: ChatStreamSegment[];
  queue?: ChatQueueItem[];
  toolMessages: unknown[];
};

/** Rendering uses the same raw source boundaries as retirement, before sanitizing display text. */
export function prepareChatStreamProjection(props: ChatStreamProjectionProps) {
  const state = {
    sessionKey: props.sessionKey,
    chatRunId: props.runId,
    chatRunLifecycleGeneration: props.runLifecycleGeneration,
    chatStream: props.stream,
    chatStreamStartedAt: props.streamStartedAt,
    chatStreamSegments: props.streamSegments,
    chatQueue: props.queue,
    chatToolMessages: props.toolMessages,
  };
  const parts = visibleAssistantStreamParts(state, { isHiddenStreamText: () => false });
  const current = parts.find((part) => part.source === "current");
  return {
    parts,
    currentKey: current && assistantStreamPartOccurrence(state, current),
    segmentKeys: new Map(
      parts.flatMap((part) =>
        part.segmentIndex === undefined
          ? []
          : [
              [
                props.streamSegments[part.segmentIndex],
                assistantStreamPartOccurrence(state, part),
              ] as const,
            ],
      ),
    ),
  };
}
