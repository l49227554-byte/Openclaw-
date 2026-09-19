// Exercises blank runtime recovery through the production embedded-runner loop.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFailureMessage } from "../../packages/agent-core/src/turn-interruption.js";
import { createApiRegistry } from "../../packages/ai/src/api-registry.js";
import { streamOpenAICompletions } from "../../packages/ai/src/providers/openai-completions.js";
import { createLlmRuntime } from "../../packages/ai/src/stream.js";
import type { Context, Model } from "../../packages/ai/src/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";
import type { EmbeddedRunAttemptResult } from "./embedded-agent-runner/run/types.js";
import { resetFallbackSkipCacheForTest } from "./fallback-skip-cache.test-support.js";
import {
  makeModelFallbackConfig,
  withModelFallbackWorkspace,
  writeFallbackAuthStore,
} from "./model-fallback.run-embedded.e2e.test-support.js";
import {
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
let fallbackTransportBaseUrl: string | undefined;
let fallbackTransportRequests: Array<{
  method?: string;
  url?: string;
  model?: string;
  authorization?: string;
}> = [];
const computeBackoffMock = vi.fn(
  (
    _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
    _attempt: number,
  ) => 0,
);
const sleepWithAbortMock = vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined);

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
}));

function installRunEmbeddedMocks() {
  vi.doMock("../plugins/runtime.js", () => ({
    getActivePluginRegistry: () => null,
    getActivePluginRegistryWorkspaceDir: () => undefined,
    requireActivePluginRegistry: () => ({}),
  }));
  vi.doMock("./harness/runtime-plugin.js", () => ({
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
  }));
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({
    runEmbeddedAttempt: (params) => runEmbeddedAttemptMock(params),
  });
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: (policy, attempt) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms, abortSignal) => sleepWithAbortMock(ms, abortSignal),
  });
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) => {
      const resolved = createResolvedEmbeddedRunnerModel(provider, modelId);
      if (provider === "groq" && fallbackTransportBaseUrl) {
        return {
          ...resolved,
          model: {
            ...resolved.model,
            api: "openai-completions",
            baseUrl: fallbackTransportBaseUrl,
          },
        };
      }
      return resolved;
    },
  }));
  vi.doMock("./session-suspension.js", async () => {
    const actual =
      await vi.importActual<typeof import("./session-suspension.js")>("./session-suspension.js");
    return { ...actual, suspendSession: vi.fn(async () => undefined) };
  });
}

type ProductionRunEmbeddedAgent = typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
type TestRunEmbeddedAgent = (
  params: Omit<Parameters<ProductionRunEmbeddedAgent>[0], "admittedRunContext">,
) => ReturnType<ProductionRunEmbeddedAgent>;
let runEmbeddedAgent: TestRunEmbeddedAgent;
let runWithModelFallback: typeof import("./model-fallback-runner.js").runWithModelFallback;

