import { describe, expect, it } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  resolveEmptyResponseRetryInstruction,
  resolveProgressOnlyContinuationInstruction,
  resolveReasoningOnlyRetryInstruction,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";
import { resolveIncompleteTurnPayloadText } from "./incomplete-turn-resolution.js";

const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

function emptyAssistant(overrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {}) {
  return buildEmbeddedRunnerAssistant({
    content: [{ type: "text", text: "" }],
    ...overrides,
  });
}

function emptyAttempt(assistant = emptyAssistant()) {
  return makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
}

describe("incomplete-turn recovery policy", () => {
  it.each(["required", "optional"] as const)(
    "keeps async-owned work out of completed silence (reply=%s)",
    (terminalReplyExpectation) => {
      const assistant = emptyAssistant({ content: [{ type: "text", text: "NO_REPLY" }] });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [{ toolName: "image_generate", asyncStarted: true, replaySafe: false }],
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      });
      const state = { payloadCount: 0, aborted: false, timedOut: false, attempt };
      // Silence must not steal completion ownership from background work. Nor
      // may it trigger a replay or a spurious warning while that owner continues.
      expect(
        shouldTreatEmptyAssistantReplyAsSilent({
          ...state,
          allowEmptyAssistantReplyAsSilent: true,
          onlyExplicitSilentReply: true,
          terminalReplyExpectation,
        }),
      ).toBe(false);
      expect(resolveEmptyResponseRetryInstruction(state)).toBeNull();
      expect(resolveIncompleteTurnPayloadText({ ...state, externalAbort: false })).toBeNull();
    },
  );

  it.each([
    {
      name: "a completed reaction",
      aborted: false,
      timedOut: false,
      yielded: false,
      error: false,
      silent: true,
    },
    {
      name: "a failed reaction",
      aborted: false,
      timedOut: false,
      yielded: false,
      error: true,
      silent: false,
    },
    {
      name: "an aborted turn",
      aborted: true,
      timedOut: false,
      yielded: false,
      error: false,
      silent: false,
    },
    {
      name: "a timed-out turn",
      aborted: false,
      timedOut: true,
      yielded: false,
      error: false,
      silent: false,
    },
    {
      name: "pending work",
      aborted: false,
      timedOut: false,
      yielded: true,
      error: false,
      silent: false,
    },
  ])(
    "classifies explicit silence after $name without replaying tools",
    ({ aborted, timedOut, yielded, error, silent }) => {
      const assistant = emptyAssistant({ content: [{ type: "text", text: "NO_REPLY" }] });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        toolMetas: [{ toolName: "message", meta: "react", replaySafe: false, isError: error }],
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        ...(yielded ? { yieldDetected: true } : {}),
        ...(error ? { lastToolError: { toolName: "message", error: "reaction failed" } } : {}),
      });
      // A user-triggered turn can intentionally end with only a reaction. Do not
      // conflate permission to stay silent with permission to replay that effect.
      expect(
        shouldTreatEmptyAssistantReplyAsSilent({
          allowEmptyAssistantReplyAsSilent: true,
          terminalReplyExpectation: "required",
          onlyExplicitSilentReply: true,
          payloadCount: 0,
          aborted,
          timedOut,
          attempt,
        }),
      ).toBe(silent);
      expect(
        resolveEmptyResponseRetryInstruction({
          payloadCount: 0,
          aborted,
          timedOut,
          attempt,
        }),
      ).toBeNull();
    },
  );

  it.each([
    {
      name: "zero-token Anthropic stop",
      provider: "anthropic",
      modelId: "claude-opus-4.7",
      modelApi: "messages",
      assistant: buildEmbeddedRunnerAssistant({
        provider: "anthropic",
        model: "claude-opus-4.7",
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    },
    {
      name: "Anthropic-compatible positive-output stop",
      provider: "sub2api",
      modelId: "claude-opus-4-7",
      modelApi: "anthropic-messages",
      assistant: emptyAssistant({
        api: "anthropic-messages",
        provider: "sub2api",
        model: "claude-opus-4-7",
        usage: {
          input: 2048,
          output: 3100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5148,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    },
    {
      name: "generic empty Gemini turn",
      provider: "google-vertex",
      modelId: "google/gemini-3.1-flash",
      modelApi: undefined,
      assistant: emptyAssistant({
        stopReason: "stop",
        provider: "google-vertex",
        model: "gemini-3.1-flash",
      }),
    },
  ])(
    "returns the visible-answer prompt for $name",
    ({ provider, modelId, modelApi, assistant }) => {
      expect(
        resolveEmptyResponseRetryInstruction({
          provider,
          modelId,
          modelApi,
          payloadCount: 0,
          aborted: false,
          timedOut: false,
          attempt: emptyAttempt(assistant),
        }),
      ).toBe(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    },
  );

  it("does not retry an empty turn after side effects", () => {
    const assistant = emptyAssistant({ stopReason: "stop", model: "gpt-5.4" });
    const attempt = emptyAttempt(assistant);
    attempt.replayMetadata = { hadPotentialSideEffects: true, replaySafe: false };

    expect(
      resolveEmptyResponseRetryInstruction({
        provider: "openai",
        modelId: "gpt-5.4",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBeNull();
  });

  it("returns the reasoning continuation for Kimi Anthropic reasoning-only output", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      api: "anthropic-messages",
      provider: "kimi",
      model: "kimi-for-coding",
      content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "" }],
    });

    expect(
      resolveReasoningOnlyRetryInstruction({
        provider: "kimi",
        modelId: "kimi-for-coding",
        modelApi: "anthropic-messages",
        aborted: false,
        timedOut: false,
        attempt: emptyAttempt(assistant),
      }),
    ).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
  });

  it("treats reply-optional post-tool empty stops as silent after side effects", () => {
    const assistant = emptyAssistant();
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      toolMetas: [{ toolName: "sessions", meta: "patch archived", replaySafe: false }],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
    });

    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(true);
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "required",
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "tool failure",
      attempt: makeEmbeddedRunnerAttempt({
        assistantTexts: [],
        toolMetas: [
          { toolName: "sessions", meta: "patch failed", replaySafe: false, isError: true },
        ],
        lastToolError: { toolName: "sessions", error: "patch failed" },
        lastAssistant: emptyAssistant(),
      }),
      aborted: false,
    },
    {
      name: "assistant error",
      attempt: emptyAttempt(emptyAssistant({ stopReason: "error" })),
      aborted: false,
    },
    {
      name: "caller abort",
      attempt: emptyAttempt(emptyAssistant({ stopReason: "error" })),
      aborted: true,
    },
  ])("does not treat $name as intentional silence", ({ attempt, aborted }) => {
    expect(
      shouldTreatEmptyAssistantReplyAsSilent({
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
        payloadCount: 0,
        aborted,
        timedOut: false,
        attempt,
      }),
    ).toBe(false);
  });
});

