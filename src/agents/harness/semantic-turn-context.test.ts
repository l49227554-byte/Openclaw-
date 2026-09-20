import { describe, expect, it, vi } from "vitest";
import type { AssembleResult, ContextEngine } from "../../context-engine/types.js";
import type { DecisionRuntimeV1 } from "../../decisions/types.js";
import { installDecisionFixture } from "../agent-hooks/compaction-safeguard-semantic.test-support.js";
import type { AgentMessage } from "../runtime/index.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { assembleHarnessContextEngine } from "./context-engine-lifecycle.js";
import { observeSemanticTurnContext } from "./semantic-turn-context.js";

function fixture(): AssembleResult {
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: "Only modify staging. Keep the unresolved deployment pending.",
      timestamp: 1,
    },
    castAgentMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
      timestamp: 2,
    }),
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Old completed health check. ".repeat(30) }],
      isError: false,
      timestamp: 3,
    },
    castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "I still owe you the deployment." }],
      timestamp: 4,
    }),
    { role: "user", content: "Continue the staging work.", timestamp: 5 },
  ];
  return { messages, estimatedTokens: 300 };
}
function options() {
  return {
    config: { mode: "shadow" as const, minEstimatedTokens: 1, recentMessages: 2 },
    signal: new AbortController().signal,
    assertActive: vi.fn(),
  };
}
const unavailable: DecisionRuntimeV1 = {
  evaluate: vi.fn(async () => ({
    status: "unavailable" as const,
    reason: "not-configured" as const,
  })),
};

describe("semantic turn context", () => {
  it("uses the registered context-engine assembly and Decision provider without changing messages", async () => {
    const { requests } = installDecisionFixture();
    const source = fixture();
    const before = JSON.stringify(source.messages);
    const engine: ContextEngine = {
      info: { id: "legacy", name: "fixture" },
      ingest: async () => ({ ingested: false }),
      assemble: async () => source,
      compact: async () => ({ ok: true, compacted: false }),
    };
    const result = await assembleHarnessContextEngine({
      contextEngine: engine,
      messages: source.messages,
      sessionId: "synthetic",
      modelId: "synthetic-model",
      agentId: "specialist",
      semanticCuration: options(),
    });
    expect(requests).toEqual([{ agentId: "specialist", model: "owner-v1" }]);
    expect(result?.messages).toBe(source.messages);
    expect(JSON.stringify(source.messages)).toBe(before);
    expect(result?.semanticCurationObservation).toMatchObject({
      mode: "shadow",
      reason: "shadow",
      evaluatedSegments: 1,
      protectedSegments: 3,
    });
    expect(result?.semanticCurationObservation?.reductionRatio).toBeGreaterThan(0);
  });
  it("makes no Decision call when off or below threshold", async () => {
    const { requests } = installDecisionFixture();
    const source = fixture();
    expect(
      await observeSemanticTurnContext(source, { ...options(), config: { mode: "off" } }),
    ).toBe(source);
    const result = await observeSemanticTurnContext(source, {
      ...options(),
      config: { mode: "shadow", minEstimatedTokens: 16000 },
    });
    expect(result.semanticCurationObservation?.reason).toBe("below-size-threshold");
    expect(requests).toHaveLength(0);
  });
  it("preserves append-only and persistent-thread hosts without inference", async () => {
    const { requests } = installDecisionFixture();
    for (const result of [
      await observeSemanticTurnContext(fixture(), { ...options(), appendOnly: true }),
      await observeSemanticTurnContext(
        { ...fixture(), contextProjection: { mode: "thread_bootstrap", epoch: "one" } },
        options(),
      ),
    ]) {
      expect(result.semanticCurationObservation?.reason).toBe("persistent-or-append-only-context");
    }
    expect(requests).toHaveLength(0);
  });
  it("protects active errors with their tool-call frame", async () => {
    const { requests } = installDecisionFixture();
    const source = fixture();
    const tool = source.messages[2];
    if (tool?.role === "toolResult") {
      tool.isError = true;
    }
    const result = await observeSemanticTurnContext(source, options());
    expect(result.messages).toBe(source.messages);
    expect(requests).toHaveLength(0);
    expect(result.semanticCurationObservation?.reason).toBe("no-discretionary-segments");
  });
  it("retains original context on unexpected provider failures", async () => {
    const source = fixture();
    const result = await observeSemanticTurnContext(source, options(), {
      evaluate: async () => {
        throw new Error("provider transport failed");
      },
    });
    expect(result.messages).toBe(source.messages);
    expect(result.semanticCurationObservation?.reason).toBe("decision-error");
  });
  it("does not observe a host without a captured lifecycle binding", async () => {
    const { requests } = installDecisionFixture();
    const source = fixture();
    const result = await assembleHarnessContextEngine({
      contextEngine: {
        info: { id: "legacy", name: "unbound fixture" },
        ingest: async () => ({ ingested: false }),
        assemble: async () => source,
        compact: async () => ({ ok: true, compacted: false }),
      },
      messages: source.messages,
      sessionId: "unbound",
      modelId: "synthetic-unbound",
    });
    expect(result).toBe(source);
    expect(requests).toHaveLength(0);
  });
  it("records unavailable without fabricating token usage", async () => {
    const source = fixture();
    const result = await observeSemanticTurnContext(source, options(), unavailable);
    expect(result.messages).toBe(source.messages);
    expect(result.semanticCurationObservation?.reason).toBe("not-configured");
    expect(result.semanticCurationObservation?.decisionInputTokens).toBeUndefined();
  });
  it("rejects stale source observations", async () => {
    const source = fixture();
    installDecisionFixture("preserved", () => {
      source.messages.push({ role: "user", content: "New required constraint", timestamp: 6 });
    });
    const result = await observeSemanticTurnContext(source, options());
    expect(result.semanticCurationObservation?.reason).toBe("stale-source");
  });
  it.each(["branchSummary", "compactionSummary"])(
    "rejects a summary-only mutation during selection (%s)",
    async (role) => {
      const source = fixture();
      const summary = { role, summary: "Keep staging isolated", timestamp: 0 };
      source.messages.unshift(castAgentMessage(summary));
      installDecisionFixture("preserved", () => {
        summary.summary = "New unresolved requirement: do not deploy";
      });
      const result = await observeSemanticTurnContext(source, options());
      expect(result.messages).toBe(source.messages);
      expect(result.semanticCurationObservation?.reason).toBe("stale-source");
    },
  );
  it("caller cancellation and replaced authority win after evaluation", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    installDecisionFixture("preserved", () => {
      controller.abort(reason);
    });
    await expect(
      observeSemanticTurnContext(fixture(), { ...options(), signal: controller.signal }),
    ).rejects.toBe(reason);
  });
  it("revalidates owner authority after awaited Decision work", async () => {
    installDecisionFixture();
    const opts = options();
    const error = new Error("closed admission");
    opts.assertActive
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw error;
      });
    await expect(observeSemanticTurnContext(fixture(), opts)).rejects.toBe(error);
  });
});
