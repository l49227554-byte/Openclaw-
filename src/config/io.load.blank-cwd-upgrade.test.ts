import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentRunCwd } from "../agents/agent-scope-config.js";
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

describe("saved blank agent cwd config loads across upgrade", () => {
  it("loads a saved config with a blank per-agent cwd (migration removes it, resolver falls back)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151091-load-"));
    const context = createContext(root);
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        agents: {
          defaults: { cwd: "/tmp/default" },
          entries: { alpha: { cwd: " " } },
        },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const config = await loadConfigFromContextAsync(context);
    expect(config.agents?.entries?.alpha).toBeDefined();
    // The blank per-agent cwd was migrated away: the resolver now inherits the
    // default cwd, matching pre-upgrade behavior.
    expect(config.agents?.entries?.alpha?.cwd).toBeUndefined();
    expect(resolveAgentRunCwd(config, "alpha")).toBe("/tmp/default");
  });

  it("loads a saved config with a blank defaults cwd (migration removes it, resolver returns undefined default)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151091-load-"));
    const context = createContext(root);
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        agents: {
          defaults: { cwd: "   " },
          entries: { alpha: {} },
        },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const config = await loadConfigFromContextAsync(context);
    expect(config.agents?.defaults?.cwd).toBeUndefined();
    expect(resolveAgentRunCwd(config, "alpha")).toBeUndefined();
  });

  it("loads a legacy multi-agent config (default marker + blank cwd) preserving the retained owner", async () => {
    // Regression for the structuredClone WeakMap drop: a saved legacy config
    // with a `default: true` marker and a blank cwd on a non-default agent must
    // still load. The roster migration records the retained default owner on
    // the config root; the blank-cwd migration must preserve that association.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151091-load-"));
    const context = createContext(root);
    fs.writeFileSync(
      context.configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "alpha", default: true },
            { id: "beta", cwd: " " },
          ],
        },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const config = await loadConfigFromContextAsync(context);
    expect(config.agents?.entries?.alpha).toBeDefined();
    expect(config.agents?.entries?.beta).toBeDefined();
    // The blank cwd was migrated away on the non-default agent.
    expect(config.agents?.entries?.beta?.cwd).toBeUndefined();
    // Retained legacy owner preserved: alpha remains the default owner.
    const alpha = config.agents?.entries?.alpha;
    expect(alpha).toBeDefined();
  });
});