function progressAttempt(
  text: string,
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    content: [{ type: "text", text }],
    stopReason: "stop",
  });
  return makeEmbeddedRunnerAttempt({
    assistantTexts: [text],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    // Committed tool work from earlier iterations of the same run must not
    // block a text-only continuation of the current attempt.
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: true },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    ...overrides,
  });
}

const PROGRESS_RESOLVER_BASE = {
  provider: "nvcf2",
  modelId: "ds-flash-v4",
  modelApi: "openai-completions",
  aborted: false,
  timedOut: false,
};

describe("progress-only continuation policy", () => {
  it("continues a turn that promises future work and stops", () => {
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        attempt: progressAttempt(
          "Fair — the paths are templated, so let me pull the actual string values from the configs.",
        ),
      }),
    ).toBeTruthy();
  });

  it("continues despite committed side effects earlier in the run", () => {
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        attempt: progressAttempt(
          "The journal returned nothing. Let me find where the logs actually go.",
          {
            toolMetas: [{ toolName: "exec", replaySafe: false }],
          },
        ),
      }),
    ).toBeTruthy();
  });

  it("does not continue a complete short answer", () => {
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        attempt: progressAttempt("The base URL is /api/v1 and the paths are /a and /b."),
      }),
    ).toBeNull();
  });

  it("does not continue when the final message settled tool calls", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [
        { type: "text", text: "Ran the checks. Let me summarize." },
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
      ],
      stopReason: "toolUse",
    });
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        attempt: progressAttempt("Ran the checks. Let me summarize.", {
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
        }),
      }),
    ).toBeNull();
  });

  it("does not continue non-stop terminal reasons", () => {
    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: "Let me check the logs." }],
      stopReason: "error",
    });
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        attempt: progressAttempt("Let me check the logs.", {
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
        }),
      }),
    ).toBeNull();
  });

  it("does not continue when the current attempt is not replay-safe", () => {
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        attempt: progressAttempt("Let me check the logs.", {
          currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        }),
      }),
    ).toBeNull();
  });

  it("does not continue aborted turns", () => {
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        aborted: true,
        attempt: progressAttempt("Let me check the logs."),
      }),
    ).toBeNull();
  });

  it("does not continue long answers that merely mention future work", () => {
    const filler =
      "Here is the full configuration inventory with every resolved value in order.\n".repeat(12);
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        attempt: progressAttempt(`${filler}Let me know if you want more detail.`),
      }),
    ).toBeNull();
  });

  it("does not continue silent replies", () => {
    expect(
      resolveProgressOnlyContinuationInstruction({
        ...PROGRESS_RESOLVER_BASE,
        attempt: progressAttempt("NO_REPLY"),
      }),
    ).toBeNull();
  });
});
