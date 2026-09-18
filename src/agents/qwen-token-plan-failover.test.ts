import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../plugin-sdk/plugin-test-runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
} from "./auth-profiles/usage.js";
import { resolveAuthProfileFailureReason } from "./embedded-agent-runner/run/auth-profile-failure-policy.js";
import { resolveRunFailoverDecision } from "./embedded-agent-runner/run/failover-policy.js";
import { classifyFailoverSignal } from "./failover/classify.js";
import { assertInlineProviderApiKeyUsable } from "./model-auth-provider-config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let providers: ProviderPlugin[];
beforeAll(async () => {
  const { default: plugin } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerProviderPlugin>[0]["plugin"];
  }>({ pluginId: "qwen", artifactBasename: "index.js" });
  ({ providers } = await registerProviderPlugin({ plugin, id: "qwen", name: "Qwen Provider" }));
});
afterEach(() => closeOpenClawAgentDatabasesForTest());

describe.each(["qwen-token-plan", "bailian-token-plan"])("%s entitlement failures", (provider) => {
  // Alibaba documents this code for a team-only model requested on a personal plan:
  // https://help.aliyun.com/zh/model-studio/token-plan-personal-faq
  it("keeps sibling models usable after a model entitlement rejection", async () => {
    const owner = requireRegisteredProvider(providers, provider);
    const classification = classifyFailoverSignal(
      {
        provider,
        status: 403,
        code: "AccessDenied.Unpurchased",
        message: "Access to model denied.",
      },
      { providerPlugin: owner },
    );
    const agentDir = tempDirs.make("openclaw-qwen-entitlement-");
    const profileId = `${provider}:fixture`;
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: { type: "api_key", provider, key: "test-api-key" },
      },
    };
    saveAuthProfileStore(store, agentDir, { syncExternalCli: false });
    if (classification?.kind !== "reason") {
      throw new Error("Expected a failover reason");
    }
    const reason = resolveAuthProfileFailureReason({ failoverReason: classification.reason });
    if (!reason) {
      throw new Error("Expected an auth-profile failure reason");
    }
    const failure = { store, reason, modelId: "team-only-model", agentDir };
    await markInlineProviderApiKeyFailure({ ...failure, provider });
    await markAuthProfileFailure({ ...failure, profileId });
    expect(() => assertInlineProviderApiKeyUsable({ store, provider })).not.toThrow();
    expect(isProfileInCooldown(store, profileId, undefined, "sibling-model")).toBe(false);
    expect(isProfileInCooldown(store, profileId, undefined, "team-only-model")).toBe(true);
    expect(classification.reason).toBe("model_not_found");
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: true,
        failoverReason: classification.reason,
      }),
    ).toEqual({ action: "fallback_model", reason: "model_not_found" });

    await markInlineProviderApiKeyFailure({ ...failure, provider, reason: "auth" });
    expect(() => assertInlineProviderApiKeyUsable({ store, provider })).toThrow(
      /temporarily disabled/,
    );
  });

  it.each([
    { status: 401, code: "AccessDenied.Unpurchased" },
    { status: 403, code: "InvalidApiKey" },
    { status: 403, code: "AccessDenied" },
    { status: 403, code: "AccessDenied.Unpurchased.Other" },
    { status: 403, code: undefined },
  ])("preserves credential rejection for $status/$code", ({ status, code }) => {
    const classification = classifyFailoverSignal(
      { provider, status, code, message: "Access to model denied." },
      { providerPlugin: requireRegisteredProvider(providers, provider) },
    );
    expect(classification).toEqual({ kind: "reason", reason: "auth" });
  });
});

it("does not apply Token Plan entitlement semantics to the standard Qwen provider", () => {
  expect(
    classifyFailoverSignal(
      {
        provider: "qwen",
        status: 403,
        code: "AccessDenied.Unpurchased",
        message: "Access to model denied.",
      },
      { providerPlugin: requireRegisteredProvider(providers, "qwen") },
    ),
  ).toEqual({ kind: "reason", reason: "auth" });
});
