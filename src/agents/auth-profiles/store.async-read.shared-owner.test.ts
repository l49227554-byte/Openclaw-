import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import * as ownership from "./path-resolve.js";
import * as sqliteRead from "./sqlite-read.js";
import { createAuthProfileStoreRuntime } from "./store.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  vi.unstubAllEnvs();
});

it.each([
  { boundary: "ownership", local: false, unreadable: false },
  { boundary: "rows", local: false, unreadable: false },
  { boundary: "ownership", local: true, unreadable: false },
  { boundary: "rows", local: true, unreadable: false },
  { boundary: "rows", local: false, unreadable: true },
  { boundary: "ownership", local: true, unreadable: true },
  { boundary: "rows", local: true, unreadable: true },
] as const)(
  "keeps the prepared owner across $boundary relocation (local: $local, unreadable: $unreadable)",
  async ({ boundary, local, unreadable }) => {
    const root = tempDirs.make("openclaw-async-shared-owner-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
    const legacyPath = ownership.resolveSharedAuthStorePath();
    const localDir = local ? path.join(root, "agents", "worker", "agent") : undefined;
    if (local && unreadable) {
      recordAgentDatabaseAdmissions(
        [
          createAgentDatabaseInspectionRefusal({
            agentId: "main",
            paths: [legacyPath],
            reason: "Synthetic inherited owner refusal",
          }),
        ],
        { env: process.env, source: "startup" },
      );
    }
    const localStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture:local": { type: "api_key", provider: "fixture", key: "local-test-key" },
      },
    };
    const sharedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture:shared": { type: "api_key", provider: "fixture", key: "shared-test-key" },
      },
    };
    const rows = (store: AuthProfileStore): AuthProfileRowRead => ({
      store: { status: "readable", raw: store },
      state: { status: "missing", reason: "row" },
    });
    const started = createDeferredCore();
    const release = createDeferredCore();
    let paused = false;
    const pause = async (at: typeof boundary) => {
      if (at === boundary && !paused) {
        paused = true;
        started.resolve();
        await release.promise;
      }
    };
    // Only transport timing is synthetic. Exercise the real runtime reader,
    // row decoding, inherited-store composition, and refusal-path attribution.
    vi.spyOn(ownership, "resolveSharedAuthStoreOwnershipAsync").mockImplementation(async () => {
      const captured = ownership.resolveSharedAuthStoreOwnership();
      await pause("ownership");
      return captured;
    });
    const disposals: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation(
      ({ databasePath }) => {
        const dispose = vi.fn(async () => {});
        disposals.push(dispose);
        return {
          assertCurrent: () => {},
          dispose,
          read: async () => {
            if (databasePath !== legacyPath) {
              return rows(localStore);
            }
            await pause("rows");
            return unreadable
              ? { store: { status: "unreadable" }, state: { status: "missing", reason: "row" } }
              : rows({ version: 1, profiles: {} });
          },
        };
      },
    );
    vi.spyOn(sqliteRead, "readSharedAuthProfileRows").mockResolvedValue(rows(sharedStore));
    const runtime = createAuthProfileStoreRuntime({
      listRuntimeExternalAuthProfiles: () => [],
      overlayExternalAuthProfiles: (store) => store,
    });
    const options = { externalCli: { mode: "none" as const } };
    const loading = runtime.loadAuthProfileStoreForRuntimeAsync(localDir, options);
    try {
      await Promise.race([
        started.promise,
        loading.then(() => {
          throw new Error("Load completed before the relocation barrier");
        }),
      ]);
      ownership.noteCommittedSharedAuthStoreOwnership({ location: "state-db" });
      release.resolve();
      if (unreadable && !local) {
        await expect(loading).rejects.toMatchObject({
          code: "AUTH_PROFILE_STORE_UNREADABLE",
          databasePath: legacyPath,
        });
      } else {
        expect((await loading).profiles).toEqual(local ? localStore.profiles : {});
      }
      for (const dispose of disposals) {
        expect(dispose).toHaveBeenCalledOnce();
      }
      expect(
        (await runtime.loadAuthProfileStoreForRuntimeAsync(localDir, options)).profiles,
      ).toEqual({
        ...sharedStore.profiles,
        ...(local ? localStore.profiles : {}),
      });
    } finally {
      release.resolve();
      await Promise.allSettled([loading]);
    }
  },
);
