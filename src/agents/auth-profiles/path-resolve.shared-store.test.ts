import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  deleteConfigMachineState,
  writeConfigMachineState,
} from "../../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnv } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { resolveAuthStatePathForDisplay, resolveAuthStorePathForDisplay } from "./paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { hasLocalAuthProfileStoreSource } from "./source-check.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const persistedStore = {
  version: 1,
  profiles: {
    "openai:test": { type: "api_key", provider: "openai", key: "test-key" },
  },
} satisfies AuthProfileStore;

function makeStateEnv(): NodeJS.ProcessEnv {
  const stateDir = tempDirs.make("openclaw-shared-auth-store-");
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
}

async function runOwnershipProbe(body: string): Promise<void> {
  const env = makeStateEnv();
  const source = `
    import assert from "node:assert/strict";
    import { execFile } from "node:child_process";
    import { existsSync } from "node:fs";
    import path from "node:path";
    import { promisify } from "node:util";
    import * as owner from "./src/agents/auth-profiles/path-resolve.ts";
    import { createAuthProfileStoreRuntime } from "./src/agents/auth-profiles/store.ts";
    import { captureOpenClawStateWorkerContext } from "./src/state/openclaw-state-worker-context.ts";
    import { writeConfigMachineState, deleteConfigMachineState } from "./src/state/config-machine-state-write.ts";
    import { resolveOpenClawStateSqlitePath } from "./src/state/openclaw-state-db.paths.ts";
    import { cleanupSessionStateForTest } from "./src/test-utils/session-state-cleanup.ts";
    const env = process.env;
    const store = ${JSON.stringify(persistedStore)};
    try {
      ${body}
      console.log("ownership-probe-settled");
    } finally {
      await cleanupSessionStateForTest({ stateDir: env.OPENCLAW_STATE_DIR });
    }
  `;
  // Vitest runs this file in a worker; production shared-state readers require
  // the main-thread host broker. The reader subprocess owns its actual workers.
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: env.OPENCLAW_STATE_DIR,
        TMPDIR: process.env.TMPDIR,
        OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
      },
      timeout: 30_000,
    },
  );
  expect(result.stdout.trim()).toBe("ownership-probe-settled");
}

