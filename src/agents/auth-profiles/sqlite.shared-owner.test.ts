import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import * as machineState from "../../state/config-machine-state.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./path-resolve.js";
import { loadPersistedSharedAuthProfileStore } from "./persisted.js";
import { captureRuntimeAuthSharedOwner } from "./runtime-snapshot-owner.js";
import { SHARED_STATE_STATE_KEY, SHARED_STORE_STATE_KEY } from "./sqlite-json.js";
import {
  deletePersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStateRaw,
  readPersistedSharedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import { createAuthProfileStoreRuntime } from "./store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  vi.unstubAllEnvs();
});

function fixture() {
  const stateDir = tempDirs.make("openclaw-sync-auth-owner-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const legacyPath = path.join(agentDir, "openclaw-agent.sqlite");
  const sharedPath = resolveOpenClawStateSqlitePath(process.env);
  const legacy = {
    version: 1,
    profiles: { legacy: { type: "api_key", provider: "fixture", key: "test-legacy" } },
  };
  const shared = {
    version: 1,
    profiles: { shared: { type: "api_key", provider: "fixture", key: "test-shared" } },
  };
  const legacyState = { order: { fixture: ["legacy"] } };
  const sharedState = { order: { fixture: ["shared"] } };
  writePersistedAuthProfileStoreRaw(legacy, agentDir);
  writePersistedAuthProfileStateRaw(legacyState, agentDir);
  writeConfigMachineState(SHARED_STORE_STATE_KEY, shared);
  writeConfigMachineState(SHARED_STATE_STATE_KEY, sharedState);
  const read = machineState.readConfigMachineState;
  function relocateAfterOwnershipRead(atRead = 1) {
    let reads = 0;
    vi.spyOn(machineState, "readConfigMachineState").mockImplementation((...args) => {
      const value = read(...args);
      if (args[0] === SHARED_AUTH_STORE_STATE_KEY && ++reads === atRead) {
        // Publish the durable owner after the read captured its old result,
        // without updating this process's cache, as another process would.
        writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
      }
      return value;
    });
  }
  return {
    agentDir,
    legacyPath,
    sharedPath,
    legacy,
    shared,
    legacyState,
    sharedState,
    relocateAfterOwnershipRead,
  };
}

it.each(["store", "state"] as const)(
  "keeps the synchronous %s adapter with its selected database",
  (kind) => {
    const f = fixture();
    f.relocateAfterOwnershipRead();
    const read =
      kind === "store"
        ? readPersistedSharedAuthProfileStoreRaw
        : readPersistedSharedAuthProfileStateRaw;
    expect(read(process.env)).toEqual(kind === "store" ? f.legacy : f.legacyState);
    expect(read(process.env)).toEqual(kind === "store" ? f.shared : f.sharedState);
  },
);

it.each(["snapshot", "transaction"] as const)(
  "captures consistent shared-owner metadata for a %s",
  (kind) => {
    const f = fixture();
    f.relocateAfterOwnershipRead();
    const owner =
      kind === "snapshot"
        ? captureRuntimeAuthSharedOwner()
        : runAuthProfileWriteTransaction(f.agentDir, (_database, prepared) => prepared);
    expect(owner).toMatchObject({ location: "legacy-main", sharedDatabasePath: f.legacyPath });
    expect(captureRuntimeAuthSharedOwner()).toEqual({
      kind: "resolved",
      location: "state-db",
      sharedDatabasePath: f.sharedPath,
    });
  },
);

it.each(["store", "state", "delete"] as const)(
  "uses the acquired database adapter for a %s mutation",
  (kind) => {
    const f = fixture();
    f.relocateAfterOwnershipRead();
    if (kind === "store") {
      writePersistedAuthProfileStoreRaw(f.legacy);
      expect(readPersistedSharedAuthProfileStoreRaw(process.env)).toEqual(f.legacy);
    } else if (kind === "state") {
      writePersistedAuthProfileStateRaw(f.legacyState);
      expect(readPersistedSharedAuthProfileStateRaw(process.env)).toEqual(f.legacyState);
    } else {
      deletePersistedAuthProfileStoreRaw();
      expect(readPersistedSharedAuthProfileStoreRaw(process.env)).toBeNull();
    }
  },
);

it("keeps shared credential rows and runtime state on one synchronous owner", () => {
  const f = fixture();
  f.relocateAfterOwnershipRead();
  expect(loadPersistedSharedAuthProfileStore(process.env)).toMatchObject({
    profiles: f.legacy.profiles,
    order: f.legacyState.order,
  });
});

it("keeps synchronous runtime credentials attributed to the database actually read", () => {
  const f = fixture();
  f.relocateAfterOwnershipRead(2);
  const runtime = createAuthProfileStoreRuntime({
    listRuntimeExternalAuthProfiles: () => [],
    overlayExternalAuthProfiles: (store) => store,
  });
  const onReadOwner = vi.fn();
  const loaded = runtime.loadAuthProfileStoreForRuntime(undefined, {
    externalCli: { mode: "none" },
    onReadOwner,
  });
  expect(onReadOwner).toHaveBeenCalledWith(expect.objectContaining({ databasePath: f.legacyPath }));
  expect(loaded).toMatchObject({
    profiles: f.legacy.profiles,
    runtimeCredentialSources: { legacy: { databasePath: f.legacyPath, provider: "fixture" } },
  });
});
