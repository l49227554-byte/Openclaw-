import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIoContext } from "./io.context.js";
import { readConfigFileSnapshotInternal } from "./io.snapshot.js";
import { writeConfigFileFromContext } from "./io.write.js";

function makeContext(root: string) {
  const configPath = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    VITEST: "true",
  };
  return createConfigIoContext({ configPath, env, homedir: () => root, observe: false });
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

describe("saved blank agentDir does not block unrelated config writes", () => {
  it("an unrelated gateway.port write persists despite the saved blank agentDir", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-151013-write-"));
    fs.writeFileSync(
      path.join(root, "openclaw.json"),
      JSON.stringify({
        agents: { entries: { alpha: { agentDir: " " } } },
        gateway: { mode: "local", port: 18799, auth: { mode: "none" } },
      }),
    );
    const ctx = makeContext(root);
    const base = await readConfigFileSnapshotInternal(ctx, {});
    const next = JSON.parse(JSON.stringify(base.snapshot.config)) as {
      gateway?: { port?: number };
    };
    if (next.gateway) next.gateway.port = 18888;
    const result = await writeConfigFileFromContext(
      ctx,
      next as never,
      { explicitSetPaths: [["gateway", "port"]] },
      async () => base,
    );
    expect(result).toBeDefined();
    const persisted = JSON.parse(fs.readFileSync(path.join(root, "openclaw.json"), "utf-8"));
    expect(persisted.gateway.port).toBe(18888);
    // The saved blank agentDir was migrated on write, not preserved as invalid.
    if (persisted.agents?.entries?.alpha?.agentDir !== undefined) {
      expect(persisted.agents.entries.alpha.agentDir.trim()).not.toBe("");
    }
  });
});
