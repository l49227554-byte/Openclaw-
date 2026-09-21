import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  formatThreadBindingDurationLabel,
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  resolveThreadBindingEffectiveExpiresAt,
  resolveThreadBindingLifecycle,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadTelegramSendModule } from "./send-runtime.js";
import type {
  TelegramBindingTargetKind,
  TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";
import {
  cleanupStaleAcpSessionBindings,
  ensureTelegramThreadBindingsLoadedAsync,
  getRestoredAccounts,
  getThreadBindingsState,
  listBindingsForAccount,
  loadBindingsFromStore,
  persistBindingMutation,
  resolveBindingKey,
  restoreAccountBindings,
  type TelegramThreadBindingManager,
} from "./thread-bindings.state.js";
import { resolveTelegramToken } from "./token.js";

const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;

function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function toSessionBindingTargetKind(raw: TelegramBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toTelegramTargetKind(raw: BindingTargetKind): TelegramBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: TelegramThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "telegram",
      accountId: record.accountId,
      conversationId: record.conversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveThreadBindingEffectiveExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs:
        typeof record.idleTimeoutMs === "number"
          ? Math.max(0, Math.floor(record.idleTimeoutMs))
          : defaults.idleTimeoutMs,
      maxAgeMs:
        typeof record.maxAgeMs === "number"
          ? Math.max(0, Math.floor(record.maxAgeMs))
          : defaults.maxAgeMs,
      ...record.metadata,
    },
  };
}

function fromSessionBindingInput(params: {
  accountId: string;
  input: {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversationId: string;
    metadata?: Record<string, unknown>;
  };
}): TelegramThreadBindingRecord {
  const now = Date.now();
  const metadata = params.input.metadata ?? {};
  const existing = getThreadBindingsState().bindingsByAccountConversation.get(
    resolveBindingKey({
      accountId: params.accountId,
      conversationId: params.input.conversationId,
    }),
  );
  const targetKind = toTelegramTargetKind(params.input.targetKind);
  // Runtime metadata follows the target; conversation lifecycle settings still carry forward below.
  const previous =
    existing?.targetSessionKey === params.input.targetSessionKey &&
    existing.targetKind === targetKind
      ? existing
      : undefined;

  const record: TelegramThreadBindingRecord = {
    accountId: params.accountId,
    conversationId: params.input.conversationId,
    targetKind,
    targetSessionKey: params.input.targetSessionKey,
    agentId: normalizeOptionalString(metadata.agentId) ?? previous?.agentId,
    label: normalizeOptionalString(metadata.label) ?? previous?.label,
    boundBy: normalizeOptionalString(metadata.boundBy) ?? previous?.boundBy,
    boundAt: now,
    lastActivityAt: now,
    metadata: {
      ...previous?.metadata,
      ...metadata,
    },
  };

  if (typeof metadata.idleTimeoutMs === "number" && Number.isFinite(metadata.idleTimeoutMs)) {
    record.idleTimeoutMs = Math.max(0, Math.floor(metadata.idleTimeoutMs));
  } else if (typeof existing?.idleTimeoutMs === "number") {
    record.idleTimeoutMs = existing.idleTimeoutMs;
  }

  if (typeof metadata.maxAgeMs === "number" && Number.isFinite(metadata.maxAgeMs)) {
    record.maxAgeMs = Math.max(0, Math.floor(metadata.maxAgeMs));
  } else if (typeof existing?.maxAgeMs === "number") {
    record.maxAgeMs = existing.maxAgeMs;
  }

  return record;
}

function summarizeLifecycleForLog(
  record: TelegramThreadBindingRecord,
  defaults: {
    idleTimeoutMs: number;
    maxAgeMs: number;
  },
) {
  const idleTimeoutMs =
    typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
  const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
  const idleLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(idleTimeoutMs)));
  const maxAgeLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(maxAgeMs)));
  return `idle=${idleLabel} maxAge=${maxAgeLabel}`;
}

function normalizeTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(raw));
}

