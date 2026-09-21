// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
// Lightweight in-memory queue for human-readable system events that should be
// prefixed to the next prompt. We intentionally avoid persistence to keep
// events ephemeral. Events are session-scoped and require an explicit key.

import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionRecipientAuthority } from "../config/sessions/session-recipient-authority-types.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { normalizeDiagnosticTraceparent } from "./diagnostic-trace-context.js";
import { generateSecureUuid } from "./secure-random.js";
import type { DelegateArtifactDeliveryReceipt } from "./session-delivery-queue-storage.js";
import {
  getSystemEventStorePath,
  isSystemEventStoreCurrent,
  registerSystemEventStoreOwner,
  recordSystemEventStoreReplaced,
} from "./system-event-ownership.js";

export type SystemEvent = {
  /**
   * OpenClaw-assigned opaque identity for one queued occurrence. Preserve it when returning a
   * snapshot to consume. It changes on replacement or re-enqueue; optional only for legacy
   * ID-less compatibility.
   */
  id?: string;
  text: string;
  ts: number;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  /**
   * Acknowledge the durable row only once the prepared turn is durably adopted,
   * instead of during prompt preparation. Mirrors the managed delegate-return
   * contract for events whose producer cannot reconstruct the notice after the
   * durable row is gone.
   */
  sessionDeliveryAwaitsTurnAdoption?: boolean;
  expectedSessionId?: string;
  recipientAuthority?: SessionRecipientAuthority;
  delegateArtifactReceipt?: DelegateArtifactDeliveryReceipt;
  /**
   * W3C `traceparent` captured at enqueue-time so the substrate-queue drain can
   * reconstruct the producer trace at announce/deliver time. Per RFC §6.7 the
   * substrate queue is an asynchronous boundary (enqueue turn != drain turn,
   * possibly across a gateway restart), so trace context rides on the payload
   * itself rather than on a runtime ambient. Optional and additive — invalid
   * traceparent values are silently dropped at enqueue-time so producers never
   * fail-the-write on a malformed header.
   */
  traceparent?: string;
  sessionStorePath?: string | null;
};

const MAX_EVENTS = 20;

type SessionQueue = {
  queue: SystemEvent[];
  lastContextKey: string | null;
};

const SYSTEM_EVENT_QUEUES_KEY = Symbol.for("openclaw.systemEvents.queues");

const queues = resolveGlobalMap<string, SessionQueue>(SYSTEM_EVENT_QUEUES_KEY, "close-only");
registerSystemEventStoreOwner(SYSTEM_EVENT_QUEUES_KEY, () => {
  for (const [key, entry] of queues) {
    const retained = entry.queue.filter((event) =>
      isSystemEventStoreCurrent(key, event.sessionStorePath),
    );
    if (retained.length === entry.queue.length) {
      continue;
    }
    entry.queue = retained;
    resetQueueState(key, entry);
    recordSystemEventStoreReplaced();
  }
});

type SystemEventOptions = {
  sessionKey: string;
  sessionStorePath?: string | null;
  contextKey?: string | null;
  deliveryContext?: DeliveryContext;
  sessionDeliveryAckId?: string;
  sessionDeliveryAckStateDir?: string;
  /** Defer the durable ack to turn adoption; see the SystemEvent field. */
  sessionDeliveryAwaitsTurnAdoption?: boolean;
  expectedSessionId?: string;
  recipientAuthority?: SessionRecipientAuthority;
  delegateArtifactReceipt?: DelegateArtifactDeliveryReceipt;
  /**
   * @deprecated Legacy no-op retained for plugin compatibility. System event
   * text is stored unchanged; provenance is controlled by `trusted`.
   */
  forceSenderIsOwnerFalse?: boolean;
  /**
   * Trusted-internal enrichment marker. Only core producers may attach managed
   * delivery provenance such as expectedSessionId and delegateArtifactReceipt.
   */
  trusted?: boolean;
  /**
   * Optional W3C `traceparent` to attach to the queued event for cross-boundary
   * trace correlation. Invalid values are silently dropped (additive contract:
   * a malformed traceparent never prevents an enqueue).
   */
  traceparent?: string;
  /** Replace the pending event for this context and delivery route. Requires contextKey. */
  replace?: boolean;
};

function normalizeTraceparent(traceparent?: string): string | undefined {
  return normalizeDiagnosticTraceparent(traceparent);
}