beforeAll(async () => {
  installRunEmbeddedMocks();
  const runEmbeddedAgentImpl = (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent;
  runEmbeddedAgent = wrapRunWithTestPreparedAdmission(runEmbeddedAgentImpl);
  ({ runWithModelFallback } = await import("./model-fallback-runner.js"));
});

beforeEach(() => {
  resetFallbackSkipCacheForTest();
  runEmbeddedAttemptMock.mockReset();
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

const UNREGISTERED_ANTHROPIC_MODEL = {
  id: "claude-opus-4-8",
  name: "Claude Opus 4.8",
  api: "anthropic",
  provider: "anthropic",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model;

function captureUnregisteredApiProviderError(): Error {
  try {
    createLlmRuntime(createApiRegistry()).stream(UNREGISTERED_ANTHROPIC_MODEL, {
      messages: [],
    } as Context);
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("expected createLlmRuntime to throw for an unregistered api");
}

function makeRuntimeBlankContentFailureAttempt(): EmbeddedRunAttemptResult {
  const assistant = createFailureMessage(
    UNREGISTERED_ANTHROPIC_MODEL,
    captureUnregisteredApiProviderError(),
    false,
  );
  return makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  });
}

async function makeFallbackTransportAttempt(params: {
  model: Model;
}): Promise<EmbeddedRunAttemptResult> {
  const model = params.model as Model<"openai-completions">;
  const stream = streamOpenAICompletions(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    { apiKey: "groq-test-key" },
  );
  const assistant = await stream.result();
  const assistantText = assistant.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  return makeEmbeddedRunnerAttempt({
    assistantTexts: assistantText ? [assistantText] : [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

async function withFallbackTransportServer<T>(fn: () => Promise<T>): Promise<T> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
      fallbackTransportRequests.push({
        method: request.method,
        url: request.url,
        model: body.model,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const common = {
        id: "blank-runtime-fallback-response",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
      };
      for (const row of [
        {
          ...common,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "fallback ok" },
              finish_reason: null,
            },
          ],
        },
        {
          ...common,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        },
      ]) {
        response.write(`data: ${JSON.stringify(row)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  fallbackTransportBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  fallbackTransportRequests = [];
  try {
    return await fn();
  } finally {
    fallbackTransportBaseUrl = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function runEmbeddedFallback(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  provider: string;
  config: OpenClawConfig;
}) {
  const sessionId = `session:${params.runId}`;
  return await runWithModelFallback({
    cfg: params.config,
    provider: params.provider,
    model: "mock-1",
    runId: params.runId,
    sessionId,
    agentDir: params.agentDir,
    run: (provider, model, options) =>
      runEmbeddedAgent({
        sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.config,
        prompt: "hello",
        provider,
        model,
        authProfileIdSource: "auto",
        allowTransientCooldownProbe: options?.allowTransientCooldownProbe,
        isFinalFallbackAttempt: options?.isFinalFallbackAttempt,
        timeoutMs: 5_000,
        runId: params.runId,
        enqueue: async (task) => await task(),
      }),
  });
}

describe("blank runtime errors through the production embedded runner", () => {
  it("spends bounded retries before executing a configured fallback", async () => {
    await withFallbackTransportServer(
      async () =>
        await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
          const config = makeModelFallbackConfig("anthropic");
          await writeFallbackAuthStore(agentDir, undefined, { primaryProvider: "anthropic" });
          runEmbeddedAttemptMock.mockImplementation(async (params: unknown) => {
            const attempt = params as { provider: string; modelId: string };
            if (attempt.provider === "anthropic") {
              return makeRuntimeBlankContentFailureAttempt();
            }
            if (attempt.provider === "groq") {
              return await makeFallbackTransportAttempt(params as { model: Model });
            }
            throw new Error(`Unexpected provider ${attempt.provider}`);
          });

          const result = await runEmbeddedFallback({
            agentDir,
            workspaceDir,
            provider: "anthropic",
            config,
            sessionKey: "agent:test:blank-runtime-error-fallback",
            runId: "run:blank-runtime-error-fallback",
          });

          expect(result.provider).toBe("groq");
          expect(result.model).toBe("mock-2");
          expect(result.result.payloads?.[0]?.text ?? "").toContain("fallback ok");
          expect(result.attempts).toMatchObject([
            { provider: "anthropic", model: "mock-1", reason: "unknown" },
          ]);
          expect(
            runEmbeddedAttemptMock.mock.calls.map(([params]) => {
              const attempt = params as { provider: string; modelId: string };
              return `${attempt.provider}/${attempt.modelId}`;
            }),
          ).toEqual([
            "anthropic/mock-1",
            "anthropic/mock-1",
            "anthropic/mock-1",
            "anthropic/mock-1",
            "groq/mock-2",
          ]);
          expect(fallbackTransportRequests).toEqual([
            {
              method: "POST",
              url: "/v1/chat/completions",
              model: "mock-2",
              authorization: "Bearer groq-test-key",
            },
          ]);
          console.log(
            `[blank-runtime fallback proof] ${JSON.stringify({
              primaryAttempts: 4,
              fallbackAttempts: 1,
              calls: runEmbeddedAttemptMock.mock.calls.map(([params]) => {
                const attempt = params as { provider: string; modelId: string };
                return `${attempt.provider}/${attempt.modelId}`;
              }),
              finalProvider: result.provider,
              finalModel: result.model,
              finalText: result.result.payloads?.[0]?.text ?? "",
              fallbackRequest: {
                method: fallbackTransportRequests[0]?.method,
                url: fallbackTransportRequests[0]?.url,
                model: fallbackTransportRequests[0]?.model,
                authorization: "<redacted>",
              },
            })}`,
          );
        }),
    );
  });
});
