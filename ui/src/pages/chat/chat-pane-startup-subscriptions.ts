import type { ApplicationContext } from "../../app/context.ts";
import { parseCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { retryReconnectableQueuedChatSends } from "./chat-send-actions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { CHAT_COMPOSER_DRAFT_STORAGE_ERROR } from "./composer-persistence.ts";
import { admitChatSubmission } from "./history-merge.ts";
import { admitInitialTurnHandoff } from "./initial-turn-handoff.ts";
import { resolveChatSnapshotKey } from "./session-message-cache.ts";
import { subscribeSnapshotInvalidation } from "./session-snapshot-invalidation-events.ts";

type ChatPaneStartupContext = Pick<ApplicationContext, "placementStartup" | "chatSubmissions">;

export function subscribeChatPaneStartup(
  context: ChatPaneStartupContext,
  getState: () => ChatPageHost | undefined,
): () => void {
  const stopInitial = context.chatSubmissions.subscribeInitial((sessionKey, owner) => {
    const state = getState();
    if (
      !state ||
      state.client !== owner ||
      !areUiSessionKeysEquivalent(state.sessionKey, sessionKey)
    ) {
      return;
    }
    // Instant routes are mounted before the create response; admit the same
    // first-turn handoffs that an ordinary pane consumes when it first mounts.
    if (admitInitialTurnHandoff(state, sessionKey)) {
      state.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
      state.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
    }
    admitChatSubmission(state);
    state.requestUpdate?.();
  });
  const stopPlacement = context.placementStartup.subscribe(() => {
    const state = getState();
    if (state) {
      admitChatSubmission(state);
      // Project the accepted initial turn before waking followers parked behind recovery.
      if (!parseCatalogSessionKey(state.sessionKey)) {
        void retryReconnectableQueuedChatSends(state);
      }
      state.requestUpdate?.();
    }
  });
  return () => {
    stopInitial();
    stopPlacement();
  };
}

export function subscribeChatPaneSnapshotInvalidation(
  getState: () => ChatPageHost | undefined,
): () => void {
  return subscribeSnapshotInvalidation(({ sessionKey, reason }) => {
    // Cache eviction must preserve the active transcript and its completed load.
    const state = getState();
    if (
      reason === "cache-eviction" ||
      !state ||
      (sessionKey && resolveChatSnapshotKey(state, { sessionKey: state.sessionKey }) !== sessionKey)
    ) {
      return;
    }
    resetChatHistoryProjection(state);
    state.requestUpdate?.();
  });
}