describe("shared auth store path resolution", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearRuntimeAuthProfileStoreSnapshots();
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    closeOpenClawStateDatabaseForTest();
  });

  it("resolves an absent ownership record to legacy-main and observes out-of-process relocation", async () => {
    const env = makeStateEnv();
    const { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } =
      await import("./path-resolve.js");
    const { resolveSharedMainAuthAgentDir } = await import("./shared-main-dir.js");
    const legacyDir = resolveSharedMainAuthAgentDir(env);
    const legacyPath = path.join(legacyDir, "openclaw-agent.sqlite");
    const aliasEnv = {
      ...env,
      OPENCLAW_STATE_DIR: path.join(env.OPENCLAW_STATE_DIR ?? "", "."),
    };

    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "legacy-main" });
    expect(resolveSharedAuthStorePath(env)).toBe(legacyPath);
    expect(resolveSharedAuthStorePath(aliasEnv)).toBe(legacyPath);

    // A sibling process relocates the shared store while this one keeps running.
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });

    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
    expect(resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
    expect(resolveSharedAuthStorePath(aliasEnv)).toBe(resolveOpenClawStateSqlitePath(env));

    withEnv({ OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR, OPENCLAW_AGENT_DIR: undefined }, () => {
      writePersistedAuthProfileStoreRaw(persistedStore, legacyDir);
      const expectedPath = path.join(legacyDir, "openclaw-agent.sqlite");
      expect(resolveAuthStorePathForDisplay(legacyDir)).toBe(expectedPath);
      expect(resolveAuthStatePathForDisplay(legacyDir)).toBe(expectedPath);
      expect(inspectPersistedAuthProfileStoreRaw(legacyDir)).toMatchObject({
        status: "readable",
        raw: persistedStore,
      });
      expect(existsSync(expectedPath)).toBe(true);
    });
  });

  it("observes ownership relocated by an out-of-process auth mutation", async () => {
    const env = makeStateEnv();
    const {
      reloadSharedAuthStoreOwnership,
      resolveSharedAuthStoreOwnership,
      resolveSharedAuthStorePath,
    } = await import("./path-resolve.js");

    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "legacy-main" });
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });

    expect(reloadSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
    expect(resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
  });

  it("keeps a resolved state-db owner pinned after the ownership row disappears", async () => {
    const env = makeStateEnv();
    const { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } =
      await import("./path-resolve.js");
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });

    deleteConfigMachineState("auth.sharedStore", { env });
    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
    expect(resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
  });

  it("resolves the relocated store to the canonical shared state database", async () => {
    const env = makeStateEnv();
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } =
      await import("./path-resolve.js");

    expect(resolveSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
    expect(resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));

    withEnv({ OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR, OPENCLAW_AGENT_DIR: undefined }, () => {
      writePersistedAuthProfileStoreRaw(persistedStore);
      const agentDir = path.join(env.OPENCLAW_STATE_DIR ?? "", "agents", "helper", "agent");
      const expectedPath = resolveOpenClawStateSqlitePath(env);
      expect(resolveAuthStorePathForDisplay(agentDir)).toBe(expectedPath);
      expect(resolveAuthStatePathForDisplay(agentDir)).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
    });
  });

  it("keeps an agent-local store local under shared-state ownership", async () => {
    const env = makeStateEnv();
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const agentDir = path.join(env.OPENCLAW_STATE_DIR ?? "", "agents", "helper", "agent");

    withEnv({ OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR, OPENCLAW_AGENT_DIR: undefined }, () => {
      writePersistedAuthProfileStoreRaw(persistedStore, agentDir);
      const expectedPath = path.join(agentDir, "openclaw-agent.sqlite");
      expect(resolveAuthStorePathForDisplay(agentDir)).toBe(expectedPath);
      expect(resolveAuthStatePathForDisplay(agentDir)).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
    });
  });

  it("ignores runtime-only external CLI profiles when displaying store ownership", async () => {
    const env = makeStateEnv();
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
    const agentDir = path.join(env.OPENCLAW_STATE_DIR ?? "", "agents", "helper", "agent");

    withEnv({ OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR, OPENCLAW_AGENT_DIR: undefined }, () => {
      writePersistedAuthProfileStoreRaw(persistedStore);
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...persistedStore,
          runtimeExternalProfileIds: ["openai:test"],
          runtimeExternalCliProfileIds: ["openai:test"],
        },
        agentDir,
      );

      expect(hasLocalAuthProfileStoreSource(agentDir)).toBe(true);
      expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
      expect(resolveAuthStorePathForDisplay(agentDir)).toBe(resolveOpenClawStateSqlitePath(env));
      expect(resolveAuthStatePathForDisplay(agentDir)).toBe(resolveOpenClawStateSqlitePath(env));
    });
  });

  it("caches ownership independently for each canonical state root", async () => {
    const firstEnv = makeStateEnv();
    const secondEnv = makeStateEnv();
    const { resolveSharedAuthStoreOwnership } = await import("./path-resolve.js");
    expect(resolveSharedAuthStoreOwnership(firstEnv)).toEqual({ location: "legacy-main" });

    writeConfigMachineState(
      "auth.sharedStore",
      { location: "legacy-main", extra: true },
      { env: secondEnv },
    );

    expect(() => resolveSharedAuthStoreOwnership(secondEnv)).toThrow(
      expect.objectContaining({
        name: "InvalidSharedAuthStoreOwnershipError",
        code: "INVALID_SHARED_AUTH_STORE_OWNERSHIP",
        action: "openclaw doctor --fix",
      }),
    );
    expect(resolveSharedAuthStoreOwnership(firstEnv)).toEqual({ location: "legacy-main" });
  });

  it.each(["sync", "async", "runtime"] as const)(
    "refreshes the persistent %s reader after a separate save without Gateway refresh",
    async (firstReader) => {
      await runOwnershipProbe(String.raw`
        const runtime = createAuthProfileStoreRuntime({
          listRuntimeExternalAuthProfiles: () => [],
          overlayExternalAuthProfiles: (value) => value,
        });
        const options = { externalCli: { mode: "none" } };
        const legacy = owner.resolveSharedAuthStoreOwnership(env);
        assert.equal(legacy.location, "legacy-main");
        assert.equal(await owner.resolveSharedAuthStoreOwnershipAsync(
          captureOpenClawStateWorkerContext({ env })), legacy);
        assert.deepEqual((await runtime.loadAuthProfileStoreForRuntimeAsync(undefined, options)).profiles, {});
        assert.equal(existsSync(resolveOpenClawStateSqlitePath(env)), false);
        const lockPath = owner.resolveOAuthRefreshLockPath("openai", "openai:test", env);
        const writerSource = [
          'import { createAuthProfileStoreRuntime } from "./src/agents/auth-profiles/store.ts";',
          'import { resolveSharedAuthStoreOwnership } from "./src/agents/auth-profiles/path-resolve.ts";',
          'import { cleanupSessionStateForTest } from "./src/test-utils/session-state-cleanup.ts";',
          'const runtime = createAuthProfileStoreRuntime({ listRuntimeExternalAuthProfiles: () => [], overlayExternalAuthProfiles: (value) => value });',
          'runtime.saveAuthProfileStore(' + JSON.stringify(store) + ');',
          'console.log(JSON.stringify({ pid: process.pid, owner: resolveSharedAuthStoreOwnership() }));',
          'await cleanupSessionStateForTest({ stateDir: process.env.OPENCLAW_STATE_DIR });',
        ].join("\n");
        const writer = await promisify(execFile)(process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", writerSource],
          { cwd: process.cwd(), env, timeout: 15_000 });
        const receipt = JSON.parse(writer.stdout.trim());
        assert.notEqual(receipt.pid, process.pid);
        assert.deepEqual(receipt.owner, { location: "state-db" });
        if (${JSON.stringify(firstReader)} === "sync") {
          assert.deepEqual(owner.resolveSharedAuthStoreOwnership(env), { location: "state-db" });
        } else if (${JSON.stringify(firstReader)} === "async") {
          assert.deepEqual(await owner.resolveSharedAuthStoreOwnershipAsync(
            captureOpenClawStateWorkerContext({ env })), { location: "state-db" });
        }
        // In the runtime-first case there is no resolver priming after the save.
        assert.deepEqual((await runtime.loadAuthProfileStoreForRuntimeAsync(undefined, options)).profiles,
          store.profiles);
        assert.deepEqual(runtime.loadAuthProfileStoreForRuntime(undefined, options, env).profiles,
          store.profiles);
        assert.equal(owner.resolveSharedAuthStorePath(env), resolveOpenClawStateSqlitePath(env));
        assert.equal(owner.resolveOAuthRefreshLockPath("openai", "openai:test", env), lockPath);
      `);
    },
    60_000,
  );

  it.each([false, true])(
    "preserves unchanged legacy identity and rejects invalid rows (explicit: %s)",
    async (explicit) => {
      await runOwnershipProbe(String.raw`
        if (${explicit}) {
          writeConfigMachineState("auth.sharedStore", { location: "legacy-main" }, { env });
        }
        const first = owner.resolveSharedAuthStoreOwnership(env);
        const context = captureOpenClawStateWorkerContext({ env });
        assert.equal(await owner.resolveSharedAuthStoreOwnershipAsync(context), first);
        assert.equal(owner.resolveSharedAuthStoreOwnership(env), first);
        writeConfigMachineState("auth.sharedStore", { location: "invalid" }, { env });
        await assert.rejects(owner.resolveSharedAuthStoreOwnershipAsync(context), {
          code: "INVALID_SHARED_AUTH_STORE_OWNERSHIP",
        });
        assert.throws(() => owner.resolveSharedAuthStoreOwnership(env), {
          code: "INVALID_SHARED_AUTH_STORE_OWNERSHIP",
        });
        writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
        const relocated = await owner.resolveSharedAuthStoreOwnershipAsync(context);
        deleteConfigMachineState("auth.sharedStore", { env });
        assert.equal(await owner.resolveSharedAuthStoreOwnershipAsync(context), relocated);
        assert.equal(owner.resolveSharedAuthStoreOwnership(env), relocated);
      `);
    },
    60_000,
  );

  it("refreshes cached roots at the 256-root bound without admitting another root", async () => {
    await runOwnershipProbe(String.raw`
      const roots = Array.from({ length: 256 }, (_, i) => ({
        ...env, OPENCLAW_STATE_DIR: path.join(env.OPENCLAW_STATE_DIR, String(i)),
      }));
      try {
        for (const root of roots) {
          assert.deepEqual(owner.resolveSharedAuthStoreOwnership(root), { location: "legacy-main" });
        }
        writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: roots[0] });
        writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: roots[1] });
        assert.deepEqual(owner.resolveSharedAuthStoreOwnership(roots[0]), { location: "state-db" });
        assert.deepEqual(await owner.resolveSharedAuthStoreOwnershipAsync(
          captureOpenClawStateWorkerContext({ env: roots[1] })), { location: "state-db" });
        assert.throws(() => owner.resolveSharedAuthStoreOwnership(env), /process root limit/);
        await assert.rejects(owner.resolveSharedAuthStoreOwnershipAsync(
          captureOpenClawStateWorkerContext({ env })), /process root limit/);
        assert.equal(existsSync(resolveOpenClawStateSqlitePath(env)), false);
      } finally {
        for (const root of roots.slice(0, 2)) {
          await cleanupSessionStateForTest({ stateDir: root.OPENCLAW_STATE_DIR });
        }
      }
    `);
  }, 60_000);

  it.each(["commit", "reload", "revoked", "failure"] as const)(
    "settles an in-flight legacy refresh after %s without publishing stale ownership",
    async (event) => {
      const env = makeStateEnv();
      const started = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("synthetic owner read failure");
      // Race timing alone is controlled here; the real off-thread transport and
      // prepared runtime composition are exercised by the subprocess cases.
      vi.doMock("../../state/openclaw-state-worker-store.js", () => ({
        runOpenClawStateWorkerOperation: async () => {
          started.resolve();
          await release.promise;
          if (event === "failure") {
            throw failure;
          }
          return undefined;
        },
      }));
      const owner = await import("./path-resolve.js");
      const { captureOpenClawStateWorkerContext } =
        await import("../../state/openclaw-state-worker-context.js");
      const context = captureOpenClawStateWorkerContext({ env });
      const legacy = owner.resolveSharedAuthStoreOwnership(env);
      const pending = owner.resolveSharedAuthStoreOwnershipAsync(context);
      try {
        await Promise.race([
          started.promise,
          pending.then(() => {
            throw new Error("legacy refresh skipped its worker read");
          }),
        ]);
        let newer = legacy;
        if (event === "commit") {
          newer = { location: "state-db" };
          owner.noteCommittedSharedAuthStoreOwnership(newer, env);
        } else if (event === "reload") {
          newer = owner.reloadSharedAuthStoreOwnership(env);
          expect(newer).not.toBe(legacy);
        } else if (event === "revoked") {
          vi.spyOn(context.admission, "assertCurrent").mockImplementation(() => {
            throw failure;
          });
        }
        release.resolve();
        if (event === "failure" || event === "revoked") {
          await expect(pending).rejects.toBe(failure);
          expect(owner.resolveSharedAuthStoreOwnership(env)).toBe(legacy);
        } else {
          expect(await pending).toBe(newer);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
        vi.doUnmock("../../state/openclaw-state-worker-store.js");
      }
    },
  );
});
