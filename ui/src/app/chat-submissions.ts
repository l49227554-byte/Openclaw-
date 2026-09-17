import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import type { buildLocalUserMessage } from "../pages/chat/user-message-content.ts";

type RetainedMessage = NonNullable<ReturnType<typeof buildLocalUserMessage>>;

type Submission = {
  message: RetainedMessage;
  pendingRunId: string;
  sessionKey: string;
  /** Logical client, not the hello object that rotates on reconnect. */
  owner: object;
} & (
  | { kind: "initial" }
  | { kind: "delivered"; deliveryKey: string; agentId?: string; sessionId?: string }
);
export type RetainedChatSubmission = Submission & { pending: boolean };

export type ApplicationChatSubmissions = ReturnType<typeof createChatSubmissions>;
/** App-owned display bytes only. Outbox payloads, attempts, and retries stay with the outbox. */
export function createChatSubmissions() {
  const initial = new Map<string, RetainedChatSubmission>();
  const pendingCreates = new Map<
    string,
    { owner: object; recoveryScope: string | undefined; message: RetainedMessage | null }
  >();
  const initialListeners = new Set<(sessionKey: string, owner: object) => void>();
  const notifyInitial = (sessionKey: string, owner: object) => {
    for (const listener of initialListeners) {
      listener(sessionKey, owner);
    }
  };
  let delivered = new WeakMap<object, Map<string, RetainedChatSubmission>>();
  const initialKey = (sessionKey: string) =>
    [...initial.keys()].find((key) => areUiSessionKeysEquivalent(key, sessionKey));
  const readInitial = (sessionKey: string, owner: object | null) => {
    const entry = initial.get(initialKey(sessionKey) ?? "");
    return entry?.owner === owner ? entry : null;
  };
  const retain = (submission: Submission | null): RetainedChatSubmission | undefined => {
    if (!submission) {
      return undefined;
    }
    const entries =
      submission.kind === "initial"
        ? initial
        : (delivered.get(submission.owner) ?? new Map<string, RetainedChatSubmission>());
    const key =
      submission.kind === "initial"
        ? (initialKey(submission.sessionKey) ?? submission.sessionKey)
        : submission.deliveryKey;
    if (submission.kind === "delivered") {
      delivered.set(submission.owner, entries);
    }
    const retained = { ...submission, pending: true };
    entries.delete(key);
    entries.set(key, retained);
    // Preserve the initial app limit and delivered per-client lifetime/limit.
    const limit = submission.kind === "initial" ? 32 : 64;
    if (entries.size > limit) {
      entries.delete(entries.keys().next().value!);
    }
    if (submission.kind === "initial") {
      notifyInitial(submission.sessionKey, submission.owner);
    }
    return retained;
  };
  return {
    retain,
    // Display-only admission state; no run id, outbox attempt or accepted send.
    beginCreate: (
      sessionKey: string,
      owner: object,
      recoveryScope: string | undefined,
      message: RetainedMessage | null,
    ) => {
      const pending = { owner, recoveryScope, message };
      pendingCreates.set(sessionKey, pending);
      notifyInitial(sessionKey, owner);
      return () => {
        if (pendingCreates.get(sessionKey) === pending) {
          pendingCreates.delete(sessionKey);
          notifyInitial(sessionKey, owner);
        }
      };
    },
    hasCreate: (sessionKey: string) => pendingCreates.has(sessionKey),
    readCreate: (sessionKey: string, owner: object | null, recoveryScope: string | undefined) => {
      const pending = pendingCreates.get(sessionKey);
      return recoveryScope && pending?.owner === owner && pending.recoveryScope === recoveryScope
        ? pending
        : null;
    },
    notifyInitial,
    subscribeInitial: (listener: (sessionKey: string, owner: object) => void) => {
      initialListeners.add(listener);
      return () => {
        initialListeners.delete(listener);
      };
    },
    readInitial,
    readDelivered: (key: string, owner: object) => delivered.get(owner)?.get(key),
    clearInitial: (sessionKey: string) => {
      const key = initialKey(sessionKey);
      if (key) {
        initial.delete(key);
      }
    },
    clear: () => {
      initial.clear();
      pendingCreates.clear();
      delivered = new WeakMap();
    },
  };
}
