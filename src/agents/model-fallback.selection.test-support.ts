import { expect, it, vi } from "vitest";
import { FailoverError } from "./failover-error.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import type { runWithModelFallback as runFallback } from "./model-fallback-runner.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

export function defineModelSelectionProvenanceTests(runWithModelFallback: typeof runFallback) {
  it("jumps directly to a later live-session model switch candidate (#57471)", async () => {
    const cfg = createModelFallbackConfig("openai/gpt-4.1-mini", [
      "anthropic/claude-haiku-3-5",
      "anthropic/claude-sonnet-4-6",
      "openrouter/deepseek-chat",
    ]);
    const switchError = new LiveSessionModelSwitchError({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    const run = vi.fn(async (provider: string, model: string) => {
      if (provider === "openai" && model === "gpt-4.1-mini") {
        throw switchError;
      }
      if (provider === "anthropic" && model === "claude-sonnet-4-6") {
        return "ok";
      }
      throw new Error(`unexpected fallback candidate: ${provider}/${model}`);
    });
    const onError = vi.fn();

    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run,
      onError,
    });

    expect(result.result).toBe("ok");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.attempts).toStrictEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(run.mock.calls).toMatchObject([
      [
        "openai",
        "gpt-4.1-mini",
        { isFinalFallbackAttempt: false, modelRoutingProvenance: { selectionChanged: false } },
      ],
      [
        "anthropic",
        "claude-sonnet-4-6",
        { isFinalFallbackAttempt: false, modelRoutingProvenance: { selectionChanged: true } },
      ],
    ]);
  });

  it("keeps explicit selection provenance invalidated through later automatic candidates", async () => {
    const cfg = createModelFallbackConfig("openai/gpt-4.1-mini", [
      "anthropic/claude-haiku-3-5",
      "deepseek/deepseek-chat",
    ]);
    const observed: Array<boolean | undefined> = [];
    const result = await runWithModelFallback({
      cfg,
      provider: "openai",
      model: "gpt-4.1-mini",
      run: async (provider, model, options) => {
        observed.push(options?.modelRoutingProvenance.selectionChanged);
        if (provider === "openai") {
          throw new LiveSessionModelSwitchError({
            provider: "anthropic",
            model: "claude-haiku-3-5",
          });
        }
        if (provider === "anthropic") {
          throw new FailoverError("synthetic selected candidate failed", {
            provider,
            model,
            reason: "model_not_found",
          });
        }
        return "ok";
      },
    });
    expect(result.provider).toBe("deepseek");
    expect(observed).toEqual([false, true, true]);
  });
}
