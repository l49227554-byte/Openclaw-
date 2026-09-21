/**
 * Shared tool-call name validation helpers.
 * Keeps model-supplied tool names compact, normalized, and policy-checked
 * before routing them to any tool execution surface.
 */
import type { AgentMessage } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { collectCompletedToolCallBlocks } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { REDACTED_SENTINEL } from "../config/redact-snapshot.js";

const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_:.-]+$/;
const CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS = ["encoding", "mimeType"] as const;
const LEGACY_CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS = [
  "name",
  ...CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS,
] as const;
const TRANSCRIPT_TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "functionCall",
  "tool_call",
  "tool_use",
  "function_call",
]);

type TranscriptToolCallSanitizeOptions = {
  preserveLegacyContinueDelegateAttachmentName?: boolean;
};

export function isTranscriptToolCallBlock(
  value: unknown,
): value is { type: string; name?: unknown; input?: unknown; arguments?: unknown } {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    TRANSCRIPT_TOOL_CALL_BLOCK_TYPES.has(value.type)
  );
}

/** Normalize an optional iterable of allowed tool names for lookup. */
export function normalizeAllowedToolNames(allowedToolNames?: Iterable<string>): Set<string> | null {
  if (!allowedToolNames) {
    return null;
  }
  const normalized = new Set<string>();
  for (const name of allowedToolNames) {
    if (typeof name !== "string") {
      continue;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      continue;
    }
    normalized.add(normalizeLowercaseStringOrEmpty(trimmed));
  }
  return normalized.size > 0 ? normalized : null;
}

/** Return whether a model-supplied tool call name is syntactically and policy allowed. */
export function isAllowedToolCallName(
  name: unknown,
  allowedToolNames: Set<string> | null,
): boolean {
  if (typeof name !== "string") {
    return false;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > TOOL_CALL_NAME_MAX_CHARS || !TOOL_CALL_NAME_RE.test(trimmed)) {
    return false;
  }
  if (!allowedToolNames) {
    return true;
  }
  return allowedToolNames.has(normalizeLowercaseStringOrEmpty(trimmed));
}

function redactContinueDelegateAttachmentContent(
  value: unknown,
  options?: TranscriptToolCallSanitizeOptions,
): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      const redacted = redactContinueDelegateAttachmentContent(parsed, options);
      return redacted === parsed ? value : JSON.stringify(redacted);
    } catch {
      return value;
    }
  }
  if (!isRecord(value)) {
    return value;
  }
  let sanitized = value;
  if (Object.hasOwn(value, "attachments")) {
    if (!Array.isArray(value.attachments)) {
      sanitized = { ...value };
      delete sanitized.attachments;
    } else {
      let changed = false;
      const attachments = value.attachments.map((attachment) => {
        if (
          isRedactedContinueDelegateAttachment(
            attachment,
            options?.preserveLegacyContinueDelegateAttachmentName === true,
          )
        ) {
          return attachment;
        }
        changed = true;
        return redactContinueDelegateAttachment(attachment);
      });
      if (changed) {
        sanitized = { ...value, attachments };
      }
    }
  }
  return sanitizeContinueDelegateAttachAs(
    sanitized,
    Array.isArray(sanitized.attachments) && sanitized.attachments.length > 0,
  );
}

function sanitizeContinueDelegateAttachAs(
  input: Record<string, unknown>,
  hasAttachments: boolean,
): Record<string, unknown> {
  const hasCamel = Object.hasOwn(input, "attachAs");
  const hasSnake = Object.hasOwn(input, "attach_as");
  if (!hasCamel && !hasSnake) {
    return input;
  }
  const key = hasCamel ? "attachAs" : "attach_as";
  const shadowKey = hasCamel ? "attach_as" : "attachAs";
  const attachAs = hasAttachments ? projectContinueDelegateAttachAs(input[key]) : undefined;
  if (attachAs === input[key] && !Object.hasOwn(input, shadowKey)) {
    return input;
  }
  const sanitized = { ...input };
  if (attachAs) {
    sanitized[key] = attachAs;
  } else {
    delete sanitized[key];
  }
  delete sanitized[shadowKey];
  return sanitized;
}