export function createTelegramThreadBindingManager(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  persist?: boolean;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  enableSweeper?: boolean;
}): TelegramThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = getThreadBindingsState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? true;
  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_THREAD_BINDING_MAX_AGE_MS);

  // Synchronous compatibility restore; bundled async entry points pre-restore
  // through ensureTelegramThreadBindingsLoadedAsync so this read stays cold.
  if (!getRestoredAccounts(getThreadBindingsState()).has(accountId)) {
    getRestoredAccounts(getThreadBindingsState()).add(accountId);
    restoreAccountBindings(accountId, loadBindingsFromStore(accountId));
    cleanupStaleAcpSessionBindings(accountId, persist);
  }

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: TelegramThreadBindingManager = {
    accountId,
    shouldPersistMutations: () => persist,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByConversationId: (conversationIdRaw) => {
      const conversationId = normalizeOptionalString(conversationIdRaw);
      if (!conversationId) {
        return undefined;
      }
      return getThreadBindingsState().bindingsByAccountConversation.get(
        resolveBindingKey({
          accountId,
          conversationId,
        }),
      );
    },
    listBySessionKey: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return listBindingsForAccount(accountId).filter(
        (entry) => entry.targetSessionKey === targetSessionKey,
      );
    },
    listBindings: () => listBindingsForAccount(accountId),
    touchConversation: (conversationIdRaw, at) => {
      const conversationId = normalizeOptionalString(conversationIdRaw);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const existingLocal = getThreadBindingsState().bindingsByAccountConversation.get(key);
      if (!existingLocal) {
        return null;
      }
      const nextRecord: TelegramThreadBindingRecord = {
        ...existingLocal,
        lastActivityAt: normalizeTimestampMs(at ?? Date.now()),
      };
      getThreadBindingsState().bindingsByAccountConversation.set(key, nextRecord);
      persistBindingMutation({
        accountId,
        persist: manager.shouldPersistMutations(),
        binding: nextRecord,
        reason: "touch",
      });
      return nextRecord;
    },
    unbindConversation: (unbindParams) => {
      const conversationId = normalizeOptionalString(unbindParams.conversationId);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const removed = getThreadBindingsState().bindingsByAccountConversation.get(key) ?? null;
      if (!removed) {
        return null;
      }
      getThreadBindingsState().bindingsByAccountConversation.delete(key);
      persistBindingMutation({
        accountId,
        persist: manager.shouldPersistMutations(),
        binding: removed,
        remove: true,
        reason: "unbind-conversation",
        throwOnError: unbindParams.throwOnPersistError,
      });
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const targetSessionKey = unbindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return [];
      }
      const removed: TelegramThreadBindingRecord[] = [];
      for (const entry of listBindingsForAccount(accountId)) {
        if (entry.targetSessionKey !== targetSessionKey) {
          continue;
        }
        const key = resolveBindingKey({
          accountId,
          conversationId: entry.conversationId,
        });
        getThreadBindingsState().bindingsByAccountConversation.delete(key);
        persistBindingMutation({
          accountId,
          persist: manager.shouldPersistMutations(),
          binding: entry,
          remove: true,
          reason: "unbind-session",
          throwOnError: unbindParams.throwOnPersistError,
        });
        removed.push(entry);
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterSessionBindingAdapter({
        channel: "telegram",
        accountId,
        adapter: sessionBindingAdapter,
      });
      const state = getThreadBindingsState();
      const existingManager = state.managersByAccountId.get(accountId);
      if (existingManager === manager) {
        state.managersByAccountId.delete(accountId);
        // Live bindings belong to this manager generation; persisted rows reload on restart.
        for (const binding of listBindingsForAccount(accountId)) {
          state.bindingsByAccountConversation.delete(
            resolveBindingKey({ accountId, conversationId: binding.conversationId }),
          );
        }
        // Allow the next manager generation to restore persisted rows again.
        getRestoredAccounts(state).delete(accountId);
      }
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "telegram",
    accountId,
    capabilities: {
      placements: ["current", "child"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "telegram") {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const placement = input.placement === "child" ? "child" : "current";
      const metadata = input.metadata ?? {};
      let conversationId: string | undefined;

      if (placement === "child") {
        const rawConversationId = input.conversation.conversationId?.trim() ?? "";
        const rawParent = input.conversation.parentConversationId?.trim() ?? "";
        const chatId = rawParent || rawConversationId;
        if (!chatId) {
          logVerbose(
            `telegram: child bind failed: could not resolve group chat ID from conversationId=${rawConversationId}`,
          );
          return null;
        }
        if (!chatId.startsWith("-")) {
          logVerbose(
            `telegram: child bind failed: conversationId "${chatId}" looks like a bare topic ID, not a group chat ID (expected to start with "-"). Provide a full chatId:topic:topicId conversationId or set parentConversationId to the group chat ID.`,
          );
          return null;
        }
        const threadName =
          (normalizeOptionalString(metadata.threadName) ?? "") ||
          (normalizeOptionalString(metadata.label) ?? "") ||
          `Agent: ${targetSessionKey.split(":").pop()}`;
        try {
          const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
          if (!tokenResolution.token) {
            return null;
          }
          const { createForumTopicTelegram } = await loadTelegramSendModule();
          const result = await createForumTopicTelegram(chatId, threadName, {
            cfg: params.cfg,
            token: tokenResolution.token,
            accountId,
          });
          conversationId = `${result.chatId}:topic:${result.topicId}`;
        } catch (err) {
          logVerbose(
            `telegram: child thread-binding failed for ${chatId}: ${formatErrorMessage(err)}`,
          );
          return null;
        }
      } else {
        conversationId = normalizeOptionalString(input.conversation.conversationId);
      }

      if (!conversationId) {
        return null;
      }
      const record = fromSessionBindingInput({
        accountId,
        input: {
          targetSessionKey,
          targetKind: input.targetKind,
          conversationId,
          metadata: input.metadata,
        },
      });
      getThreadBindingsState().bindingsByAccountConversation.set(
        resolveBindingKey({ accountId, conversationId }),
        record,
      );
      persistBindingMutation({
        accountId,
        persist: manager.shouldPersistMutations(),
        binding: record,
        reason: "bind",
        throwOnError: true,
      });
      logVerbose(
        `telegram: bound conversation ${conversationId} -> ${targetSessionKey} (${summarizeLifecycleForLog(
          record,
          {
            idleTimeoutMs,
            maxAgeMs,
          },
        )})`,
      );
      return toSessionBindingRecord(record, {
        idleTimeoutMs,
        maxAgeMs,
      });
    },
    listBySession: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return manager.listBySessionKey(targetSessionKey).map((entry) =>
        toSessionBindingRecord(entry, {
          idleTimeoutMs,
          maxAgeMs,
        }),
      );
    },
    resolveByConversation: (ref) => {
      if (ref.channel !== "telegram") {
        return null;
      }
      const conversationId = normalizeOptionalString(ref.conversationId);
      if (!conversationId) {
        return null;
      }
      const record = manager.getByConversationId(conversationId);
      return record
        ? toSessionBindingRecord(record, {
            idleTimeoutMs,
            maxAgeMs,
          })
        : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (!conversationId) {
        return;
      }
      manager.touchConversation(conversationId, at);
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
          sendFarewell: false,
          throwOnPersistError: true,
        });
        return removed.map((entry) =>
          toSessionBindingRecord(entry, {
            idleTimeoutMs,
            maxAgeMs,
          }),
        );
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation({
        conversationId,
        reason: input.reason,
        sendFarewell: false,
        throwOnPersistError: true,
      });
      return removed
        ? [
            toSessionBindingRecord(removed, {
              idleTimeoutMs,
              maxAgeMs,
            }),
          ]
        : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  const sweeperEnabled = params.enableSweeper !== false;
  if (sweeperEnabled) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const record of listBindingsForAccount(accountId)) {
        const { expiresAt, reason } = resolveThreadBindingLifecycle({
          record,
          defaultIdleTimeoutMs: idleTimeoutMs,
          defaultMaxAgeMs: maxAgeMs,
        });
        if (expiresAt === undefined || now < expiresAt) {
          continue;
        }
        manager.unbindConversation({
          conversationId: record.conversationId,
          reason,
          sendFarewell: false,
        });
      }
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  getThreadBindingsState().managersByAccountId.set(accountId, manager);
  return manager;
}