type ReceiptOptions = { allowDuplicate?: boolean };

function resolveSessionDeliveryAckStateDir(options: SystemEventOptions): string | undefined {
  if (!options.sessionDeliveryAckId) {
    return undefined;
  }
  // Explicit and ambient paths can name the same durable row across restart.
  // Normalize before dedupe so concurrent recovery cannot create two prompt slots.
  return options.sessionDeliveryAckStateDir ?? process.env.OPENCLAW_STATE_DIR;
}

function requireSessionKey(key?: string | null): string {
  const trimmed = normalizeOptionalString(key) ?? "";
  const parsed = parseAgentSessionKey(trimmed);
  if (!parsed) {
    throw new Error("system events require an agent-qualified sessionKey");
  }
  return `agent:${parsed.agentId}:${parsed.rest}`;
}

function normalizeContextKey(key?: string | null): string | null {
  return normalizeOptionalLowercaseString(key) ?? null;
}

function getSessionQueue(sessionKey: string): SessionQueue | undefined {
  return queues.get(requireSessionKey(sessionKey));
}

function getOrCreateSessionQueue(key: string): SessionQueue {
  const existing = queues.get(key);
  if (existing) {
    return existing;
  }
  const created: SessionQueue = {
    queue: [],
    lastContextKey: null,
  };
  queues.set(key, created);
  return created;
}

function cloneSystemEvent(event: SystemEvent): SystemEvent {
  return {
    ...event,
    ...(event.deliveryContext ? { deliveryContext: { ...event.deliveryContext } } : {}),
    ...(event.delegateArtifactReceipt
      ? { delegateArtifactReceipt: { ...event.delegateArtifactReceipt } }
      : {}),
    ...(event.recipientAuthority ? { recipientAuthority: { ...event.recipientAuthority } } : {}),
  };
}

export function isSystemEventContextChanged(
  sessionKey: string,
  contextKey?: string | null,
): boolean {
  const existing = getSessionQueue(sessionKey);
  const normalized = normalizeContextKey(contextKey);
  return normalized !== (existing?.lastContextKey ?? null);
}

function findDuplicateInQueue(
  queue: readonly SystemEvent[],
  text: string,
  contextKey: string | null,
  deliveryContext: DeliveryContext | undefined,
  sessionDeliveryAckId: string | undefined,
  sessionDeliveryAckStateDir: string | undefined,
  expectedSessionId: string | undefined,
  recipientAuthority: SessionRecipientAuthority | undefined,
  delegateArtifactReceipt: DelegateArtifactDeliveryReceipt | undefined,
): boolean {
  const incoming = {
    text,
    contextKey,
    deliveryContext,
    sessionDeliveryAckId,
    sessionDeliveryAckStateDir,
    expectedSessionId,
    recipientAuthority,
    delegateArtifactReceipt,
  };
  if (contextKey === null) {
    const last = queue[queue.length - 1];
    return last ? isDuplicateSystemEvent(last, incoming) : false;
  }
  return queue.some((event) => isDuplicateSystemEvent(event, incoming));
}

function applyContextKeyPolicy(entry: SessionQueue, incomingContextKey: string | null): void {
  if (incomingContextKey !== null) {
    entry.lastContextKey = incomingContextKey;
  }
}

export function enqueueSystemEventEntry(
  text: string,
  options: SystemEventOptions,
): SystemEvent | null {
  const event = enqueueOwnedSystemEventEntry(text, options);
  return event ? cloneSystemEvent(event) : null;
}

export const enqueueSystemEventEntryRaw = enqueueSystemEventEntry;

