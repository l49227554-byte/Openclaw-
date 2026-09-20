import type { PluginHookBeforeModelResolveNotice } from "../../../plugins/types.js";
import type { BlockReplyPayload } from "../../embedded-agent-payloads.js";

const NOTICE_TTL_MS = 10 * 60_000;
const MAX_NOTICE_RUNS = 2_048;
const DEFAULT_CALLBACK_TIMEOUT_MS = 2_000;

// A run may prepare more than one candidate while resolving failover. Keep the
// notice at most once for that run, without making delivery a channel concern.
const noticeRuns = new Map<string, { state: "pending" | "delivered"; at: number }>();

export type PreDispatchNoticeDelivery = "delivered" | "skipped" | "failed";

function pruneNoticeRuns(now: number): void {
  for (const [runId, entry] of noticeRuns) {
    if (entry.at < now - NOTICE_TTL_MS) {
      noticeRuns.delete(runId);
    }
  }
  while (noticeRuns.size > MAX_NOTICE_RUNS) {
    const oldest = noticeRuns.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    noticeRuns.delete(oldest);
  }
}

function claimNotice(runId: string | undefined, now: number): boolean {
  if (!runId) {
    // The normal embedded-run path always supplies a run id. If a lightweight
    // caller does not, it has no stable key on which the host can deduplicate.
    return true;
  }
  pruneNoticeRuns(now);
  const existing = noticeRuns.get(runId);
  if (existing) {
    return false;
  }
  noticeRuns.set(runId, { state: "pending", at: now });
  return true;
}

function finishNotice(runId: string | undefined, delivered: boolean, now: number): void {
  if (!runId) {
    return;
  }
  if (delivered) {
    noticeRuns.set(runId, { state: "delivered", at: now });
  } else {
    // A failed callback did not deliver anything. Allow a later preparation
    // attempt to retry while keeping concurrent preparations deduplicated.
    noticeRuns.delete(runId);
  }
}

/**
 * Delivers a hook-produced routing notice through the host-owned pre-dispatch
 * callback when available, falling back to the existing block-reply callback
 * for channels without a durable transcript renderer. The host callback is an
 * awaited ordering boundary for the model dispatch; transport-only block
 * delivery remains bounded and fail-open if its callback is unavailable or
 * rejects.
 */
export async function deliverPreDispatchNotice(params: {
  notice?: PluginHookBeforeModelResolveNotice;
  runId?: string;
  signal?: AbortSignal;
  onPreDispatchNotice?: (payload: BlockReplyPayload) => boolean | void | Promise<boolean | void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  onBlockReplyFlush?: (context: { reason: "message_end" }) => void | Promise<void>;
  now?: () => number;
  callbackTimeoutMs?: number;
}): Promise<PreDispatchNoticeDelivery> {
  const notice = params.notice;
  const onPreDispatchNotice = params.onPreDispatchNotice;
  const onBlockReply = params.onBlockReply;
  const signal = params.signal;
  if (
    !notice ||
    typeof notice.text !== "string" ||
    !notice.text.trim() ||
    (!onPreDispatchNotice && !onBlockReply)
  ) {
    return "skipped";
  }
  signal?.throwIfAborted();
  const now = params.now ?? Date.now;
  const claimedAt = now();
  if (!claimNotice(params.runId, claimedAt)) {
    return "skipped";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startFallbackTimeout: (() => void) | undefined;
  const timeoutPromise = onBlockReply
    ? new Promise<"timeout">((resolve) => {
        startFallbackTimeout = () => {
          timer = setTimeout(
            () => resolve("timeout"),
            params.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
          );
        };
      })
    : undefined;
  let deliveryPromise: Promise<void>;
  try {
    deliveryPromise = (async () => {
      const payload: BlockReplyPayload = { text: notice.text, isStatusNotice: true };
      let handledByHost = false;
      try {
        handledByHost = (await onPreDispatchNotice?.(payload)) === true;
      } catch {
        // A failed durable renderer must not suppress the channel fallback.
        // The callback's owner logs the persistence failure with its target.
      }
      if (!handledByHost) {
        // Keep the durable callback as an awaited ordering boundary. If it
        // declines or fails, start a fresh bounded budget for transport-only
        // fallback at the point where that fallback begins.
        startFallbackTimeout?.();
        if (!onBlockReply) {
          throw new Error("pre-dispatch notice host renderer did not handle the notice");
        }
        await onBlockReply?.(payload);
        // A streaming block handler can enqueue synchronously. Flush its
        // pipeline so the awaited boundary represents actual channel delivery
        // before model setup proceeds.
        await params.onBlockReplyFlush?.({ reason: "message_end" });
      }
    })();
  } catch {
    finishNotice(params.runId, false, now());
    if (signal?.aborted) {
      signal.throwIfAborted();
    }
    return "failed";
  }

  // Keep a rejected transport callback from becoming an unhandled rejection
  // if its bounded wait below expires first. A late completion still records
  // whether the pending delivery eventually succeeded for run-level
  // deduplication.
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  const finish = (delivered: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    finishNotice(params.runId, delivered, now());
  };
  void deliveryPromise.then(
    () => {
      if (timedOut || cancelled) {
        finish(true);
      }
    },
    () => {
      if (timedOut || cancelled) {
        finish(false);
      }
    },
  );

  let removeAbortListener: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<"aborted">((_, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("aborted"));
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      })
    : undefined;
  try {
    const result = await Promise.race([
      deliveryPromise.then(() => "delivered" as const),
      ...(timeoutPromise ? [timeoutPromise] : []),
      ...(abortPromise ? [abortPromise] : []),
    ]);
    if (result === "timeout") {
      timedOut = true;
      return "failed";
    }
    finish(true);
    signal?.throwIfAborted();
    return "delivered";
  } catch {
    if (signal?.aborted) {
      // Keep the pending claim until the host callback settles. A callback may
      // already have queued a send when cancellation races its completion; the
      // late result must close the claim so a retry cannot duplicate it.
      cancelled = true;
      signal.throwIfAborted();
    }
    finish(false);
    return "failed";
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    removeAbortListener?.();
  }
}
