import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSandboxContainerName,
  resolveSandboxWorkspaceLayoutPaths,
  slugifySessionKey,
} from "./shared.js";

describe("buildSandboxContainerName", () => {
  it("preserves scope identity when a custom prefix exceeds the Docker name limit", () => {
    const commonPrefix = "custom-prefix-".repeat(6);
    const first = buildSandboxContainerName(
      `${commonPrefix}first`,
      slugifySessionKey("session:first"),
    );
    const second = buildSandboxContainerName(
      `${commonPrefix}second`,
      slugifySessionKey("session:second"),
    );
    const sameScopeDifferentPrefix = buildSandboxContainerName(
      `${commonPrefix}second`,
      slugifySessionKey("session:first"),
    );
    const oversizedSlug = buildSandboxContainerName(
      commonPrefix,
      slugifySessionKey("session:".concat("x".repeat(200))),
    );

    expect(first).not.toBe(second);
    expect(first).not.toBe(sameScopeDifferentPrefix);
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(oversizedSlug).toHaveLength(63);
    expect(first).toMatch(/-[0-9a-f]{12}$/);
    expect(second).toMatch(/-[0-9a-f]{12}$/);
    expect(oversizedSlug).toMatch(/-[0-9a-f]{12}$/);
  });

  it("preserves workspace identity when a custom prefix exceeds the Docker name limit", () => {
    const slug = slugifySessionKey(`agent:main:workspace:${"a".repeat(32)}`);
    const first = buildSandboxContainerName("custom-prefix-one-that-is-far-too-long-", slug);
    const second = buildSandboxContainerName("custom-prefix-two-that-is-far-too-long-", slug);

    expect(slug).toMatch(/^workspace-[a-f0-9]{32}$/);
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(first).not.toBe(second);
    expect(first).toContain(slug);
    expect(second).toContain(slug);
    expect(first).toMatch(/-[a-f0-9]{12}$/);
    expect(second).toMatch(/-[a-f0-9]{12}$/);
  });
});