export async function createTelegramThreadBindingManagerAsync(
  params: Parameters<typeof createTelegramThreadBindingManager>[0],
): Promise<TelegramThreadBindingManager> {
  await ensureTelegramThreadBindingsLoadedAsync(params.accountId, {
    persist: params.persist ?? true,
  });
  return createTelegramThreadBindingManager(params);
}

export function getTelegramThreadBindingManager(
  accountId?: string,
): TelegramThreadBindingManager | null {
  return getThreadBindingsState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}

function updateTelegramBindingsBySessionKey(params: {
  manager: TelegramThreadBindingManager;
  targetSessionKey: string;
  update: (entry: TelegramThreadBindingRecord, now: number) => TelegramThreadBindingRecord;
}): TelegramThreadBindingRecord[] {
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const now = Date.now();
  const updated: TelegramThreadBindingRecord[] = [];
  for (const entry of params.manager.listBySessionKey(targetSessionKey)) {
    const key = resolveBindingKey({
      accountId: params.manager.accountId,
      conversationId: entry.conversationId,
    });
    const next = params.update(entry, now);
    getThreadBindingsState().bindingsByAccountConversation.set(key, next);
    persistBindingMutation({
      accountId: params.manager.accountId,
      persist: params.manager.shouldPersistMutations(),
      binding: next,
      reason: "session-lifecycle-update",
    });
    updated.push(next);
  }
  return updated;
}

export function setTelegramThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): TelegramThreadBindingRecord[] {
  const manager = getTelegramThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, 0);
  return updateTelegramBindingsBySessionKey({
    manager,
    targetSessionKey: params.targetSessionKey,
    update: (entry, now) => ({
      ...entry,
      idleTimeoutMs,
      lastActivityAt: now,
    }),
  });
}

export function setTelegramThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): TelegramThreadBindingRecord[] {
  const manager = getTelegramThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, 0);
  return updateTelegramBindingsBySessionKey({
    manager,
    targetSessionKey: params.targetSessionKey,
    update: (entry, now) => ({
      ...entry,
      maxAgeMs,
      lastActivityAt: now,
    }),
  });
}
