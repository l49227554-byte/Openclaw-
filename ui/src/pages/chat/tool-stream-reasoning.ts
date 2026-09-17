import type { ChatReasoningSegment } from "../../lib/chat/chat-types.ts";
import { reconcileChatRunStartup } from "./chat-run-startup.ts";
import type { AgentEventPayload, ToolStreamHost } from "./tool-stream-contract.ts";
import { resolveAcceptedSession } from "./tool-stream-status.ts";

/**
 * Projects the gateway `thinking` stream into per-run reasoning blocks. The
 * gateway publishes the cumulative text of the current block; a cumulative
 * text that no longer extends the open block means the model started a new
 * one (a later assistant message in the same run), so the previous block
 * settles and keeps its text until the durable row replaces it.
 */
export function handleReasoningStream(host: ToolStreamHost, payload: AgentEventPayload): boolean {
  if (payload.stream !== "thinking") {
    return false;
  }
  if (!resolveAcceptedSession(host, payload).accepted) {
    return true;
  }
  const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
  // Reasoning belongs to the run this pane is driving; a sibling or replayed
  // run must not append blocks into the visible transcript.
  if (!runId || host.chatRunId !== runId) {
    return true;
  }
  const data = payload.data ?? {};
  const segments = host.chatReasoningSegments ?? [];
  const lastIndex = segments.length - 1;
  const last = lastIndex >= 0 ? segments[lastIndex] : undefined;
  const open = last && last.runId === runId && last.settled !== true ? last : undefined;
  const seq = Number.isSafeInteger(payload.seq) ? payload.seq : 0;
  if (open && seq <= open.seq) {
    return true;
  }
  const cumulative =
    typeof data.text === "string"
      ? data.text
      : typeof data.delta === "string"
        ? // A delta-only frame still describes the open block; grow it locally.
          `${open?.text ?? ""}${data.delta}`
        : null;
  const text = cumulative?.trim() ?? "";
  if (!text) {
    return true;
  }
  reconcileChatRunStartup(host, { state: "activity", runId, seq });
  if (open && text.startsWith(open.text)) {
    if (text !== open.text) {
      host.chatReasoningSegments = [...segments.slice(0, lastIndex), { ...open, text, seq }];
    }
    return true;
  }
  if (open && open.text.startsWith(text)) {
    // A shorter cumulative snapshot is a stale or coalesced frame for the same
    // block; the longer projection already on screen stays authoritative.
    return true;
  }
  const next: ChatReasoningSegment = { runId, text, ts: payload.ts, seq };
  host.chatReasoningSegments = open
    ? [...segments.slice(0, lastIndex), { ...open, settled: true }, next]
    : [...segments, next];
  return true;
}

/** Marks every open reasoning block of a run as complete. */
export function settleReasoningSegments(host: ToolStreamHost, runId: string): void {
  const segments = host.chatReasoningSegments;
  if (!segments?.some((segment) => segment.runId === runId && segment.settled !== true)) {
    return;
  }
  host.chatReasoningSegments = segments.map((segment) => {
    if (segment.runId !== runId || segment.settled === true) {
      return segment;
    }
    const settled: ChatReasoningSegment = {
      runId: segment.runId,
      text: segment.text,
      ts: segment.ts,
      seq: segment.seq,
      settled: true,
    };
    return settled;
  });
}
