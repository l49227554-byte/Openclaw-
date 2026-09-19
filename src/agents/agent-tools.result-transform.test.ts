import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { bindAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "./tools/common.js";

afterEach(() => initializeGlobalHookRunner(createMockPluginRegistry([])));
describe("terminal result transformation boundary", () => {
  const makeTool = (): AnyAgentTool => ({
    name: "memory_search",
    label: "memory",
    description: "read",
    parameters: { type: "object", properties: {} } as never,
    execute: vi.fn(async () => ({
      content: [{ type: "text", text: "original" }],
      details: { provenance: "retained" },
    })),
  });
  it("transforms the actual returned result once after source execution", async () => {
    const source = makeTool();
    const handler = vi.fn(async () => {
      expect(source.execute).toHaveBeenCalledTimes(1);
      return {
        result: {
          content: [{ type: "text", text: "ranked" }],
          details: { provenance: "retained" },
        },
      };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "tool_result_transform", handler }]),
    );
    const wrapped = wrapToolWithBeforeToolCallHook(
      source,
      {
        agentId: "main",
        runId: "transform",
        sessionKey: "private",
        loopDetection: { enabled: false },
      },
      { emitDiagnostics: false },
    );
    expect((await wrapped.execute("call", {})).content).toEqual([{ type: "text", text: "ranked" }]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("rejects a transformed result after source authority is revoked while awaiting", async () => {
    let active = true;
    const source = bindAgentToolSourceExecutionGuard(makeTool(), () => {
      if (!active) throw new Error("revoked");
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_transform",
          handler: async () => {
            active = false;
            return { result: { content: [] } };
          },
        },
      ]),
    );
    const wrapped = wrapToolWithBeforeToolCallHook(
      source,
      { runId: "revoked", loopDetection: { enabled: false } },
      { emitDiagnostics: false },
    );
    await expect(wrapped.execute("call", {})).rejects.toThrow("revoked");
  });
});
