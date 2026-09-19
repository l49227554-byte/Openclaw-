import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

describe("authorized tool result transformation", () => {
  const event = {
    toolName: "memory_search",
    params: { query: "q" },
    result: { content: [{ type: "text", text: "original" }] },
  };
  const context = { toolName: "memory_search", sessionKey: "private" };
  it("returns the first applicable transformation without mutating source", async () => {
    const skip = vi.fn();
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_transform",
          handler: async (value) => {
            const copy = value as typeof event;
            copy.result.content[0].text = "ranked";
            return { result: copy.result };
          },
          priority: 10,
        },
        { hookName: "tool_result_transform", handler: skip },
      ]),
    );
    expect((await runner.runToolResultTransform(event, context))?.result.content).toEqual([
      { type: "text", text: "ranked" },
    ]);
    expect(event.result.content[0].text).toBe("original");
    expect(skip).not.toHaveBeenCalled();
  });
  it("falls back on exception or timeout, preserving the original", async () => {
    for (const handler of [
      async () => {
        throw new Error("offline");
      },
      async () => await new Promise(() => {}),
    ]) {
      const runner = createHookRunner(
        createMockPluginRegistry([{ hookName: "tool_result_transform", handler, timeoutMs: 10 }]),
        { catchErrors: true },
      );
      expect(await runner.runToolResultTransform(event, context)).toBeUndefined();
      expect(event.result.content[0].text).toBe("original");
    }
  });
});
