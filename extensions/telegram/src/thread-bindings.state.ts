// Telegram thread-binding shared state and persisted-row restoration, split
// from thread-bindings.ts so transport entry points can restore bindings
// without loading the manager/sweeper graph. Mirrors Discord's
// monitor/thread-bindings.state.ts split.
import { readAcpSessionEntry } from "openclaw/plugin-sdk/acp-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveThreadBindingSpawnPolicy } from "openclaw/plugin-sdk/conversation-runtime";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeAccountId, isAcpSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramRuntime } from "./runtime.js";
import {
  resolveStoredBindingKey,
  sanitizeStoredBinding,
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  type TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";

type TelegramThreadBindingStore = PluginStateSyncKeyedStore<TelegramThreadBindingRecord>;
type TelegramThreadBindingAsyncStore = PluginStateKeyedStore<TelegramThreadBindingRecord>;
type TelegramThreadBindingStoreEntry = { key: string; value: TelegramThreadBindingRecord };

export type TelegramThreadBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversationId: (conversationId: string) => TelegramThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => TelegramThreadBindingRecord[];
  listBindings: () => TelegramThreadBindingRecord[];
  touchConversation: (conversationId: string, at?: number) => TelegramThreadBindingRecord | null;
  unbindConversation: (params: {
    conversationId: string;
    reason?: string;
    sendFarewell?: boolean;
    throwOnPersistError?: boolean;
  }) => TelegramThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
    sendFarewell?: boolean;
    throwOnPersistError?: boolean;
  }) => TelegramThreadBindingRecord[];
  stop: () => void;
};

type TelegramThreadBindingsState = {
  managersByAccountId: Map<string, TelegramThreadBindingManager>;
  bindingsByAccountConversation: Map<string, TelegramThreadBindingRecord>;
  /** Accounts whose persisted bindings were restored into the live registry. */
  restoredAccounts?: Set<string>;
  restoringAccounts?: Map<string, Promise<void>>;
};

/**
 * Keep Telegram thread binding state shared across bundled chunks so routing,
 * binding lookups, and binding mutations all observe the same live registry.
 */
const TELEGRAM_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.telegramThreadBindingsState");
let threadBindingsState: TelegramThreadBindingsState | undefined;

export function getThreadBindingsState(): TelegramThreadBindingsState {
  if (!threadBindingsState) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    threadBindingsState = (globalStore[TELEGRAM_THREAD_BINDINGS_STATE_KEY] as
      | TelegramThreadBindingsState
      | undefined) ?? {
      managersByAccountId: new Map<string, TelegramThreadBindingManager>(),
      bindingsByAccountConversation: new Map<string, TelegramThreadBindingRecord>(),
    };
    globalStore[TELEGRAM_THREAD_BINDINGS_STATE_KEY] = threadBindingsState;
  }
  return threadBindingsState;
}

export function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function openThreadBindingStore(): TelegramThreadBindingStore {
  return getTelegramRuntime().state.openSyncKeyedStore<TelegramThreadBindingRecord>({
    namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
    maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  });
}

async function openThreadBindingStoreAsync(): Promise<TelegramThreadBindingAsyncStore> {
  return getTelegramRuntime().state.openKeyedStore<TelegramThreadBindingRecord>({
    namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
    maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  });
}

export function getRestoredAccounts(state: TelegramThreadBindingsState): Set<string> {
  return (state.restoredAccounts ??= new Set<string>());
}

export function loadBindingsFromStore(accountId: string): TelegramThreadBindingRecord[] {
  let store: TelegramThreadBindingStore;
  try {
    store = openThreadBindingStore();
  } catch (err) {
    logVerbose(`telegram thread bindings store open failed (${accountId}): ${String(err)}`);
    return [];
  }
  let entries: Array<{ key: string; value: TelegramThreadBindingRecord }>;
  try {
    entries = store.entries();
  } catch (err) {
    logVerbose(`telegram thread bindings store read failed (${accountId}): ${String(err)}`);
    return [];
  }
  const bindings: TelegramThreadBindingRecord[] = [];
  for (const entry of entries) {
    if (entry.value.accountId !== accountId) {
      continue;
    }
    const sanitized = sanitizeStoredBinding(accountId, entry.value);
    if (sanitized) {
      bindings.push(sanitized);
      continue;
    }
    try {
      store.delete(entry.key);
    } catch (err) {
      logVerbose(
        `telegram thread bindings invalid row cleanup failed (${accountId}): ${String(err)}`,
      );
    }
  }
  return bindings;
}

async function loadBindingsFromStoreAsync(
  accountId: string,
): Promise<TelegramThreadBindingStoreEntry[] | null> {
  let store: TelegramThreadBindingAsyncStore;
  try {
    store = await openThreadBindingStoreAsync();
  } catch (err) {
    logVerbose(`telegram thread bindings store open failed (${accountId}): ${String(err)}`);
    return null;
  }
  let entries: TelegramThreadBindingStoreEntry[];
  try {
    entries = await store.entries();
  } catch (err) {
    logVerbose(`telegram thread bindings store read failed (${accountId}): ${String(err)}`);
    return null;
  }
  for (const entry of entries) {
    if (entry.value.accountId !== accountId) {
      continue;
    }
    if (sanitizeStoredBinding(accountId, entry.value)) {
      continue;
    }
    try {
      await store.delete(entry.key);
    } catch (err) {
      logVerbose(
        `telegram thread bindings invalid row cleanup failed (${accountId}): ${String(err)}`,
      );
    }
  }
  return entries;
}