function enqueueOwnedSystemEventEntry(
  text: string,
  options: SystemEventOptions,
  receiptOptions?: ReceiptOptions,
): SystemEvent | null {
  const key = requireSessionKey(options.sessionKey);
  const sessionStorePath =
    options.sessionStorePath === undefined
      ? getSystemEventStorePath(key)
      : options.sessionStorePath;
  if (!isSystemEventStoreCurrent(key, sessionStorePath)) {
    recordSystemEventStoreReplaced();
    return null;
  }
  const entry = getOrCreateSessionQueue(key);
  if (options.replace) {
    return replaceSystemEventEntry(text, options, entry, sessionStorePath);
  }
  const cleaned = text.trim();
  if (!cleaned) {
    return null;
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  const normalizedTraceparent = normalizeTraceparent(options.traceparent);
  const sessionDeliveryAckStateDir = resolveSessionDeliveryAckStateDir(options);
  applyContextKeyPolicy(entry, normalizedContextKey);
  const event: SystemEvent = {
    id: generateSecureUuid(),
    text: cleaned,
    ts: Date.now(),
    ...(sessionStorePath === undefined ? {} : { sessionStorePath }),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    ...(options.sessionDeliveryAckId ? { sessionDeliveryAckId: options.sessionDeliveryAckId } : {}),
    ...(sessionDeliveryAckStateDir ? { sessionDeliveryAckStateDir } : {}),
    ...(options.trusted === true && options.sessionDeliveryAwaitsTurnAdoption
      ? { sessionDeliveryAwaitsTurnAdoption: true }
      : {}),
    ...(options.trusted === true && options.expectedSessionId
      ? { expectedSessionId: options.expectedSessionId }
      : {}),
    ...(options.trusted === true && options.recipientAuthority
      ? { recipientAuthority: { ...options.recipientAuthority } }
      : {}),
    ...(options.trusted === true && options.delegateArtifactReceipt
      ? { delegateArtifactReceipt: { ...options.delegateArtifactReceipt } }
      : {}),
    ...(normalizedTraceparent ? { traceparent: normalizedTraceparent } : {}),
  };
  if (event.sessionDeliveryAckId) {
    // An ack id + state dir identifies ONE persisted row, so the slot is located
    // by that identity alone: a re-enqueue of the same durable row replaces its
    // slot instead of double-queueing it.
    const durableIndex = entry.queue.findIndex(
      (queued) =>
        queued.sessionDeliveryAckId === event.sessionDeliveryAckId &&
        queued.sessionDeliveryAckStateDir === event.sessionDeliveryAckStateDir,
    );
    const existing = durableIndex >= 0 ? entry.queue[durableIndex] : undefined;
    if (durableIndex >= 0 && existing) {
      if (isDuplicateSystemEvent(existing, event)) {
        return null;
      }
      entry.queue[durableIndex] = event;
      return cloneSystemEvent(event);
    }
  }
  // Dedupe runs after the event is built so it can compare ack ids, expected
  // session and the delegate-artifact receipt, not only text, context and route.
  if (
    receiptOptions?.allowDuplicate !== true &&
    findDuplicateInQueue(
      entry.queue,
      cleaned,
      normalizedContextKey,
      normalizedDeliveryContext,
      event.sessionDeliveryAckId,
      event.sessionDeliveryAckStateDir,
      event.expectedSessionId,
      event.recipientAuthority,
      event.delegateArtifactReceipt,
    )
  ) {
    return null;
  }
  entry.queue.push(event);
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  return event;
}

export function enqueueSystemEvent(text: string, options: SystemEventOptions) {
  return enqueueOwnedSystemEventEntry(text, options) !== null;
}

export const enqueueSystemEventRaw = enqueueSystemEvent;

/** Enqueues one occurrence and returns one-use removal ownership for its UUID. */
export function enqueueSystemEventWithReceipt(
  text: string,
  options: SystemEventOptions,
  receiptOptions?: ReceiptOptions,
): (() => boolean) | null {
  const event = enqueueOwnedSystemEventEntry(text, options, receiptOptions);
  if (!event) {
    return null;
  }
  const sessionKey = requireSessionKey(options.sessionKey);
  return () => consumeSelectedSystemEventEntries(sessionKey, [event]).length > 0;
}

export function drainSystemEventEntries(sessionKey: string): SystemEvent[] {
  return drainSystemEventsWith(sessionKey, cloneSystemEvent);
}

function drainSystemEventsWith<T>(sessionKey: string, project: (event: SystemEvent) => T): T[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const out = entry.queue.map(project);
  // Reentrant consumers may hold this array; clear it in place before removing the queue.
  entry.queue.length = 0;
  entry.lastContextKey = null;
  queues.delete(key);
  return out;
}

function areDeliveryContextsEqual(left?: DeliveryContext, right?: DeliveryContext): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return channelRouteDedupeKey(left) === channelRouteDedupeKey(right);
}

