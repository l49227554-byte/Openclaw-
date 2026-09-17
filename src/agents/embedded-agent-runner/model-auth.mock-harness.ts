import { vi } from "vitest";

/** Inert auth transforms and a complete empty plugin scope for runner harnesses. */
export function createModelAuthFixtureDefaults() {
  return {
    applyAuthHeaderOverride: vi.fn((model: unknown) => model),
    applyLocalNoAuthHeaderOverride: vi.fn((model: unknown) => model),
    createRuntimeProviderAuthLookup: vi.fn(() => ({
      envApiKey: { skipSetupProviderFallback: true },
      syntheticAuthProviderRefs: [],
      syntheticAuthProviderRefsComplete: true,
    })),
  };
}
