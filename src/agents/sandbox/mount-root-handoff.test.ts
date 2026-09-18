// The handoff admits sandbox-mounted roots to sandboxed session creation, so a
// root the sandbox only serves read-only must never reach the admitted list.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isVerifiedSandboxMountRootHandoff,
  resolveSandboxOwnedHostRoots,
} from "./mount-root-handoff.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function handoffConfig(params: {
  binds: string[];
  workspace: string;
  workspaceRoot: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          workspaceRoot: params.workspaceRoot,
          docker: { binds: params.binds },
        },
      },
      entries: { main: { workspace: params.workspace } },
    },
  } as unknown as OpenClawConfig;
}

function marker(hostRoot: string) {
  return { kind: "sandbox-mount-root" as const, agentId: "main", hostRoot };
}

describe("sandbox mount root handoff", () => {
  it("omits bind roots the mount table does not serve writable", () => {
    const sandboxRoot = tempDirs.make("openclaw-handoff-root-");
    const workspace = tempDirs.make("openclaw-handoff-workspace-");
    const checkout = tempDirs.make("openclaw-handoff-checkout-");
    const reference = tempDirs.make("openclaw-handoff-reference-");
    const parent = tempDirs.make("openclaw-handoff-parent-");
    const secrets = path.join(parent, "secrets");
    fs.mkdirSync(secrets, { recursive: true });
    const cfg = handoffConfig({
      workspace,
      workspaceRoot: sandboxRoot,
      binds: [
        `${checkout}:/project`,
        `${reference}:/reference:ro`,
        `${parent}:/parent`,
        `${secrets}:/secrets:ro`,
      ],
    });

    const roots = resolveSandboxOwnedHostRoots({ cfg, agentId: "main" });

    expect(roots).toContain(path.resolve(checkout));
    // A writable alias would bypass the `:ro` the operator configured, directly
    // or through a writable parent that shadows a read-only child.
    expect(roots).not.toContain(path.resolve(reference));
    expect(roots).not.toContain(path.resolve(parent));
    expect(roots).not.toContain(path.resolve(secrets));
  });

  it("verifies a marker only for a root the sandbox serves writable", () => {
    const sandboxRoot = tempDirs.make("openclaw-handoff-root-");
    const workspace = tempDirs.make("openclaw-handoff-workspace-");
    const checkout = tempDirs.make("openclaw-handoff-checkout-");
    const reference = tempDirs.make("openclaw-handoff-reference-");
    const cfg = handoffConfig({
      workspace,
      workspaceRoot: sandboxRoot,
      binds: [`${checkout}:/project`, `${reference}:/reference:ro`],
    });

    expect(
      isVerifiedSandboxMountRootHandoff({
        cfg,
        agentId: "main",
        hostPath: checkout,
        handoff: marker(checkout),
      }),
    ).toBe(true);
    expect(
      isVerifiedSandboxMountRootHandoff({
        cfg,
        agentId: "main",
        hostPath: reference,
        handoff: marker(reference),
      }),
    ).toBe(false);
  });
});
