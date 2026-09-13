import { describe, expect, it } from "vitest";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { classifyAssistantFailoverReason } from "./assistant-message-failures.js";

describe("classifyAssistantFailoverReason", () => {
  const opencodeGoStalledStreamError = {
    role: "assistant" as const,
    api: "openai-completions" as const,
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    usage: createZeroUsageFixture(),
    stopReason: "error" as const,
    errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
    content: [],
    timestamp: 0,
  };

  it("classifies opencode-go provider-owned stalled streams as timeout", () => {
    expect(classifyAssistantFailoverReason(opencodeGoStalledStreamError)).toBe("timeout");
  });

  it.each([
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_DNS_RESOLVE_FAILED",
    "UND_ERR_CONNECT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ])("classifies structured %s assistant errors as timeouts", (errorCode) => {
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        provider: "demo-provider",
        errorCode,
        errorMessage: "provider connection closed",
      }),
    ).toBe("timeout");
  });

  it("does not classify caller-aborted assistant messages as provider failover", () => {
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        stopReason: "aborted",
      }),
    ).toBeNull();
  });

  it("classifies only abnormal WebSocket closure as a transient timeout", () => {
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        api: "openai-chatgpt-responses",
        provider: "openai",
        errorMessage: "WebSocket closed 1006",
      }),
    ).toBe("timeout");

    for (const errorMessage of [
      "WebSocket closed 1000 normal closure",
      "WebSocket closed 1009 message too big",
    ]) {
      expect(
        classifyAssistantFailoverReason({
          ...opencodeGoStalledStreamError,
          api: "openai-chatgpt-responses",
          provider: "openai",
          errorMessage,
        }),
      ).not.toBe("timeout");
    }
  });

  it("keeps abort, auth, context overflow, and schema errors in distinct lanes", () => {
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        stopReason: "aborted",
        errorMessage: "WebSocket closed 1006",
      }),
    ).toBeNull();
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        errorMessage: "WebSocket closed 1006 invalid token",
      }),
    ).toBe("auth");
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        errorMessage:
          "WebSocket closed 1006: The input (263000 tokens) is longer than the model's context length (262144 tokens).",
      }),
    ).toBe("context_overflow");
    expect(
      classifyAssistantFailoverReason({
        ...opencodeGoStalledStreamError,
        errorMessage: "WebSocket closed 1006 invalid request format",
      }),
    ).toBe("format");
  });

  it("uses structured assistant error bodies for model-not-found 400s", () => {
    expect(
      classifyAssistantFailoverReason({
        role: "assistant",
        api: "openai-completions",
        provider: "openai",
        model: "some-model-id",
        usage: createZeroUsageFixture(),
        stopReason: "error",
        errorMessage: "400 Param Incorrect",
        errorCode: "400",
        errorBody:
          '{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}',
        content: [],
        timestamp: 0,
      }),
    ).toBe("model_not_found");
  });
});