function areDelegateArtifactReceiptsEqual(
  left?: DelegateArtifactDeliveryReceipt,
  right?: DelegateArtifactDeliveryReceipt,
): boolean {
  return (
    left?.kind === right?.kind &&
    left?.dispatchId === right?.dispatchId &&
    left?.recipientSessionKey === right?.recipientSessionKey &&
    left?.recipientSessionId === right?.recipientSessionId
  );
}

function areRecipientAuthoritiesEqual(
  left?: SessionRecipientAuthority,
  right?: SessionRecipientAuthority,
): boolean {
  return (
    left?.state === right?.state &&
    (left?.state !== "bound" || (right?.state === "bound" && left.epoch === right.epoch))
  );
}

function replaceSystemEventEntry(
  text: string,
  options: SystemEventOptions,
  entry: SessionQueue,
  sessionStorePath: string | null | undefined,
): SystemEvent | null {
  const cleaned = text.trim();
  if (!cleaned) {
    return null;
  }
  const normalizedContextKey = normalizeContextKey(options.contextKey);
  if (normalizedContextKey === null) {
    throw new Error("replaced system events require a contextKey");
  }
  const normalizedDeliveryContext = normalizeDeliveryContext(options.deliveryContext);
  const normalizedTraceparent = normalizeTraceparent(options.traceparent);
  const sessionDeliveryAckStateDir = resolveSessionDeliveryAckStateDir(options);
  const replacement: SystemEvent = {
    id: generateSecureUuid(),
    text: cleaned,
    ts: Date.now(),
    ...(sessionStorePath === undefined ? {} : { sessionStorePath }),
    contextKey: normalizedContextKey,
    deliveryContext: normalizedDeliveryContext,
    ...(options.sessionDeliveryAckId ? { sessionDeliveryAckId: options.sessionDeliveryAckId } : {}),
    ...(sessionDeliveryAckStateDir ? { sessionDeliveryAckStateDir } : {}),
    ...(options.trusted === true && options.expectedSessionId
      ? { expectedSessionId: options.expectedSessionId }
      : {}),
    ...(options.trusted === true && options.recipientAuthority
      ? { recipientAuthority: { ...options.recipientAuthority } }
      : {}),
    ...(options.trusted === true && options.delegateArtifactReceipt
      ? { delegateArtifactReceipt: { ...options.delegateArtifactReceipt } }
      : {}),
    ...(normalizedTraceparent ? { traceparent: normalizedTraceparent } : {}),
  };
  const matches = (event: SystemEvent) =>
    (event.contextKey ?? null) === normalizedContextKey &&
    areDeliveryContextsEqual(event.deliveryContext, normalizedDeliveryContext);
  const matching = entry.queue.filter(matches);
  if (
    matching.length === 1 &&
    matching[0]?.text === replacement.text &&
    matching[0]?.sessionDeliveryAckId === replacement.sessionDeliveryAckId &&
    matching[0]?.sessionDeliveryAckStateDir === replacement.sessionDeliveryAckStateDir &&
    matching[0]?.expectedSessionId === replacement.expectedSessionId &&
    areRecipientAuthoritiesEqual(matching[0]?.recipientAuthority, replacement.recipientAuthority) &&
    areDelegateArtifactReceiptsEqual(
      matching[0]?.delegateArtifactReceipt,
      replacement.delegateArtifactReceipt,
    ) &&
    matching[0]?.traceparent === replacement.traceparent
  ) {
    return null;
  }

  // One keyed source owns one queue slot. Moving a replacement to the end keeps
  // event ordering current without allowing repeated updates to evict other sources.
  entry.queue = entry.queue.filter((event) => !matches(event));
  entry.queue.push(replacement);
  if (entry.queue.length > MAX_EVENTS) {
    entry.queue.shift();
  }
  entry.lastContextKey = normalizedContextKey;
  return replacement;
}

function isDuplicateSystemEvent(
  existing: SystemEvent,
  incoming: Pick<
    SystemEvent,
    | "text"
    | "contextKey"
    | "deliveryContext"
    | "sessionDeliveryAckId"
    | "sessionDeliveryAckStateDir"
    | "expectedSessionId"
    | "recipientAuthority"
    | "delegateArtifactReceipt"
  >,
): boolean {
  return (
    existing.text === incoming.text &&
    (existing.contextKey ?? null) === (incoming.contextKey ?? null) &&
    existing.sessionDeliveryAckId === incoming.sessionDeliveryAckId &&
    existing.sessionDeliveryAckStateDir === incoming.sessionDeliveryAckStateDir &&
    existing.expectedSessionId === incoming.expectedSessionId &&
    areRecipientAuthoritiesEqual(existing.recipientAuthority, incoming.recipientAuthority) &&
    areDelegateArtifactReceiptsEqual(
      existing.delegateArtifactReceipt,
      incoming.delegateArtifactReceipt,
    ) &&
    areDeliveryContextsEqual(existing.deliveryContext, incoming.deliveryContext)
  );
}

