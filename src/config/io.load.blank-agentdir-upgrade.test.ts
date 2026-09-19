import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectiveAgentDir } from "../agents/agent-scope-config.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIoContext } from "./io.context.js";
import { loadConfigFromContextAsync } from "./io.load.js";

function createContext(root: string) {
  const configPath = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    VITEST: "true",
  };
  return createConfigIoContext({
    configPath,
    env,
    homedir: () => root,
    observe: false,
  });
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

describe("saved blank agent agentDir config loads across upgrade", () => {
  it("loads a saved config with a blank per-agent agentDir (migration removes it, resolver falls back)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151013-load-"));
    const context = createContext(root);
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        agents: {
          entries: { alpha: { agentDir: " " } },
        },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const config = await loadConfigFromContextAsync(context);
    expect(config.agents?.entries?.alpha).toBeDefined();
    // The blank per-agent agentDir was migrated away: the resolver now uses the
    // default per-agent directory, matching pre-upgrade behavior.
    expect(config.agents?.entries?.alpha?.agentDir).toBeUndefined();
    expect(resolveEffectiveAgentDir(config, "alpha", { env: { HOME: root } })).toBe(
      path.join(root, ".openclaw", "agents", "alpha", "agent"),
    );
  });

  it("loads a legacy multi-agent config (default marker + blank agentDir) preserving the retained owner", async () => {
    // Regression for the structuredClone WeakMap drop: a saved legacy config
    // with a `default: true` marker and a blank agentDir on a non-default agent
    // must still load. The roster migration records the retained default owner
    // on the config root; the blank-agentDir migration must preserve that
    // association across the clone.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151013-load-"));
    const context = createContext(root);
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "alpha", default: true },
            { id: "beta", agentDir: " " },
          ],
        },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const config = await loadConfigFromContextAsync(context);
    expect(config.agents?.entries?.alpha).toBeDefined();
    expect(config.agents?.entries?.beta).toBeDefined();
    // The blank agentDir was migrated away on the non-default agent.
    expect(config.agents?.entries?.beta?.agentDir).toBeUndefined();
  });
});
