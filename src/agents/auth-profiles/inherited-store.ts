import path from "node:path";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db-registry.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import { getRuntimeAuthProfileStoreSnapshotAtDatabasePath } from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { resolveAuthProfileDatabaseOwnerId, resolveAuthProfileDatabasePath } from "./sqlite.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import type { AuthProfileStore } from "./types.js";

/** An unreadable, refused inherited owner cannot make a healthy local store unavailable. */
export function loadInheritedAuthProfileStore(
  read: () => AuthProfileStore,
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileStore | undefined {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof AuthProfileStoreUnreadableError)) {
      throw error;
    }
    // Ownership may relocate after this read failed. Only a refused legacy
    // agent path can be ignored; shared-state and unrelated errors still fail.
    const databasePath = resolveAuthProfileDatabasePath(
      agentDir ?? resolveSharedMainAuthAgentDir(env),
    );
    const refusal = readAgentDatabaseAdmissionRefusal(
      resolveAuthProfileDatabaseOwnerId(agentDir ?? path.dirname(databasePath)),
      { env },
    );
    if (
      !isSameOpenClawAgentDatabasePath(error.databasePath, databasePath) ||
      !refusal?.paths.some((pathname) => isSameOpenClawAgentDatabasePath(pathname, databasePath))
    ) {
      throw error;
    }
    return undefined;
  }
}

/** Compose existing snapshots with fresh persisted reads only for their missing counterpart. */
export function resolveRuntimeAuthProfileStoreFromSnapshots(params: {
  agentDir?: string;
  inheritedAuthDir?: string;
  env?: NodeJS.ProcessEnv;
  loadStore: (agentDir?: string) => AuthProfileStore;
}): AuthProfileStore | null {
  const mainKey = params.inheritedAuthDir
    ? resolveAuthProfileDatabasePath(params.inheritedAuthDir)
    : resolveSharedAuthStorePath(params.env);
  const requestedKey = params.agentDir
    ? resolveAuthProfileDatabasePath(params.agentDir)
    : resolveSharedAuthStorePath(params.env);
  const mainStore = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(mainKey);
  if (!params.agentDir || requestedKey === mainKey) {
    return mainStore ?? null;
  }
  const requestedStore = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(requestedKey);
  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(mainStore, requestedStore, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  if (requestedStore) {
    const persistedMainStore = loadInheritedAuthProfileStore(
      () => params.loadStore(params.inheritedAuthDir),
      params.inheritedAuthDir,
      params.env,
    );
    return persistedMainStore
      ? mergeAuthProfileStores(persistedMainStore, requestedStore, {
          preserveBaseRuntimeExternalProfiles: true,
        })
      : requestedStore;
  }
  return mainStore
    ? mergeAuthProfileStores(mainStore, params.loadStore(params.agentDir), {
        preserveBaseRuntimeExternalProfiles: true,
      })
    : null;
}