export function restoreAccountBindings(
  accountId: string,
  loaded: TelegramThreadBindingRecord[],
): void {
  for (const entry of loaded) {
    const key = resolveBindingKey({
      accountId,
      conversationId: entry.conversationId,
    });
    getThreadBindingsState().bindingsByAccountConversation.set(key, {
      ...entry,
      accountId,
    });
  }
}

/** Startup staleness pass shared by the sync and async restore paths. */
export function cleanupStaleAcpSessionBindings(accountId: string, persist: boolean): void {
  const acpSessionKeys = new Set<string>();
  for (const binding of getThreadBindingsState().bindingsByAccountConversation.values()) {
    if (binding.targetKind !== "acp" || !isAcpSessionKey(binding.targetSessionKey)) {
      continue;
    }
    acpSessionKeys.add(binding.targetSessionKey);
  }

  const staleSessionKeys = new Set<string>();
  for (const targetSessionKey of acpSessionKeys) {
    const sessionEntry = readAcpSessionEntry({ sessionKey: targetSessionKey });
    if (!sessionEntry || sessionEntry.storeReadFailed) {
      continue;
    }
    const isStale =
      !sessionEntry.entry ||
      sessionEntry.entry.status === "failed" ||
      sessionEntry.entry.status === "killed" ||
      sessionEntry.entry.status === "timeout" ||
      sessionEntry.acp?.state === "error";
    if (isStale) {
      staleSessionKeys.add(targetSessionKey);
    }
  }

  for (const sessionKey of staleSessionKeys) {
    const bindingsToRemove = listBindingsForAccount(accountId).filter(
      (b) => b.targetSessionKey === sessionKey,
    );
    for (const binding of bindingsToRemove) {
      getThreadBindingsState().bindingsByAccountConversation.delete(
        resolveBindingKey({ accountId, conversationId: binding.conversationId }),
      );
      persistBindingMutation({
        accountId,
        persist,
        binding,
        remove: true,
        reason: "cleanup-stale",
      });
    }
    if (bindingsToRemove.length > 0) {
      logVerbose(
        `telegram thread binding: cleaned up ${bindingsToRemove.length} stale binding(s) for session ${sessionKey}`,
      );
    }
  }
}

/**
 * Restores one account's persisted bindings through the worker-backed store so
 * bundled entry points never block the gateway event loop on the cold read.
 */
export async function ensureTelegramThreadBindingsLoadedAsync(
  accountIdRaw: string | undefined,
  params?: { persist?: boolean },
): Promise<void> {
  const accountId = normalizeAccountId(accountIdRaw);
  const state = getThreadBindingsState();
  const restoredAccounts = getRestoredAccounts(state);
  if (restoredAccounts.has(accountId)) {
    return;
  }
  const pending = state.restoringAccounts?.get(accountId);
  if (pending) {
    await pending;
    return;
  }
  const task = (async () => {
    const entries = await loadBindingsFromStoreAsync(accountId);
    // A synchronous compatibility caller can restore this account while we wait.
    if (restoredAccounts.has(accountId)) {
      return;
    }
    restoredAccounts.add(accountId);
    if (!entries) {
      return;
    }
    restoreAccountBindings(
      accountId,
      entries
        .filter((entry) => entry.value.accountId === accountId)
        .map((entry) => sanitizeStoredBinding(accountId, entry.value))
        .filter((entry): entry is TelegramThreadBindingRecord => entry !== null),
    );
    cleanupStaleAcpSessionBindings(accountId, params?.persist ?? true);
  })();
  (state.restoringAccounts ??= new Map<string, Promise<void>>()).set(accountId, task);
  try {
    await task;
  } finally {
    state.restoringAccounts?.delete(accountId);
  }
}

/**
 * Gate matched to createTelegramBotCore's manager creation: entry points await
 * this before constructing a bot so only enabled accounts pay the cold read.
 */
export async function ensureTelegramBotThreadBindingsLoaded(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<void> {
  const accountId = normalizeAccountId(params.accountId);
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel: "telegram",
    accountId,
    kind: "subagent",
  });
  if (!policy.enabled) {
    return;
  }
  await ensureTelegramThreadBindingsLoadedAsync(accountId);
}

export function persistBindingMutation(params: {
  accountId: string;
  persist: boolean;
  binding: TelegramThreadBindingRecord;
  remove?: boolean;
  reason: string;
  throwOnError?: boolean;
}): void {
  if (!params.persist) {
    return;
  }
  try {
    const store = openThreadBindingStore();
    const key = resolveStoredBindingKey(params.binding);
    if (params.remove) {
      store.delete(key);
      return;
    }
    const stored = sanitizeStoredBinding(params.accountId, params.binding);
    if (stored) {
      store.register(key, stored);
    }
  } catch (err) {
    if (params.throwOnError) {
      throw err;
    }
    logVerbose(
      `telegram thread bindings persist failed (${params.accountId}, ${params.reason}): ${String(err)}`,
    );
  }
}

export function listBindingsForAccount(accountId: string): TelegramThreadBindingRecord[] {
  return [...getThreadBindingsState().bindingsByAccountConversation.values()].filter(
    (entry) => entry.accountId === accountId,
  );
}