function areLegacySystemEventsEqual(left: SystemEvent, right: SystemEvent): boolean {
  return (
    left.text === right.text &&
    left.ts === right.ts &&
    (left.contextKey ?? null) === (right.contextKey ?? null) &&
    left.sessionDeliveryAckId === right.sessionDeliveryAckId &&
    left.sessionDeliveryAckStateDir === right.sessionDeliveryAckStateDir &&
    left.expectedSessionId === right.expectedSessionId &&
    areRecipientAuthoritiesEqual(left.recipientAuthority, right.recipientAuthority) &&
    areDelegateArtifactReceiptsEqual(left.delegateArtifactReceipt, right.delegateArtifactReceipt) &&
    (left.traceparent ?? undefined) === (right.traceparent ?? undefined) &&
    areDeliveryContextsEqual(left.deliveryContext, right.deliveryContext)
  );
}

function matchesConsumedSystemEvent(queued: SystemEvent, consumed: SystemEvent): boolean {
  if (consumed.id !== undefined) {
    // Queue-owned IDs govern modern consumption; only legacy ID-less snapshots use structure.
    return queued.id === consumed.id;
  }
  return areLegacySystemEventsEqual(queued, consumed);
}

function resetQueueState(key: string, entry: SessionQueue) {
  if (entry.queue.length === 0) {
    entry.lastContextKey = null;
    queues.delete(key);
    return;
  }
  for (let index = entry.queue.length - 1; index >= 0; index -= 1) {
    const contextKey = expectDefined(entry.queue[index], "queue entry at index").contextKey ?? null;
    if (contextKey !== null) {
      entry.lastContextKey = contextKey;
      return;
    }
  }
  entry.lastContextKey = null;
}

export function consumeSelectedSystemEventEntries(
  sessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0 || consumedEntries.length === 0) {
    return [];
  }
  const removed: SystemEvent[] = [];
  for (const consumed of consumedEntries) {
    const index = entry.queue.findIndex((event) => matchesConsumedSystemEvent(event, consumed));
    if (index === -1) {
      continue;
    }
    const [event] = entry.queue.splice(index, 1);
    if (event) {
      removed.push(cloneSystemEvent(event));
    }
  }
  resetQueueState(key, entry);
  return removed;
}

export function drainSystemEvents(sessionKey: string): string[] {
  return drainSystemEventsWith(sessionKey, (event) => event.text);
}

/**
 * Remove system events matching a predicate without draining the entire queue.
 * Returns the removed events; non-matching events stay queued.
 */
export function removeSystemEvents(
  sessionKey: string,
  predicate: (event: SystemEvent) => boolean,
): SystemEvent[] {
  const key = requireSessionKey(sessionKey);
  const entry = queues.get(key);
  if (!entry || entry.queue.length === 0) {
    return [];
  }
  const removed: SystemEvent[] = [];
  entry.queue = entry.queue.filter((event) => {
    if (predicate(event)) {
      removed.push(event);
      return false;
    }
    return true;
  });
  if (removed.length > 0) {
    resetQueueState(key, entry);
  }
  return removed;
}

export function peekSystemEventEntries(sessionKey: string): SystemEvent[] {
  return getSessionQueue(sessionKey)?.queue.map(cloneSystemEvent) ?? [];
}

export function peekSystemEvents(sessionKey: string): string[] {
  return getSessionQueue(sessionKey)?.queue.map((event) => event.text) ?? [];
}

export function hasSystemEvents(sessionKey: string) {
  return (getSessionQueue(sessionKey)?.queue.length ?? 0) > 0;
}

export function resolveSystemEventDeliveryContext(
  events: readonly SystemEvent[],
): DeliveryContext | undefined {
  let resolved: DeliveryContext | undefined;
  for (const event of events) {
    resolved = mergeDeliveryContext(event.deliveryContext, resolved);
  }
  return resolved;
}

export function resetSystemEventsForTest() {
  queues.clear();
}
