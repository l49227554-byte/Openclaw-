import path from "node:path";
import { expect, test, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createProjectsHandlers } from "./projects.js";

const listRegistryRecords = vi.fn(async () => []);
const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
  checkoutRoot: checkoutPath,
  repoRoot: checkoutPath,
  originUrl: "",
  fingerprint: checkoutPath,
}));
const projectsHandlers = createProjectsHandlers({
  listRegistryRecords,
  resolveRepositoryIdentity,
} as never);

async function listProjects(cfg: OpenClawConfig, profileId: string) {
  let result: { payload?: unknown } | undefined;
  await projectsHandlers["projects.list"]!({
    req: {} as never,
    params: {},
    respond: (_ok, payload) => {
      result = { payload };
    },
    context: { getRuntimeConfig: () => cfg } as never,
    client: {
      connect: { scopes: ["operator.write"] },
      authenticatedUserProfile: { profileId },
    } as never,
    isWebchatConnect: () => false,
  });
  return result;
}

const sharedWorkspacePath = path.resolve("/workspace/shared");

test.each([
  { name: "spawned folder", folder: { spawnedCwd: sharedWorkspacePath, execCwd: "/unused" } },
  { name: "exec folder", folder: { execCwd: sharedWorkspacePath } },
  {
    name: "worktree root",
    folder: {
      worktree: { id: "checkout", branch: "topic", repoRoot: sharedWorkspacePath },
      spawnedCwd: "/workspace/checkout",
      execCwd: "/unused",
    },
  },
])(
  "projects.list attributes global recents to the owning agent workspace via $name",
  async ({ folder }) => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" });
    try {
      const profile = ensureProfileForEmail("global-recents@example.test");
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: "global" },
        {
          sessionId: "work-global",
          updatedAt: 900,
          createdActor: { type: "human", source: "profile", id: profile.id },
          ...folder,
        },
      );
      const result = await listProjects(
        {
          agents: {
            list: [
              { id: "main", default: true, workspace: sharedWorkspacePath },
              { id: "work", workspace: sharedWorkspacePath },
            ],
          },
          session: { scope: "global" },
        },
        profile.id,
      );

      expect((result?.payload as { recents?: unknown[] } | undefined)?.recents).toEqual([
        { kind: "project", projectId: "workspace:work", displayName: "shared" },
      ]);
    } finally {
      await state.cleanup();
    }
  },
);
