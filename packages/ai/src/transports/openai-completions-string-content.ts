/**
 * OpenAI Chat Completions compatibility helpers. Some providers only accept
 * role/content messages with plain string content instead of text block arrays.
 * Models that declare `compat.supportsTools: false` also cannot replay
 * `tool_calls` or `role: "tool"` turns — those backends reject the request.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

function readMessageRole(message: Record<string, unknown>): string | undefined {
  return typeof message.role === "string" ? message.role : undefined;
}

function readPlainMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const textParts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
      continue;
    }
    textParts.push(item.text);
  }
  return textParts.join("\n");
}

function formatToolArguments(raw: unknown): string {
  if (raw == null) {
    return "";
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return "";
  }
}

function formatToolProtocolLine(
  kind: "call" | "result",
  attrs: { id?: string; name?: string },
  detail = "",
): string {
  const labeled = [
    kind === "call" ? "tool call" : "tool result",
    attrs.id ? `id=${attrs.id}` : "",
    attrs.name ? `name=${attrs.name}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  const head = `[${labeled}]`;
  return detail.length > 0 ? `${head} ${detail}` : head;
}

function summarizeCompletionToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "";
  }
  const lines = toolCalls.flatMap((call) => {
    if (!isRecord(call)) {
      return [];
    }
    const fn = isRecord(call.function) ? call.function : undefined;
    const name = typeof fn?.name === "string" ? fn.name : "";
    const id = typeof call.id === "string" ? call.id : "";
    if (!name && !id && !fn) {
      return [];
    }
    return [formatToolProtocolLine("call", { id, name }, formatToolArguments(fn?.arguments))];
  });
  return lines.join("\n");
}

function summarizeLegacyFunctionCall(functionCall: unknown): string {
  if (!isRecord(functionCall)) {
    return "";
  }
  const name = typeof functionCall.name === "string" ? functionCall.name : "";
  return formatToolProtocolLine("call", { name }, formatToolArguments(functionCall.arguments));
}

function appendAssistantPlainText(message: Record<string, unknown>, extra: string): void {
  const current = readPlainMessageText(message.content);
  const next = [current, extra].filter((part) => part.trim().length > 0).join("\n");
  message.content = next.length > 0 ? next : extra;
}

function flattenStringOnlyCompletionContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const textParts: string[] = [];
  for (const item of content) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return content;
    }
    textParts.push((item as { text: string }).text);
  }
  return textParts.join("\n");
}

/** Flatten string-only text block content arrays into newline-joined strings. */
export function flattenCompletionMessagesToStringContent(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object") {
      return message;
    }
    const content = (message as { content?: unknown }).content;
    const flattenedContent = flattenStringOnlyCompletionContent(content);
    if (flattenedContent === content) {
      return message;
    }
    return {
      ...message,
      content: flattenedContent,
    };
  });
}

/** Strip completion messages to role/content fields for strict providers. */
export function stripCompletionMessagesToRoleContent(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return message;
    }
    const record = message as Record<string, unknown>;
    const stripped: Record<string, unknown> = {};
    if (Object.hasOwn(record, "role")) {
      stripped.role = record.role;
    }
    if (Object.hasOwn(record, "content")) {
      stripped.content = record.content;
    }
    return stripped;
  });
}

/**
 * Replay tool protocol as plain assistant text. Chat Completions backends that
 * do not accept tools still 400 if prior `tool_calls` or tool-result roles
 * remain after the `tools` array is omitted. Collapsed rows remap
 * `cacheOptOutIndexes` so later runtime-context carriers keep their exclusion.
 */
export function flattenUnsupportedCompletionsToolHistory(
  messages: unknown[],
  cacheOptOutIndexes?: Set<number>,
): unknown[] {
  const out: unknown[] = [];
  const oldToNew = new Map<number, number>();
  const callNames = new Map<string, string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!isRecord(message)) {
      oldToNew.set(index, out.length);
      out.push(message);
      continue;
    }
    const role = readMessageRole(message);
    if (role === "tool" || role === "function") {
      const result = readPlainMessageText(message.content);
      const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const named =
        typeof message.name === "string" && message.name.length > 0
          ? message.name
          : callId
            ? callNames.get(callId)
            : undefined;
      const note = formatToolProtocolLine(
        "result",
        {
          id: callId || undefined,
          name: named,
        },
        result.trim(),
      );
      const last = out.at(-1);
      if (isRecord(last) && readMessageRole(last) === "assistant") {
        appendAssistantPlainText(last, note);
        oldToNew.set(index, out.length - 1);
      } else {
        oldToNew.set(index, out.length);
        out.push({ role: "assistant", content: note });
      }
      continue;
    }
    if (role === "assistant") {
      const next: Record<string, unknown> = { ...message };
      const hadToolPayload =
        Object.hasOwn(next, "tool_calls") || Object.hasOwn(next, "function_call");
      if (Array.isArray(next.tool_calls)) {
        for (const call of next.tool_calls) {
          if (!isRecord(call)) {
            continue;
          }
          const fn = isRecord(call.function) ? call.function : undefined;
          const id = typeof call.id === "string" ? call.id : "";
          const name = typeof fn?.name === "string" ? fn.name : "";
          if (id && name) {
            callNames.set(id, name);
          }
        }
      }
      if (isRecord(next.function_call) && typeof next.function_call.name === "string") {
        callNames.set(next.function_call.name, next.function_call.name);
      }
      const toolNote = [
        summarizeCompletionToolCalls(next.tool_calls),
        summarizeLegacyFunctionCall(next.function_call),
      ]
        .filter((part) => part.length > 0)
        .join("\n");
      delete next.tool_calls;
      delete next.function_call;
      if (toolNote) {
        appendAssistantPlainText(next, toolNote);
      } else if (hadToolPayload && readPlainMessageText(next.content).length === 0) {
        next.content = "[tool call]";
      }
      oldToNew.set(index, out.length);
      out.push(next);
      continue;
    }
    oldToNew.set(index, out.length);
    out.push(message);
  }
  if (cacheOptOutIndexes) {
    const remapped = new Set<number>();
    for (const oldIndex of cacheOptOutIndexes) {
      const mapped = oldToNew.get(oldIndex);
      if (mapped !== undefined) {
        remapped.add(mapped);
      }
    }
    cacheOptOutIndexes.clear();
    for (const mapped of remapped) {
      cacheOptOutIndexes.add(mapped);
    }
  }
  return out;
}
