// An accepted task-suggestion follow-up is handed the isolated workspace copy the
// source session's container worked in (see mount-root-handoff + session-create-root).
// The sandbox owner must keep running it in that copy: deriving another one seeds
// instruction files only, so the follow-up would never see the files it was created
// to work on.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureSandboxWorkspaceForSession } from "./sandbox/context.js";

let fixtureRoot = "";

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-follow-up-workspace-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("sandbox follow-up workspace", () => {
  it("keeps an accepted follow-up inside the isolated workspace it was handed", async () => {
    const sandboxRoot = path.join(fixtureRoot, "sandboxes");
    const ownedWorkspace = path.join(sandboxRoot, `workspace-${"a".repeat(32)}`);
    const projectDir = path.join(ownedWorkspace, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "SOURCE.md"), "# Source\n");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess: "none",
            workspaceRoot: sandboxRoot,
            prune: { idleHours: 0, maxAgeDays: 0 },
          },
        },
      },
    };

    const result = await ensureSandboxWorkspaceForSession({
      config: cfg,
      sessionKey: "agent:worker:follow-up",
      workspaceDir: projectDir,
    });

    expect(result?.workspaceDir).toBe(ownedWorkspace);
    await expect(
      fs.readFile(path.join(result?.workspaceDir ?? "", "project", "SOURCE.md"), "utf8"),
    ).resolves.toBe("# Source\n");
  }, 15_000);
});
