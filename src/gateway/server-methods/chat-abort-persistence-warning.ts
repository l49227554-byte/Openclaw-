import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";

export const ABORTED_PARTIAL_PERSISTENCE_WARNING =
  "An assistant message streamed before this abort could not be saved to the transcript and is missing from history. It cannot be recovered; the abort itself completed.";

/** Keeps transcript-loss visibility when abort cleanup itself must return an error. */
export function withAbortedPartialPersistenceWarning(
  error: ErrorShape,
  warning: string | undefined,
): ErrorShape {
  return warning ? { ...error, message: `${error.message} ${warning}` } : error;
}

export type QueuedCollectorAbortOutcome = Result<
  { aborted: boolean; runIds: string[]; warning?: string },
  ErrorShape
>;

export type ChatSessionAbortResult<Descendants> = {
  aborted: boolean;
  runIds: string[];
  unauthorized: boolean;
  error?: ErrorShape;
  warning?: string;
  descendants?: Descendants;
};

export function withQueuedCollectorPersistenceWarning(
  outcome: QueuedCollectorAbortOutcome,
  failed: boolean,
): QueuedCollectorAbortOutcome {
  if (!failed) {
    return outcome;
  }
  return outcome.ok
    ? {
        ok: true,
        value: { ...outcome.value, warning: ABORTED_PARTIAL_PERSISTENCE_WARNING },
      }
    : {
        ok: false,
        error: withAbortedPartialPersistenceWarning(
          outcome.error,
          ABORTED_PARTIAL_PERSISTENCE_WARNING,
        ),
      };
}

export async function finishAbortedPartialPersistence(params: {
  finish: () => Promise<boolean>;
  hasPrimaryFailure: boolean;
  warn: (message: string) => void;
}): Promise<boolean> {
  try {
    return await params.finish();
  } catch (error) {
    if (!params.hasPrimaryFailure) {
      throw error;
    }
    params.warn("chat.abort could not persist captured output after cancellation was rejected");
    return false;
  }
}
