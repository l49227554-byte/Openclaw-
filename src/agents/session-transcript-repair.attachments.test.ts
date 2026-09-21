// Verifies transcript repair preserves sessions_spawn attachments and ACP routing fields.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, it, expect } from "vitest";
import { sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

function mkSessionsSpawnToolCall(content: string): AgentMessage {
  // sessions_spawn attachments are transcript-owned payloads, not redaction targets.
  return castAgentMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "sessions_spawn",
        arguments: {
          task: "do thing",
          attachments: [
            {
              name: "README.md",
              encoding: "utf8",
              content,
            },
          ],
        },
      },
    ],
    timestamp: 0,
  });
}

describe("sanitizeToolCallInputs preserves sessions_spawn payloads", () => {
  it.each([false, true])(
    "scans 1000 signed tool calls once for attachment presence (attached: %s)",
    (attached) => {
      const thinking = {
        type: "thinking",
        thinking: "Replay the completed work.",
        thinkingSignature: "signed-attachment-fixture",
      };
      const calls = Array.from({ length: 1000 }, (_, index) => ({
        type: "toolUse",
        id: `call_${index}`,
        name: "sessions_spawn",
        input: {
          task: `Recorded task ${index}`,
          attachments:
            attached && index === 999
              ? [{ name: "payload.txt", content: "TRANSCRIPT_ATTACHMENT_CONTENT" }]
              : [],
        },
      }));
      const content = [thinking, ...calls];
      const assistant = { role: "assistant", content, timestamp: 0 };
      const input = castAgentMessages([
        assistant,
        ...calls.map(({ id, name }) => ({
          role: "toolResult",
          toolCallId: id,
          toolName: name,
          content: [{ type: "text", text: "Completed" }],
          timestamp: 0,
        })),
      ]);
      const before = JSON.stringify(input);
      const descriptors = calls.map((call) =>
        Object.getOwnPropertyDescriptor(call.input, "attachments")!,
      );
      let attachmentReads = 0;
      // Count real input reads without changing the values or retaining mock-call histories.
      for (const [index, call] of calls.entries()) {
        const descriptor = descriptors[index]!;
        const attachments = call.input.attachments;
        Object.defineProperty(call.input, "attachments", {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() {
            attachmentReads += 1;
            return attachments;
          },
        });
      }
      const out = (() => {
        try {
          return sanitizeToolCallInputs(input, {
            allowedToolNames: ["sessions_spawn"],
            allowProviderOwnedThinkingReplay: true,
          });
        } finally {
          for (const [index, call] of calls.entries()) {
            Object.defineProperty(call.input, "attachments", descriptors[index]!);
          }
        }
      })();

      expect(out).toBe(input);
      expect(out).toStrictEqual(JSON.parse(before));
      expect(out[0]).toBe(assistant);
      expect(assistant.content).toBe(content);
      expect(assistant.content[0]).toBe(thinking);
      expect(JSON.stringify(input)).toBe(before);
      expect(attachmentReads).toBe(1000);
    },
  );

  it.each(["call_spawn", "call_read"])(
    "drops the whole signed attachment turn when sibling %s has no result",
    (missingId) => {
      const assistant = {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Replay attachment work and its sibling.",
            thinkingSignature: "signed-sibling-fixture",
          },
          {
            type: "toolUse",
            id: "call_spawn",
            name: "sessions_spawn",
            input: {
              task: "Inspect attachment",
              attachments: [{ name: "payload.txt", content: "PRESERVED_ATTACHMENT_CONTENT" }],
            },
          },
          { type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } },
        ],
      };
      const result = {
        role: "toolResult",
        toolCallId: missingId === "call_spawn" ? "call_read" : "call_spawn",
        toolName: missingId === "call_spawn" ? "read" : "sessions_spawn",
        content: [{ type: "text", text: "Completed sibling" }],
      };
      const input = castAgentMessages([assistant, result]);
      const before = JSON.stringify(input);
      const out = sanitizeToolCallInputs(input, {
        allowedToolNames: ["sessions_spawn", "read"],
        allowProviderOwnedThinkingReplay: true,
      });

      expect(out).toStrictEqual([result]);
      expect(out[0]).toBe(result);
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  it("keeps attachment content in transcript-owned tool calls", () => {
    const content = "LOCAL_ATTACHMENT_CONTENT";
    const input = [mkSessionsSpawnToolCall(content)];
    const out = sanitizeToolCallInputs(input);

    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(content);
  });

  it("keeps attachment content from tool input payloads too", () => {
    const content = "INPUT_ATTACHMENT_CONTENT";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_2",
            name: "sessions_spawn",
            input: {
              task: "do thing",
              attachments: [{ name: "x.txt", content }],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(content);
  });

  it("keeps non-content attachment payload fields unchanged", () => {
    const nestedValue = "NESTED_ATTACHMENT_VALUE";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_3",
            name: "sessions_spawn",
            input: {
              task: "do thing",
              attachments: [
                {
                  name: "payload.json",
                  mimeType: "application/json",
                  encoding: "utf8",
                  data: nestedValue,
                  nested: { value: nestedValue },
                },
              ],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(nestedValue);
  });

  it("keeps ACP routing fields unchanged", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_4",
            name: "sessions_spawn",
            arguments: {
              task: "do thing",
              resumeSessionId: "argument-session",
              streamTo: "parent",
            },
          },
          {
            type: "toolUse",
            id: "call_5",
            name: "sessions_spawn",
            input: {
              task: "do other thing",
              resumeSessionId: "input-session",
              streamTo: "parent",
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
  });
});

describe("sanitizeToolCallInputs redacts continue_delegate snapshots", () => {
  it("redacts attachment names and content while preserving replay-safe metadata", () => {
    const argumentsSecret = "CONTINUE_ARGUMENTS_SECRET";
    const inputSecret = "CONTINUE_INPUT_SECRET";
    const argumentsName = "CONTINUE_ARGUMENTS_NAME_MUST_NOT_ECHO.md";
    const inputName = "CONTINUE_INPUT_NAME_MUST_NOT_ECHO.txt";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_continue_arguments",
            name: " continue_delegate ",
            arguments: {
              task: "use the argument snapshot",
              attachments: [
                {
                  name: argumentsName,
                  content: argumentsSecret,
                  encoding: "utf8",
                  mimeType: "text/markdown",
                },
              ],
            },
          },
          {
            type: "toolUse",
            id: "call_continue_input",
            name: "continue_delegate",
            input: {
              task: "use the input snapshot",
              attachments: [{ name: inputName, content: inputSecret }],
            },
          },
        ],
      },
    ]);

    const serialized = JSON.stringify(sanitizeToolCallInputs(input));
    expect(serialized).not.toContain(argumentsSecret);
    expect(serialized).not.toContain(inputSecret);
    expect(serialized).not.toContain(argumentsName);
    expect(serialized).not.toContain(inputName);
    expect(serialized).toContain('"content":"__OPENCLAW_REDACTED__"');
    expect(serialized).toContain('"mimeType":"text/markdown"');
    expect(serialized).toContain("use the input snapshot");
  });

  it("replaces malformed members and drops unknown attachment fields", () => {
    const primitiveSecret = "CONTINUE_PRIMITIVE_SECRET";
    const unknownFieldSecret = "CONTINUE_UNKNOWN_FIELD_SECRET";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_continue_malformed",
            name: "continue_delegate",
            arguments: {
              task: "reject malformed snapshot metadata",
              attachments: [
                primitiveSecret,
                {
                  name: "brief.md",
                  content: "CONTINUE_CONTENT_SECRET",
                  encoding: "utf8",
                  mimeType: "text/markdown",
                  extra: unknownFieldSecret,
                },
              ],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(primitiveSecret);
    expect(serialized).not.toContain(unknownFieldSecret);
    expect(serialized).not.toContain("CONTINUE_CONTENT_SECRET");
    expect(serialized).not.toContain('"extra"');
    expect(serialized).toContain('"content":"__OPENCLAW_REDACTED__"');
    expect(serialized).not.toContain('"name":"brief.md"');
    expect(serialized).toContain('"encoding":"utf8"');
    expect(serialized).toContain('"mimeType":"text/markdown"');
  });

  it("removes malformed non-array attachments without retaining nested content", () => {
    const secret = "CONTINUE_NON_ARRAY_SECRET";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_continue_non_array",
            name: "continue_delegate",
            arguments: {
              task: "reject a malformed attachment collection",
              attachments: { content: secret, nested: { content: secret } },
            },
          },
        ],
      },
    ]);

    const serialized = JSON.stringify(sanitizeToolCallInputs(input));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('"attachments"');
    expect(serialized).toContain("reject a malformed attachment collection");
  });

  it("projects attachAs to its closed mount-hint shape", () => {
    const secret = "CONTINUE_ATTACH_AS_SECRET";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_continue_attach_as",
            name: "continue_delegate",
            arguments: {
              task: "use a mounted snapshot",
              attachments: [{ name: "brief.md", content: "CONTINUE_CONTENT_SECRET" }],
              attachAs: {
                mountPath: "handoff",
                unknown: secret,
              },
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("CONTINUE_CONTENT_SECRET");
    expect(serialized).not.toContain('"unknown"');
    expect(serialized).toContain('"attachAs":{"mountPath":"handoff"}');
  });

  it("removes mount hints when no attachment snapshot exists", () => {
    const secret = "CONTINUE_UNUSED_ATTACH_AS_SECRET";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_continue_unused_attach_as",
            name: "continue_delegate",
            input: {
              task: "continue without a snapshot",
              attach_as: {
                mount_path: "unused",
                unknown: secret,
              },
            },
          },
        ],
      },
    ]);

    const serialized = JSON.stringify(sanitizeToolCallInputs(input));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('"attach_as":');
    expect(serialized).toContain("continue without a snapshot");
  });

  it("drops a signed-thinking turn when non-array attachments require sanitization", () => {
    const secret = "CONTINUE_SIGNED_NON_ARRAY_SECRET";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Use the malformed continuation snapshot.",
            thinkingSignature: "sig_continue_delegate_malformed",
          },
          {
            type: "toolUse",
            id: "call_continue_signed_non_array",
            name: "continue_delegate",
            input: {
              task: "reject a signed malformed attachment collection",
              attachments: { content: secret },
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["continue_delegate"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("drops a signed-thinking turn when attachAs contains unknown fields", () => {
    const secret = "CONTINUE_SIGNED_ATTACH_AS_SECRET";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Use the mounted continuation snapshot.",
            thinkingSignature: "sig_continue_delegate_attach_as",
          },
          {
            type: "toolUse",
            id: "call_continue_signed_attach_as",
            name: "continue_delegate",
            input: {
              task: "reject signed unknown mount metadata",
              attachments: [
                {
                  content: "__OPENCLAW_REDACTED__",
                  name: "brief.md",
                },
              ],
              attachAs: {
                mountPath: "handoff",
                unknown: secret,
              },
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["continue_delegate"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("preserves an already-redacted signed-thinking turn byte-for-byte", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Use the already-sanitized continuation snapshot.",
            thinkingSignature: "sig_continue_delegate",
          },
          {
            type: "toolUse",
            id: "call_continue_redacted",
            name: "continue_delegate",
            input: {
              task: "use the sanitized snapshot",
              attachments: [
                {
                  content: "__OPENCLAW_REDACTED__",
                  name: "brief.md",
                  encoding: "utf8",
                  mimeType: "text/markdown",
                },
              ],
              attachAs: { mountPath: "handoff" },
            },
          },
        ],
      },
    ]);

    const repaired = sanitizeToolCallInputs(input);
    const repairedBytes = JSON.stringify(repaired);
    expect(repaired).not.toBe(input);
    expect(repairedBytes).not.toContain('"name":"brief.md"');
    expect(repairedBytes).toContain('"content":"__OPENCLAW_REDACTED__"');

    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["continue_delegate"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toBe(input);
  });
});
