import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AuthProfileCredential } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  findNormalizedProviderValue,
  isPendingOAuthRefreshForCredential,
  resolveOpenAICodexAuthIdentity,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/provider-auth-aliases";
import { resolveCodexAppServerPreparedAuthProfileSnapshot } from "./app-server/auth-bridge.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
} from "./app-server/auth-profile.js";
import { resolveCodexAppServerHomeDir } from "./app-server/auth-start-options.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import type { CodexAppServerClientOptions } from "./app-server/shared-client.js";
import { canonicalCodexCatalogHome, codexCatalogHomeId } from "./session-catalog-home-id.js";

/** Source credentials own the physical client; they never replace catalog route authority. */
export async function prepareCodexCatalogClientOptions(params: {
  agentDir: string | undefined;
  sourceAgentDir?: string;
  sourceHomeId?: string;
  assertSourceCurrent?: () => void;
  config: OpenClawConfig | undefined;
  startOptions: CodexAppServerStartOptions;
}): Promise<CodexAppServerClientOptions> {
  const { sourceAgentDir, sourceHomeId, assertSourceCurrent, ...options } = params;
  assertSourceCurrent?.();
  if (!sourceAgentDir) {
    return { ...options, authProfileId: null };
  }
  const home = canonicalCodexCatalogHome(resolveCodexAppServerHomeDir(sourceAgentDir));
  const assertHomeCurrent = () => {
    assertSourceCurrent?.();
    if (
      options.startOptions.transport !== "stdio" ||
      !fs.statSync(home).isDirectory() ||
      codexCatalogHomeId(resolveCodexAppServerHomeDir(sourceAgentDir)) !== sourceHomeId ||
      canonicalCodexCatalogHome(options.startOptions.env?.CODEX_HOME ?? home) !== home
    ) {
      throw new Error(
        "Codex catalog source ownership changed; refresh the catalog before retrying.",
      );
    }
  };
  assertHomeCurrent();
  const store = resolveCodexAppServerAuthProfileStore({
    agentDir: sourceAgentDir,
    config: options.config,
  });
  const profileId = resolveCodexAppServerAuthProfileId({ store, config: options.config });
  const credentialFingerprint = (value: unknown) =>
    createHash("sha256")
      .update(JSON.stringify(value) ?? "")
      .digest("hex");
  const selectedCredential = profileId ? store.profiles[profileId] : undefined;
  const preparedCredential = credentialFingerprint(selectedCredential);
  // OAuth token material rotates under the existing auth owner. Runtime refresh authority
  // binds its source and principal, not the access token captured by one catalog request.
  const sourceCredentialFingerprint = (credential: AuthProfileCredential | undefined) => {
    if (credential?.type !== "oauth") {
      return credentialFingerprint(credential);
    }
    const identity = resolveOpenAICodexAuthIdentity(credential);
    const tokenIdentity = resolveOpenAICodexAuthIdentity({ access: credential.access });
    return credentialFingerprint({
      type: credential.type,
      provider: credential.provider,
      accountId: identity.accountId,
      tokenAccountId: tokenIdentity.accountId ?? identity.accountId,
      principal: identity.profileName,
      clientId: credential.clientId,
      oauthRef: credential.oauthRef,
    });
  };
  const preparedSource = sourceCredentialFingerprint(selectedCredential);
  let sourceGeneration = selectedCredential;
  const readCurrentCredential = (allowPendingRefresh = false) => {
    assertHomeCurrent();
    const currentStore = resolveCodexAppServerAuthProfileStore({
      agentDir: sourceAgentDir,
      config: options.config,
    });
    let currentCredential = profileId ? currentStore.profiles[profileId] : undefined;
    // The auth owner temporarily replaces a claimed generation with an inert fence.
    // Check selection using its exact previously authorized credential, never the marker.
    if (
      allowPendingRefresh &&
      profileId &&
      sourceGeneration?.type === "oauth" &&
      currentCredential?.type === "oauth" &&
      isPendingOAuthRefreshForCredential({
        profileId,
        credential: sourceGeneration,
        fence: currentCredential,
      })
    ) {
      currentCredential = sourceGeneration;
    }
    const selectionStore = {
      ...currentStore,
      profiles: {
        ...currentStore.profiles,
        ...(profileId && currentCredential ? { [profileId]: currentCredential } : {}),
      },
    };
    if (
      resolveCodexAppServerAuthProfileId({ store: selectionStore, config: options.config }) !==
        profileId ||
      sourceCredentialFingerprint(currentCredential) !== preparedSource
    ) {
      throw new Error(
        "Codex catalog source authentication changed; refresh the catalog before retrying.",
      );
    }
    sourceGeneration = currentCredential;
    return currentCredential;
  };
  const assertAuthSourceCurrent = () => {
    readCurrentCredential(true);
  };
  const assertCurrent = () => {
    if (credentialFingerprint(readCurrentCredential()) !== preparedCredential) {
      throw new Error(
        "Codex catalog source authentication changed; refresh the catalog before retrying.",
      );
    }
  };
  if (!profileId) {
    const isOpenAi = (provider: string) =>
      resolveProviderIdForAuth(provider, { config: options.config, storedCredential: true }) ===
      "openai";
    const explicitOrder =
      findNormalizedProviderValue(store.order, "openai") ??
      findNormalizedProviderValue(options.config?.auth?.order, "openai");
    if (
      explicitOrder !== undefined ||
      Object.values(options.config?.auth?.profiles ?? {}).some((profile) =>
        isOpenAi(profile.provider),
      ) ||
      Object.values(store.profiles).some((profile) => isOpenAi(profile.provider))
    ) {
      throw new Error("Codex catalog source has no usable managed OpenAI authentication.");
    }
    // Discovery does not opt a native-only store into managed authentication.
    return { ...options, authProfileId: null, assertCurrent, assertAuthSourceCurrent };
  }
  const snapshot = await resolveCodexAppServerPreparedAuthProfileSnapshot({
    agentDir: sourceAgentDir,
    authProfileId: profileId,
    authProfileStore: store,
    config: options.config,
    assertCurrent: assertAuthSourceCurrent,
  });
  if (!snapshot) {
    throw new Error("Codex catalog source has no usable managed OpenAI authentication.");
  }
  assertCurrent();
  return {
    ...options,
    assertCurrent,
    assertAuthSourceCurrent,
    agentDir: sourceAgentDir,
    startOptions: {
      ...options.startOptions,
      homeScope: "agent",
      env: { ...options.startOptions.env, CODEX_HOME: home },
    },
    preparedAuth:
      snapshot.loginParams.type === "apiKey"
        ? { kind: "api-key", apiKey: snapshot.loginParams.apiKey }
        : { kind: "profile", profileId, store, snapshot },
  };
}
