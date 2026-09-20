import { describe, expect, it, vi } from "vitest";
import pluginEntry from "./index.js";

describe("tool-prefilter plugin", () => {
  it("registers before_prompt_build hook", () => {
    const registeredHooks: Record<string, Function> = {};
    const mockApi = {
      pluginConfig: { enabled: true },
      runtime: {
        decisions: {
          evaluate: vi.fn(),
        },
      },
      on: vi.fn((name: string, handler: Function) => {
        registeredHooks[name] = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    expect(mockApi.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    expect(registeredHooks.before_prompt_build).toBeDefined();
  });

  it("prunes all tools (returns toolsAllow: []) when pure conversation is detected", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn().mockResolvedValue({
      status: "ok",
      answers: {
        any_tool_needed: {
          probabilityTrue: 0.08, // Very low probability -> pure conversation
        },
      },
    });

    const mockApi = {
      pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    const event = { currentUserMessage: "Hello, how are you today?" };
    const ctx = { agentId: "agent-1" };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ toolsAllow: [] });
    expect(mockApi.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Pure conversation detected"),
    );
  });

  it("leaves tools unconstrained when tools are needed", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn().mockResolvedValue({
      status: "ok",
      answers: {
        any_tool_needed: {
          probabilityTrue: 0.95, // High probability -> tools needed!
        },
      },
    });

    const mockApi = {
      pluginConfig: { enabled: true, thresholdAnyTool: 0.35 },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    const event = { currentUserMessage: "Check git status and commit changes" };
    const ctx = { agentId: "agent-1" };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined(); // Does not restrict tools
  });

  it("fails open gracefully on decision provider error without throwing", async () => {
    let hookHandler: Function = () => {};
    const mockEvaluate = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));

    const mockApi = {
      pluginConfig: { enabled: true },
      runtime: {
        decisions: {
          evaluate: mockEvaluate,
        },
      },
      on: vi.fn((_name: string, handler: Function) => {
        hookHandler = handler;
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    pluginEntry.register(mockApi as any);

    const event = { currentUserMessage: "Read the file foo.txt" };
    const ctx = { agentId: "agent-1" };

    const result = await hookHandler(event, ctx);

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined(); // Fails open
    expect(mockApi.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Decision check failed, failing open"),
    );
  });
});
