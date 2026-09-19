import { describe, expect, it } from "vitest";
import { migrateBlankAgentCwd } from "./legacy.blank-agent-cwd.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("legacy blank agent cwd migration", () => {
  it("removes a blank per-agent cwd and reports the change", () => {
    const raw = {
      agents: {
        defaults: { cwd: "/tmp/default" },
        entries: { alpha: { cwd: " " } },
      },
    };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(true);
    const config = migrated.config as OpenClawConfig;
    expect(config.agents?.entries?.alpha).not.toHaveProperty("cwd");
    expect(config.agents?.defaults?.cwd).toBe("/tmp/default");
    expect(migrated.changes.some((c) => c.path === "entries.alpha")).toBe(true);
  });

  it("removes a blank defaults cwd when present", () => {
    const raw = { agents: { defaults: { cwd: " \t" } } };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(true);
    const config = migrated.config as OpenClawConfig;
    expect(config.agents?.defaults).not.toHaveProperty("cwd");
    expect(migrated.changes.some((c) => c.path === "agents.defaults.cwd")).toBe(true);
  });

  it("removes blank cwd values from agents.list entries", () => {
    const raw = {
      agents: {
        defaults: { cwd: "/tmp/default" },
        list: [{ id: "alpha", cwd: "   " }, { id: "beta" }],
      },
    };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(true);
    const config = migrated.config as OpenClawConfig;
    const list = config.agents?.list;
    expect(list).toHaveLength(2);
    expect(list?.[0]).not.toHaveProperty("cwd");
    expect(list?.[1]).not.toHaveProperty("cwd");
  });

  it("preserves non-blank cwd values and unchanged configs", () => {
    const raw = {
      agents: { defaults: { cwd: "/tmp/default" }, entries: { alpha: { cwd: "/srv/alpha" } } },
    };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(false);
    expect(migrated.config).toBe(raw);
    const noAgents = migrateBlankAgentCwd({ cron: {} });
    expect(noAgents.changed).toBe(false);
  });

  it("does not treat a non-string cwd as blank", () => {
    const raw = { agents: { defaults: { cwd: 42 } } };
    const migrated = migrateBlankAgentCwd(raw);
    expect(migrated.changed).toBe(false);
  });
});
