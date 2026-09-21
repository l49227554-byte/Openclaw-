// One wire adapter for QA scenario calls and their logical tool receipts.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { findNamedToolDefinition, hasToolDefinition } from "./mock-openai-directives.js";
import { extractPlannedToolName, extractPlannedToolArgs } from "./mock-openai-events.js";
import {
  extractToolOutput,
  extractToolOutputCallId,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import {
  buildCustomToolCallEventsWithInput,
  buildToolCallEventsWithArgs as buildRawToolCallEventsWithArgs,
} from "./mock-openai-tooling.js";

export const QA_CODE_MODE_TARGET_MARKER = "qa-code-mode-target:";

export function stringifyScenarioToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function encodeCodeModeTarget(name: string, args: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ name, args }), "utf8").toString("base64url");
}

export function decodeCodeModeTarget(code: string | undefined) {
  const marker = code
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`// ${QA_CODE_MODE_TARGET_MARKER}`));
  if (!marker) {
    return null;
  }
  try {
    const encoded = marker.slice(`// ${QA_CODE_MODE_TARGET_MARKER}`.length).trim();
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!isRecord(parsed) || typeof parsed.name !== "string" || !isRecord(parsed.args)) {
      return null;
    }
    return { name: parsed.name, args: parsed.args };
  } catch {
    return null;
  }
}

type CodeModeExecSurface = "native" | "guest";

export function resolveCodeModeExecSurface(
  body: Record<string, unknown>,
): CodeModeExecSurface | null {
  const tools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
  ];
  const execDefinition = findNamedToolDefinition(tools, "exec");
  if (!execDefinition || !hasToolDefinition(body, "wait")) {
    return null;
  }
  if (execDefinition.type === "custom") {
    return "native";
  }
  const schema = execDefinition.input_schema ?? execDefinition.parameters;
  if (!isRecord(schema)) {
    return null;
  }
  const properties = schema.properties;
  const required = schema.required;
  return properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, "code") &&
    Array.isArray(required) &&
    required.includes("code")
    ? "guest"
    : null;
}

export function hasCodeModeExecSurface(body: Record<string, unknown>) {
  return resolveCodeModeExecSurface(body) !== null;
}

export function resolveCurrentToolDeclarationSurface(
  body: Record<string, unknown>,
  input: ResponsesInputItem[],
) {
  const additionalTools = input.flatMap((item) =>
    item.type === "additional_tools" && item.role === "developer" && Array.isArray(item.tools)
      ? item.tools
      : [],
  );
  return additionalTools.length === 0
    ? body
    : {
        ...body,
        tools: [...(Array.isArray(body.tools) ? body.tools : []), ...additionalTools],
      };
}

export function findToolCallByCallId(input: ResponsesInputItem[], callId: string) {
  return input.toReversed().find((item) => {
    const type = item.type;
    return (type === "function_call" || type === "custom_tool_call") && item.call_id === callId;
  });
}

