// Exec auto-reviewer completion budget: the configured `maxTokens` replaces the
// 1,024-token default and stays clamped to the reviewer model's advertised cap.
import { describe, expect, it, vi } from "vitest";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";

const input = {
  command: "git status",
  argv: ["git", "status"],
  resolvedPath: "/usr/bin/git",
  cwd: "/repo",
  envKeys: [],
  host: "gateway" as const,
  reason: "approval-required" as const,
  analysis: {
    parsed: true,
    allowlistMatched: false,
    inlineEval: false,
  },
};

function createReviewer(params: {
  modelMaxTokens?: number;
  reviewer?: Parameters<typeof createModelExecAutoReviewer>[0]["reviewer"];
}) {
  const prepare = vi.fn(async () => ({
    selection: { provider: "openrouter", modelId: "reviewer", agentDir: "/agent" },
    model: {
      provider: "openrouter",
      id: "reviewer",
      api: "openai" as const,
      ...(params.modelMaxTokens === undefined ? {} : { maxTokens: params.modelMaxTokens }),
    },
    auth: { apiKey: "redacted", mode: "env" as const },
    [Symbol.asyncDispose]: async () => {},
  }));
  const complete = vi.fn(async () => ({
    stopReason: "stop" as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ decision: "allow", risk: "low", rationale: "reviewer fixture" }),
      },
    ],
  }));
  const reviewer = createModelExecAutoReviewer({
    cfg: {},
    ...(params.reviewer ? { reviewer: params.reviewer } : {}),
    deps: {
      acquireSimpleCompletionModelForAgent:
        prepare as unknown as typeof import("./simple-completion-runtime.js").acquireSimpleCompletionModelForAgent,
      completeWithPreparedSimpleCompletionModel:
        complete as unknown as typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel,
    },
  });
  return { reviewer, complete };
}

async function completionMaxTokens(params: Parameters<typeof createReviewer>[0]) {
  const { reviewer, complete } = createReviewer(params);
  await expect(reviewer(input)).resolves.toMatchObject({ decision: "allow-once" });
  const call = complete.mock.calls[0]?.[0] as { options?: { maxTokens?: number } } | undefined;
  return call?.options?.maxTokens;
}

describe("exec auto-reviewer configured maxTokens", () => {
  it.each([
    { reviewer: { maxTokens: 2_048 }, modelMaxTokens: 32_768, expected: 2_048 },
    { reviewer: { maxTokens: 2_048 }, modelMaxTokens: 1_500, expected: 1_500 },
    { reviewer: { maxTokens: 2_048 }, modelMaxTokens: undefined, expected: 2_048 },
    { reviewer: { maxTokens: 512 }, modelMaxTokens: 32_768, expected: 512 },
    { reviewer: { thinking: "low" as const }, modelMaxTokens: 32_768, expected: 1_024 },
    { reviewer: undefined, modelMaxTokens: 800, expected: 800 },
  ])(
    "sends $expected for reviewer $reviewer with model cap $modelMaxTokens",
    async ({ reviewer, modelMaxTokens, expected }) => {
      await expect(completionMaxTokens({ reviewer, modelMaxTokens })).resolves.toBe(expected);
    },
  );

  it("ignores non-positive or fractional configured budgets", async () => {
    for (const maxTokens of [0, -5, 1.5, Number.NaN]) {
      await expect(
        completionMaxTokens({ reviewer: { maxTokens }, modelMaxTokens: 32_768 }),
      ).resolves.toBe(1_024);
    }
  });
});
