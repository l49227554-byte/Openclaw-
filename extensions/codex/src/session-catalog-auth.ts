import { createHash } from "node:crypto";
import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
  config: OpenClawConfig | undefined;
  startOptions: CodexAppServerStartOptions;
}): Promise<CodexAppServerClientOptions> {
  const { sourceAgentDir, sourceHomeId, ...options } = params;
  if (!sourceAgentDir) {
    return { ...options, authProfileId: null };
  }
  const home = canonicalCodexCatalogHome(resolveCodexAppServerHomeDir(sourceAgentDir));
  const assertHomeCurrent = () => {
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
  const preparedCredential = credentialFingerprint(
    profileId ? store.profiles[profileId] : undefined,
  );
  const assertCurrent = () => {
    assertHomeCurrent();
    const currentStore = resolveCodexAppServerAuthProfileStore({
      agentDir: sourceAgentDir,
      config: options.config,
    });
    if (
      resolveCodexAppServerAuthProfileId({ store: currentStore, config: options.config }) !==
        profileId ||
      credentialFingerprint(profileId ? currentStore.profiles[profileId] : undefined) !==
        preparedCredential
    ) {
      throw new Error(
        "Codex catalog source authentication changed; refresh the catalog before retrying.",
      );
    }
  };
  if (!profileId) {
    // Discovery does not opt a native-only store into managed authentication.
    return { ...options, authProfileId: null, assertCurrent };
  }
  const snapshot = await resolveCodexAppServerPreparedAuthProfileSnapshot({
    agentDir: sourceAgentDir,
    authProfileId: profileId,
    authProfileStore: store,
    config: options.config,
  });
  if (!snapshot) {
    throw new Error("Codex catalog source has no usable managed OpenAI authentication.");
  }
  assertCurrent();
  return {
    ...options,
    assertCurrent,
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
