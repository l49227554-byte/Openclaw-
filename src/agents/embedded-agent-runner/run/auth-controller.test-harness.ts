import type { Model } from "openclaw/plugin-sdk/llm";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { createEmbeddedRunAuthController, type EmbeddedRunAuthState } from "./auth-controller.js";
import type { RuntimeAuthState } from "./helpers.js";

export function createTestModel(): Model {
  return {
    id: "test-model",
    name: "test-model",
    provider: "custom-openai",
    api: "openai-responses",
    baseUrl: "https://old.example.com/v1",
    headers: {
      Authorization: "Bearer stale-token",
    },
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 4_000,
  } as Model;
}

export function getRuntimeAuthSnapshot(
  state: RuntimeAuthState | null,
): Pick<RuntimeAuthState, "profileId" | "refreshInFlight"> | null {
  return state ? { profileId: state.profileId, refreshInFlight: state.refreshInFlight } : null;
}

type RuntimeApiKeySetter = (provider: string, apiKey: string) => void;

export function createMutableAuthControllerHarness(): EmbeddedRunAuthState {
  return {
    models: { runtime: createTestModel(), effective: createTestModel() },
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    runtimeAuthRefreshCancelled: false,
    profileIndex: 0,
    thinkLevel: "medium",
  };
}

export function createMutableEmbeddedRunAuthController(params: {
  harness: EmbeddedRunAuthState;
  setRuntimeApiKey: RuntimeApiKeySetter;
  profileCandidates?: Array<string | undefined>;
  authStore?: AuthProfileStore;
  fallbackConfigured?: boolean;
  lockedProfileId?: string;
  allowTransientCooldownProbe?: boolean;
  warn?: (message: string) => void;
  agentDir?: string;
  prepareModelForAuthProfile?: Parameters<
    typeof createEmbeddedRunAuthController
  >[0]["prepareModelForAuthProfile"];
}) {
  return createEmbeddedRunAuthController({
    config: undefined,
    agentDir: params.agentDir ?? "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    authStore:
      params.authStore ??
      ({
        version: 1,
        profiles: {},
      } as AuthProfileStore),
    authStorage: { setRuntimeApiKey: params.setRuntimeApiKey },
    profileCandidates: params.profileCandidates ?? ["default"],
    lockedProfileId: params.lockedProfileId,
    initialThinkLevel: "medium",
    attemptedThinking: new Set(),
    fallbackConfigured: params.fallbackConfigured ?? false,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe ?? false,
    provider: "custom-openai",
    modelId: "test-model",
    state: params.harness,
    ...(params.prepareModelForAuthProfile
      ? { prepareModelForAuthProfile: params.prepareModelForAuthProfile }
      : {}),
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: params.warn ?? (() => undefined),
    },
  });
}
