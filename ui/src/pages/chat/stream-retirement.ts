import type { SessionProjectionEntry } from "@openclaw/gateway-client/browser";
import type { SessionRunStatus } from "../../api/types.ts";
import type { VisibleAssistantStreamPart } from "../../lib/chat/chat-types.ts";
import {
  isHiddenAssistantStreamText,
  shouldHideAssistantChatMessage,
} from "../../lib/chat/message-visibility.ts";
import {
  assistantStreamPartOccurrence,
  type AssistantStreamOccurrenceState,
} from "./chat-progress.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  publishChatSessionProjectionMessages,
} from "./history-merge.ts";
import {
  materializeVisibleStreamState,
  retainAssistantStreamSegmentOccurrences,
} from "./stream-reconciliation.ts";
import { rememberLiveTerminalRun } from "./terminal-message-identity.ts";

type RetirementState = Parameters<typeof getChatSessionProjection>[0] &
  AssistantStreamOccurrenceState & {
    chatStream?: string | null;
    settings?: { chatPersistCommentary?: boolean };
  };

/** One accepted retirement may combine or split bodies; neither has one retained owner. */
export function collectAssistantStreamRetirement(
  state: RetirementState,
  previousEntries?: readonly SessionProjectionEntry[],
) {
  retainAssistantStreamSegmentOccurrences(state);
  let previousKeys: Map<unknown, string | undefined> | undefined;
  const keys = new Map<unknown, string | undefined>();
  const targets = new Map<unknown, Set<unknown>>();
  const sources = new Map<unknown, Set<unknown>>();
  const replaceSource = (source: unknown, messages: readonly unknown[]) => {
    const selected = sources.get(source) ?? new Set<unknown>();
    sources.set(source, selected);
    for (const message of messages) {
      selected.add(message);
      const consumed = targets.get(message) ?? new Set<unknown>();
      consumed.add(source);
      targets.set(message, consumed);
    }
  };
  const replace = (part: VisibleAssistantStreamPart, messages: readonly unknown[]) => {
    if (!isHiddenAssistantStreamText(part.text)) {
      replaceSource(assistantStreamPartOccurrence(state, part), messages);
    }
  };
  return {
    replace,
    replaceMessages(previous: readonly unknown[], message: unknown) {
      previousKeys ??= new Map(
        (previousEntries ?? getChatSessionProjection(state).entries).map((entry) => [
          entry.message,
          entry.occurrenceKey,
        ]),
      );
      for (const source of previous) {
        // Untokened predecessors still count: combining one with a live body is not one-to-one.
        replaceSource(keys.get(source) ?? previousKeys.get(source) ?? source, [message]);
      }
    },
    materialize(
      messages: unknown[],
      options: Omit<
        Parameters<typeof materializeVisibleStreamState>[2],
        "onReplace" | "isHiddenAssistantMessage" | "isHiddenStreamText"
      > = {},
    ) {
      return materializeVisibleStreamState(
        messages,
        {
          ...state,
          chatStream: state.chatStream ?? null,
          chatStreamStartedAt: state.chatStreamStartedAt ?? null,
        },
        {
          ...options,
          persistCommentary:
            options.persistCommentary ?? state.settings?.chatPersistCommentary !== false,
          isHiddenAssistantMessage: shouldHideAssistantChatMessage,
          isHiddenStreamText: isHiddenAssistantStreamText,
          onMaterialize: (message, part) => {
            keys.set(message, assistantStreamPartOccurrence(state, part));
            options.onMaterialize?.(message, part);
          },
          onReplace: replace,
        },
      );
    },
    publish(
      messages?: unknown[],
      options: Parameters<typeof publishChatSessionProjectionMessages>[2] = {},
    ) {
      for (const [message, consumed] of targets) {
        const [source] = consumed;
        keys.set(
          message,
          consumed.size === 1 && sources.get(source)?.size === 1 && typeof source === "string"
            ? source
            : undefined,
        );
      }
      if (messages && (messages !== state.chatMessages || options.event || options.scope)) {
        publishChatSessionProjectionMessages(state, messages, { ...options, occurrenceKeys: keys });
      } else if (keys.size) {
        publishChatSessionProjection(state, getChatSessionProjection(state), keys);
      }
    },
  };
}

type RetiringState = Omit<RetirementState, "chatMessages"> & { chatMessages?: unknown[] };

function hasRetiringTranscript(state: RetiringState): state is RetirementState {
  return Array.isArray(state.chatMessages);
}

/** Preserve only the body selected by terminal-row admission, before lifecycle cleanup. */
export function materializeRetiringAssistantStream(
  state: RetiringState,
  status: SessionRunStatus | undefined,
): void {
  if (!hasRetiringTranscript(state)) {
    return;
  }
  const retirement = collectAssistantStreamRetirement(state);
  let terminal: { message: unknown; part: VisibleAssistantStreamPart } | undefined;
  retirement.publish(
    retirement.materialize(state.chatMessages, {
      retiringRunId: state.chatRunId ?? null,
      onMaterialize: (message, part) => {
        terminal = { message, part };
      },
    }),
  );
  // Like chat.error, only the last owned body closes the frame; marking an
  // earlier preamble would strand the following tools and answer outside it.
  if (terminal && status !== "done") {
    rememberLiveTerminalRun(
      terminal.message,
      terminal.part.runId,
      terminal.part.afterBoundaryRunId,
      status === "timeout" ? "timeout" : status === "failed" ? "error" : "aborted",
    );
  }
}
