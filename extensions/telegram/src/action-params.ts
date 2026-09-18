// Telegram plugin module implements action parameter reading.
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/channel-actions";

/** Telegram accepts either spelling from callers; both resolve to the same thread. */
export function readTelegramThreadId(params: Record<string, unknown>) {
  return (
    readPositiveIntegerParam(params, "messageThreadId", {
      message: "messageThreadId must be a positive integer.",
    }) ??
    readPositiveIntegerParam(params, "threadId", {
      message: "threadId must be a positive integer.",
    })
  );
}

/** Telegram accepts either spelling from callers; both resolve to the same reply target. */
export function readTelegramReplyToMessageId(params: Record<string, unknown>) {
  return (
    readPositiveIntegerParam(params, "replyToMessageId", {
      message: "replyToMessageId must be a positive integer.",
    }) ??
    readPositiveIntegerParam(params, "replyTo", {
      message: "replyTo must be a positive integer.",
    })
  );
}
