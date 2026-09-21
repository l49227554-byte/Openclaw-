import { describe, expect, it } from "vitest";
import type { Context, Model, StreamFn } from "../../llm/types.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

describe("utility completion extra params", () => {
  it("applies model payload params when the simple-completion provider wrapper is already applied", () => {
    const payload: Record<string, unknown> = { messages: [] };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, _model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const model = {
      api: "openai-completions",
      provider: "vllm",
      id: "utility-model",
      baseUrl: "http://127.0.0.1:8000/v1",
    } as Model<"openai-completions">;

    applyExtraParamsToAgent(
      agent,
      {
        agents: {
          defaults: {
            models: {
              "vllm/utility-model": {
                params: { chat_template_kwargs: { enable_thinking: false } },
              },
            },
          },
        },
      },
      "vllm",
      "utility-model",
      undefined,
      undefined,
      undefined,
      undefined,
      model,
      undefined,
      undefined,
      { skipProviderWrapper: true },
    );

    void agent.streamFn?.(model, { messages: [] } satisfies Context, {});
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