describe("resolveSandboxWorkspaceLayoutPaths", () => {
  const sessionKey = "agent:poly:msteams:channel-1";
  const workspaceA = "/tmp/openclaw-customers/atica/agents/poly/workspace";
  const workspaceB = "/tmp/openclaw-customers/polytopic/agents/poly/workspace";
  const createLayout = (scope: "session" | "agent" | "shared", workspaceDir: string) =>
    resolveSandboxWorkspaceLayoutPaths({
      cfg: {
        scope,
        workspaceAccess: "rw",
        workspaceRoot: "/tmp/openclaw-sandboxes",
      },
      rawSessionKey: sessionKey,
      workspaceDir,
    });

  it.each(["session", "agent"] as const)("qualifies %s scope by resolved workspace", (scope) => {
    const first = createLayout(scope, workspaceA).scopeKey;
    const second = createLayout(scope, workspaceB).scopeKey;

    expect(first).toMatch(/:workspace:[a-f0-9]{32}$/);
    expect(second).toMatch(/:workspace:[a-f0-9]{32}$/);
    expect(first).not.toBe(second);
  });

  it("keeps shared scope independent of workspace", () => {
    expect(createLayout("shared", workspaceA).scopeKey).toBe("shared");
    expect(createLayout("shared", workspaceB).scopeKey).toBe("shared");
  });

  it("uses the prepared agent owner for a bare agent-scoped session key", () => {
    const layout = resolveSandboxWorkspaceLayoutPaths({
      cfg: {
        scope: "agent",
        workspaceAccess: "rw",
        workspaceRoot: "/tmp/openclaw-sandboxes",
      },
      rawSessionKey: "global",
      agentId: "research",
      workspaceDir: workspaceA,
    });

    expect(layout.scopeKey).toMatch(/^agent:research:workspace:[a-f0-9]{32}$/);
  });

  it.each(["agent", "session", "shared"] as const)(
    "isolates different required-sandbox principals with %s scope",
    (scope) => {
      const layoutForPrincipal = (sandboxPrincipalId: string) => {
        const layout = resolveSandboxWorkspaceLayoutPaths({
          cfg: { scope, workspaceAccess: "ro", workspaceRoot: "/tmp/openclaw-sandboxes" },
          rawSessionKey: `agent:shared:${sandboxPrincipalId}`,
          agentId: "shared",
          isolationSubject: { kind: "profile", profileId: sandboxPrincipalId },
          workspaceDir: workspaceA,
        });
        return {
          ...layout,
          containerName: buildSandboxContainerName(
            "openclaw-sbx-",
            slugifySessionKey(layout.scopeKey),
          ),
        };
      };

      const guestA = layoutForPrincipal("guest-a");
      const guestB = layoutForPrincipal("guest-b");

      expect(guestA.scopeKey).not.toBe(guestB.scopeKey);
      expect(guestA.containerName).not.toBe(guestB.containerName);
      expect(guestA.workspaceDir).not.toBe(guestB.workspaceDir);
      expect(guestA.workspaceDir).not.toBe(guestA.agentWorkspaceDir);
      expect(guestB.workspaceDir).not.toBe(guestB.agentWorkspaceDir);
    },
  );

  it.each(["agent", "session", "shared"] as const)(
    "reuses one sandbox for the same required-sandbox principal with %s scope",
    (scope) => {
      const layoutForSession = (rawSessionKey: string) => {
        const layout = resolveSandboxWorkspaceLayoutPaths({
          cfg: { scope, workspaceAccess: "ro", workspaceRoot: "/tmp/openclaw-sandboxes" },
          rawSessionKey,
          agentId: "shared",
          isolationSubject: { kind: "profile", profileId: "guest-a" },
          workspaceDir: workspaceA,
        });
        return {
          ...layout,
          containerName: buildSandboxContainerName(
            "openclaw-sbx-",
            slugifySessionKey(layout.scopeKey),
          ),
        };
      };

      const firstSession = layoutForSession("agent:shared:first-session");
      const secondSession = layoutForSession("agent:shared:second-session");

      expect(firstSession.scopeKey).toBe(secondSession.scopeKey);
      expect(firstSession.containerName).toBe(secondSession.containerName);
      expect(firstSession.workspaceDir).toBe(secondSession.workspaceDir);
    },
  );

  it("preserves the shared writable agent workspace without a required-sandbox principal", () => {
    const layoutForSession = (rawSessionKey: string) =>
      resolveSandboxWorkspaceLayoutPaths({
        cfg: { scope: "agent", workspaceAccess: "rw", workspaceRoot: "/tmp/openclaw-sandboxes" },
        rawSessionKey,
        agentId: "shared",
        workspaceDir: workspaceA,
      });

    const firstSession = layoutForSession("agent:shared:first-session");
    const secondSession = layoutForSession("agent:shared:second-session");

    expect(firstSession.scopeKey).toBe(secondSession.scopeKey);
    expect(firstSession.workspaceDir).toBe(workspaceA);
    expect(secondSession.workspaceDir).toBe(workspaceA);
    expect(firstSession.workspaceSource).toBe("agent");
  });

  // An accepted follow-up is handed the isolated workspace copy the source
  // session's container worked in. Deriving another copy would seed instruction
  // files only, so the child must keep running in the copy the sandbox owns.
  it.each(["agent", "session"] as const)(
    "continues a follow-up inside the isolated %s workspace the sandbox already owns",
    (scope) => {
      const workspaceRoot = path.resolve("/tmp/openclaw-sandboxes");
      const ownedWorkspace = path.join(workspaceRoot, `workspace-${"a".repeat(32)}`);
      const layoutFor = (workspaceDir: string) =>
        resolveSandboxWorkspaceLayoutPaths({
          cfg: { scope, workspaceAccess: "none", workspaceRoot },
          rawSessionKey: "agent:main:follow-up",
          agentId: "main",
          workspaceDir,
        });

      const configured = layoutFor(
        path.resolve("/tmp/openclaw-customers/atica/agents/main/workspace"),
      );
      const handed = layoutFor(ownedWorkspace);
      const nested = layoutFor(path.join(ownedWorkspace, "project"));

      expect(configured.sandboxWorkspaceDir).toMatch(/[\\/]workspace-[a-f0-9]{32}$/);
      expect(configured.sandboxWorkspaceDir).not.toBe(ownedWorkspace);
      expect(handed.sandboxWorkspaceDir).toBe(ownedWorkspace);
      expect(handed.workspaceDir).toBe(ownedWorkspace);
      expect(nested.sandboxWorkspaceDir).toBe(ownedWorkspace);
    },
  );
});