export function buildScenarioToolCallEvents(
  body: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
) {
  // Preserve eager declarations and Code Mode precedence. Structured Tool Search
  // accepts a catalog name directly; scenario fixtures already know their target.
  if (
    !hasToolDefinition(body, name) &&
    !hasCodeModeExecSurface(body) &&
    hasToolDefinition(body, "tool_call")
  ) {
    return buildScenarioToolCallEvents(body, "tool_call", { id: name, args });
  }
  if (
    name === "exec" ||
    name === "wait" ||
    hasToolDefinition(body, name) ||
    !hasCodeModeExecSurface(body)
  ) {
    const declaration = [
      ...(Array.isArray(body.tools) ? body.tools : []),
      ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
    ].find((tool) => findNamedToolDefinition(tool, name));
    const definition = findNamedToolDefinition(declaration, name);
    // Function and custom calls both retain their declared namespace; Codex
    // dispatches the complete identity and rejects a flattened nested tool.
    const namespace =
      declaration &&
      typeof declaration === "object" &&
      declaration.type === "namespace" &&
      typeof declaration.name === "string"
        ? declaration.name
        : undefined;
    if (definition?.type === "custom" && typeof args.input === "string") {
      return buildCustomToolCallEventsWithInput(name, args.input, namespace);
    }
    return buildRawToolCallEventsWithArgs(name, args, namespace);
  }
  const encodedTarget = encodeCodeModeTarget(name, args);
  if (resolveCodeModeExecSurface(body) === "native") {
    return buildCustomToolCallEventsWithInput(
      "exec",
      [
        `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
        `const targetName = ${JSON.stringify(name)};`,
        `const targetArgs = ${JSON.stringify(args)};`,
        "const target = ALL_TOOLS.find((entry) => entry.name === targetName);",
        "if (!target) throw new Error(`QA mock target tool unavailable: ${targetName}`);",
        "let value = await tools[target.name](targetArgs);",
        'if (targetName === "read" && value?.kind === "text" && typeof value.content === "string") {',
        "  value = { ...value, content: value.content.slice(0, 2048) };",
        "}",
        "text(JSON.stringify(value));",
      ].join("\n"),
    );
  }
  return buildRawToolCallEventsWithArgs("exec", {
    code: [
      `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
      `const targetName = ${JSON.stringify(name)};`,
      `const targetArgs = ${JSON.stringify(args)};`,
      "const target = (await catalog.search(targetName)).find((entry) => entry.toolName === targetName);",
      "if (!target) throw new Error(`QA mock target tool unavailable: ${targetName}`);",
      "const value = await target(targetArgs);",
      'if (targetName === "read" && value?.kind === "text" && typeof value.content === "string") {',
      "  return { ...value, content: value.content.slice(0, 2048) };",
      "}",
      "return value;",
    ].join("\n"),
  });
}

export function extractScenarioPlannedTool(events: StreamEvent[]) {
  const wireName = extractPlannedToolName(events);
  const wireArgs = extractPlannedToolArgs(events);
  const structured = wireName === "tool_call" ? readStructuredToolCallTarget(wireArgs) : null;
  if (structured) {
    return { ...structured, wireName };
  }
  const source =
    typeof wireArgs?.input === "string"
      ? wireArgs.input
      : typeof wireArgs?.code === "string"
        ? wireArgs.code
        : undefined;
  if (wireName !== "exec" || !source) {
    return { name: wireName, args: wireArgs, wireName };
  }
  const target = decodeCodeModeTarget(source);
  return target
    ? { name: target.name, args: target.args, wireName }
    : { name: wireName, args: wireArgs, wireName };
}

export function canCallScenarioTool(body: Record<string, unknown>, name: string): boolean {
  return (
    hasToolDefinition(body, name) ||
    hasCodeModeExecSurface(body) ||
    hasToolDefinition(body, "tool_call")
  );
}

export function readStructuredToolCallTarget(args: unknown) {
  return isRecord(args) && typeof args.id === "string" && isRecord(args.args)
    ? { name: args.id, args: args.args }
    : null;
}

/** Unwrap only the current dispatcher's matching receipt, never arbitrary nested tool text. */
export function readScenarioToolOutput(input: ResponsesInputItem[]): string {
  const raw = extractToolOutput(input);
  const call = findToolCallByCallId(input, extractToolOutputCallId(input));
  if (call?.name !== "tool_call" || typeof call.arguments !== "string") {
    return raw;
  }
  const target = readStructuredToolCallTarget(parseToolOutputJson(call.arguments));
  const envelope = parseToolOutputJson(raw);
  if (
    !target ||
    !isRecord(envelope?.tool) ||
    (envelope.tool.name !== target.name && envelope.tool.id !== target.name) ||
    !isRecord(envelope.result)
  ) {
    return raw;
  }
  const result = envelope.result;
  if (Object.hasOwn(result, "details")) {
    return stringifyScenarioToolOutput(result.details);
  }
  if (Array.isArray(result.content)) {
    return result.content
      .flatMap((block) =>
        isRecord(block) && block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("\n");
  }
  return raw;
}
