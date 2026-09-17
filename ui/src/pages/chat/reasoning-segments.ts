import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatReasoningSegment, ChatStreamSegment } from "../../lib/chat/chat-types.ts";

const REASONING_MATCH_PREFIX_CHARS = 160;

export function normalizeReasoningText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Thinking blocks persisted per run, so live reasoning can retire in place. */
export function collectPersistedThinkingByRun(messages: readonly unknown[]): Map<string, string[]> {
  const byRun = new Map<string, string[]>();
  for (const message of messages) {
    const record = asRecord(message);
    if (record?.role !== "assistant" || !Array.isArray(record.content)) {
      continue;
    }
    const runId = readSessionMessageIdentity(message)?.runId;
    if (!runId) {
      continue;
    }
    for (const block of record.content) {
      const entry = asRecord(block);
      if (entry?.type !== "thinking" || typeof entry.thinking !== "string") {
        continue;
      }
      const normalized = normalizeReasoningText(entry.thinking);
      if (!normalized) {
        continue;
      }
      const bucket = byRun.get(runId);
      if (bucket) {
        bucket.push(normalized);
      } else {
        byRun.set(runId, [normalized]);
      }
    }
  }
  return byRun;
}

export function isReasoningSegmentPersisted(
  segment: ChatReasoningSegment,
  persistedThinking: ReadonlyMap<string, readonly string[]>,
): boolean {
  const candidates = persistedThinking.get(segment.runId);
  if (!candidates?.length) {
    return false;
  }
  const live = normalizeReasoningText(segment.text);
  if (!live) {
    return true;
  }
  // The gateway projects a whitespace-trimmed view of the block while the
  // transcript keeps the raw text; compare a normalized prefix of both.
  const probe = live.slice(0, REASONING_MATCH_PREFIX_CHARS);
  return candidates.some((candidate) => candidate.startsWith(probe) || live.startsWith(candidate));
}

/** Drops live reasoning blocks that the loaded transcript now carries as thinking. */
export function pruneReplacedReasoningSegments(
  segments: readonly ChatReasoningSegment[] | undefined,
  messages: readonly unknown[] | undefined,
): ChatReasoningSegment[] | undefined {
  if (!segments?.length || !messages?.length) {
    return undefined;
  }
  const persisted = collectPersistedThinkingByRun(messages);
  if (persisted.size === 0) {
    return undefined;
  }
  const kept = segments.filter((segment) => !isReasoningSegmentPersisted(segment, persisted));
  return kept.length === segments.length ? undefined : kept;
}

/** Saved reasoning renders for `on` and `stream`; `off` keeps it hidden. */
export function showsSavedReasoning(reasoningLevel: string | null | undefined): boolean {
  return reasoningLevel === "on" || reasoningLevel === "stream";
}

/** Pane state feeding the thread: catalog panes render no transcript stream at all. */
export function readTranscriptStreamSegments(
  state: {
    chatStreamSegments: ChatStreamSegment[];
    chatReasoningSegments: ChatReasoningSegment[];
  },
  emptyStreamSegments: ChatStreamSegment[] | null,
): { streamSegments: ChatStreamSegment[]; reasoningSegments: ChatReasoningSegment[] | undefined } {
  return emptyStreamSegments
    ? { streamSegments: emptyStreamSegments, reasoningSegments: undefined }
    : { streamSegments: state.chatStreamSegments, reasoningSegments: state.chatReasoningSegments };
}

/** Live reasoning reaches the thread builder only for `/reasoning stream` with the view toggle on. */
export function resolveTranscriptStreamInput(
  props: {
    showThinking: boolean;
    streamSegments: ChatStreamSegment[];
    reasoningSegments?: ChatReasoningSegment[];
  },
  reasoningLevel: string | null | undefined,
): { streamSegments: ChatStreamSegment[]; reasoningSegments: ChatReasoningSegment[] | undefined } {
  return {
    streamSegments: props.streamSegments,
    reasoningSegments:
      props.showThinking && reasoningLevel === "stream" ? props.reasoningSegments : undefined,
  };
}
