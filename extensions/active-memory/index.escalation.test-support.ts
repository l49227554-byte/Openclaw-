import type { ActiveMemoryEscalationProvider } from "openclaw/plugin-sdk/active-memory-escalation-runtime";
import { expect, it, vi } from "vitest";

type ActiveMemoryEscalationIntegrationTestHarness = {
  currentActiveMemoryConfig: () => Record<string, unknown>;
  expectEmbeddedChannel: (messageChannel: string, messageProvider?: string) => void;
  expectPrependContextContains: (result: unknown, text: string) => void;
  hasDebugLine: (needle: string) => boolean;
  hasInfoLine: (needle: string) => boolean;
  registerPluginConfig: (overrides: Record<string, unknown>) => void;
  runEmbeddedAgent: unknown;
  runPromptBuild: (
    event: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  setEscalationProvider: (provider: ActiveMemoryEscalationProvider | undefined) => void;
  skippedRecallContext: string;
};

export function registerActiveMemoryEscalationIntegrationTests({
  currentActiveMemoryConfig,
  expectEmbeddedChannel,
  expectPrependContextContains,
  hasDebugLine,
  hasInfoLine,
  registerPluginConfig,
  runEmbeddedAgent,
  runPromptBuild,
  setEscalationProvider,
  skippedRecallContext,
}: ActiveMemoryEscalationIntegrationTestHarness): void {
  it.each(["你还记得我们上次讨论的数据库配置吗？", "你还记得我们上周决定明天部署的方案吗？"])(
    "escalates only retrospective Chinese %j when recall mode is unset",
    async (prompt) => {
      registerPluginConfig({ mode: undefined });
      expect(currentActiveMemoryConfig().mode).toBeUndefined();

      const context = {
        sessionKey: "agent:main:telegram:direct:owner",
        messageProvider: "telegram",
        channelId: "owner",
      };

      const ordinary = await runPromptBuild({ prompt: "部署之前先整理聊天记录" }, context);
      expectPrependContextContains(ordinary, skippedRecallContext);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();

      const future = await runPromptBuild({ prompt: "你记得明天发送报告吗？" }, context);
      expectPrependContextContains(future, skippedRecallContext);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();

      const recall = await runPromptBuild({ prompt }, context);
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expectPrependContextContains(recall, "lemon pepper wings");
      expectEmbeddedChannel("telegram");
    },
  );

  it("records why default escalation skips an ordinary turn", async () => {
    registerPluginConfig({ mode: undefined });

    const result = await runPromptBuild(
      { prompt: "Explain the current configuration" },
      {
        sessionKey: "agent:main:webchat:direct:operator",
        messageProvider: "webchat",
        channelId: "operator",
      },
    );

    expectPrependContextContains(result, skippedRecallContext);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(hasDebugLine("active-memory: recall skipped reason=no-recall-intent")).toBe(true);
    expect(hasInfoLine("active-memory: recall skipped reason=no-recall-intent")).toBe(false);
  });

  it("uses a configured escalation provider to recall an ordinary turn", async () => {
    const decide = vi.fn(async () => "recall" as const);
    setEscalationProvider({ id: "local-memory-intent", decide });
    registerPluginConfig({ mode: "escalate", escalationProvider: "local-memory-intent" });

    const result = await runPromptBuild(
      { prompt: "Continue with that" },
      {
        sessionKey: "agent:main:webchat:direct:operator",
        messageProvider: "webchat",
        channelId: "operator",
      },
    );

    expect(decide).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledWith({
      message: "Continue with that",
      searchQuery: "Continue with that",
      signal: expect.any(AbortSignal),
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expectPrependContextContains(result, "lemon pepper wings");
  });

  it("passes only bounded normalized text to an escalation provider", async () => {
    const decide = vi.fn<ActiveMemoryEscalationProvider["decide"]>(async () => "skip" as const);
    setEscalationProvider({ id: "local-memory-intent", decide });
    registerPluginConfig({ mode: "escalate", escalationProvider: "local-memory-intent" });

    await runPromptBuild(
      { prompt: `  ${"context ".repeat(100)}  ` },
      {
        sessionKey: "agent:main:webchat:direct:operator",
        messageProvider: "webchat",
        channelId: "operator",
      },
    );

    const input = decide.mock.calls[0]?.[0];
    expect(input?.message.length).toBeGreaterThan(0);
    expect(input?.message.length).toBeLessThanOrEqual(480);
    expect(input?.searchQuery.length).toBeGreaterThan(0);
    expect(input?.searchQuery.length).toBeLessThanOrEqual(480);
    expect(input?.message).not.toContain("  ");
    expect(input?.searchQuery).not.toContain("  ");
  });

  it("uses a configured escalation provider to skip a built-in recall match", async () => {
    const decide = vi.fn(async () => "skip" as const);
    setEscalationProvider({ id: "local-memory-intent", decide });
    registerPluginConfig({ mode: "escalate", escalationProvider: "local-memory-intent" });

    const result = await runPromptBuild(
      { prompt: "What did we decide last time?" },
      {
        sessionKey: "agent:main:webchat:direct:operator",
        messageProvider: "webchat",
        channelId: "operator",
      },
    );

    expect(decide).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expectPrependContextContains(result, skippedRecallContext);
    expect(hasDebugLine("active-memory: recall skipped reason=provider-skip")).toBe(true);
  });

  it("keeps configured escalation provider ids on one log line", async () => {
    registerPluginConfig({
      mode: "escalate",
      escalationProvider: "missing-provider\nforged",
    });

    await runPromptBuild({ prompt: "Explain the current configuration" });

    expect(
      hasDebugLine(
        "active-memory: escalation provider unavailable id=missing-provider forged; using built-in matcher",
      ),
    ).toBe(true);
  });
}