function projectContinueDelegateAttachAs(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const hasCamel = Object.hasOwn(value, "mountPath");
  const hasSnake = Object.hasOwn(value, "mount_path");
  const key = hasCamel ? "mountPath" : hasSnake ? "mount_path" : undefined;
  if (!key || typeof value[key] !== "string" || value[key].trim().length === 0) {
    return undefined;
  }
  return Object.keys(value).length === 1 ? value : { [key]: value[key] };
}

function isRedactedContinueDelegateAttachment(value: unknown, allowLegacyName: boolean): boolean {
  if (!isRecord(value) || value.content !== REDACTED_SENTINEL) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (key === "content") {
      continue;
    }
    const allowedKeys = allowLegacyName
      ? LEGACY_CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS
      : CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS;
    if (!allowedKeys.some((allowedKey) => allowedKey === key)) {
      return false;
    }
    const metadata = value[key];
    if (typeof metadata !== "string" || metadata.trim().length === 0) {
      return false;
    }
    if (key === "encoding" && metadata !== "utf8" && metadata !== "base64") {
      return false;
    }
  }
  return true;
}

function redactContinueDelegateAttachment(value: unknown): Record<string, unknown> {
  const redacted: Record<string, unknown> = { content: REDACTED_SENTINEL };
  if (!isRecord(value)) {
    return redacted;
  }
  for (const key of CONTINUE_DELEGATE_ATTACHMENT_METADATA_KEYS) {
    const metadata = value[key];
    if (typeof metadata !== "string" || metadata.trim().length === 0) {
      continue;
    }
    if (key === "encoding" && metadata !== "utf8" && metadata !== "base64") {
      continue;
    }
    redacted[key] = metadata;
  }
  return redacted;
}

export function sanitizeTranscriptToolCallBlock<
  T extends {
    name?: unknown;
    input?: unknown;
    arguments?: unknown;
    partialArgs?: unknown;
    partialJson?: unknown;
  },
>(block: T, options?: TranscriptToolCallSanitizeOptions): T {
  const rawName = typeof block.name === "string" ? block.name : undefined;
  const trimmedName = rawName?.trim();
  const normalizedName = trimmedName ? trimmedName : undefined;
  const nameChanged = normalizedName !== undefined && rawName !== normalizedName;
  const isContinueDelegate = normalizedName?.toLowerCase() === "continue_delegate";
  const input = isContinueDelegate
    ? redactContinueDelegateAttachmentContent(block.input, options)
    : block.input;
  const args = isContinueDelegate
    ? redactContinueDelegateAttachmentContent(block.arguments, options)
    : block.arguments;
  const removePartialArgs = isContinueDelegate && Object.hasOwn(block, "partialArgs");
  const removePartialJson = isContinueDelegate && Object.hasOwn(block, "partialJson");
  if (
    !nameChanged &&
    input === block.input &&
    args === block.arguments &&
    !removePartialArgs &&
    !removePartialJson
  ) {
    return block;
  }
  // SAFETY: spreading T preserves its own enumerable properties while the mutations retain T's shape.
  const next = { ...block } as T;
  if (nameChanged) {
    next.name = normalizedName;
  }
  if ("input" in block) {
    next.input = input;
  }
  if ("arguments" in block) {
    next.arguments = args;
  }
  if (removePartialArgs) {
    delete next.partialArgs;
  }
  if (removePartialJson) {
    delete next.partialJson;
  }
  return next;
}

/** Completed replay facts survive capability removal without granting live tool authority. */
export function createCompletedToolCallPredicate(messages: readonly AgentMessage[]) {
  const completed = collectCompletedToolCallBlocks(messages);
  return (block: { name?: unknown }): boolean =>
    completed.has(block) && isAllowedToolCallName(block.name, null);
}
