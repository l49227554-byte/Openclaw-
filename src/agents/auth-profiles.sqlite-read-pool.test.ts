import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import * as kyselySync from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import {
  closeAuthProfileReadPool,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import { apiKeyStore, withAgentDirEnv } from "./auth-profiles/sqlite.test-support.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import { getRuntimeAuthProfileStoreSnapshotRevision } from "./auth-profiles/store.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  resolveExternalCliAuthProfiles: () => [],
}));

vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

describe("auth profile sqlite reader lifecycle", () => {
  it("reuses path-keyed read handles until the runtime snapshot revision changes", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-read-reuse-", (agentDir) => {
      const agentDirs = [
        agentDir,
        ...Array.from({ length: 7 }, (_, index) =>
          path.join(path.dirname(path.dirname(agentDir)), `secondary-${index}`, "agent"),
        ),
      ];
      for (const directory of agentDirs) {
        saveAuthProfileStore(apiKeyStore("sk-test"), directory);
      }
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const statementCacheSpy = vi.spyOn(kyselySync, "enableNodeSqliteKyselyStatementCache");
      try {
        const initialRevision = getRuntimeAuthProfileStoreSnapshotRevision(agentDir);
        for (const directory of agentDirs) {
          expect(loadPersistedAuthProfileStore(directory)).toMatchObject(apiKeyStore("sk-test"));
        }
        const missingAgentDir = path.join(path.dirname(path.dirname(agentDir)), "later", "agent");
        expect(inspectPersistedAuthProfileStoreRaw(missingAgentDir)).toEqual({
          status: "missing",
          reason: "database",
        });
        for (const opened of openSpy.mock.results.filter((result) => result.type === "return")) {
          expect(opened.value.isOpen).toBe(true);
        }
        for (const directory of agentDirs) {
          expect(loadPersistedAuthProfileStore(directory)).toMatchObject(apiKeyStore("sk-test"));
        }
        expect(openSpy.mock.calls.filter(([, options]) => options?.readOnly === true)).toHaveLength(
          9,
        );
        expect(statementCacheSpy).toHaveBeenCalledTimes(8);
        const firstDatabase = openSpy.mock.results[0]?.value as DatabaseSync | undefined;
        const secondDatabase = openSpy.mock.results[1]?.value as DatabaseSync | undefined;
        expect(firstDatabase?.isOpen).toBe(true);
        expect(secondDatabase?.isOpen).toBe(true);
        const prepare = vi.spyOn(
          expectDefined(firstDatabase, "first pooled auth reader"),
          "prepare",
        );
        const writer = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
        try {
          expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject(apiKeyStore("sk-test"));
          writer
            .prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'")
            .run(JSON.stringify(apiKeyStore("synthetic-external")));
          writer
            .prepare(
              `INSERT INTO auth_profile_state (state_key, state_json, updated_at)
               VALUES ('primary', ?, 1)
               ON CONFLICT (state_key) DO UPDATE SET state_json = excluded.state_json`,
            )
            .run(
              JSON.stringify({ version: 1, usageStats: { "openai:default": { lastUsed: 456 } } }),
            );
          expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
            ...apiKeyStore("synthetic-external"),
            usageStats: { "openai:default": { lastUsed: 456 } },
          });
          // Warm reads reuse statements, but each execution still observes committed rows.
          expect(prepare).not.toHaveBeenCalled();
        } finally {
          prepare.mockRestore();
          writer.close();
        }

        fs.mkdirSync(missingAgentDir, { recursive: true });
        const created = new DatabaseSync(resolveAuthProfileDatabasePath(missingAgentDir));
        try {
          created.exec(
            "CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT)",
          );
          created
            .prepare("INSERT INTO auth_profile_store VALUES (?, ?)")
            .run("primary", JSON.stringify(apiKeyStore("synthetic-created")));
        } finally {
          created.close();
        }
        expect(loadPersistedAuthProfileStore(missingAgentDir)).toMatchObject(
          apiKeyStore("synthetic-created"),
        );

        replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: apiKeyStore("sk-test") }]);

        expect(getRuntimeAuthProfileStoreSnapshotRevision(agentDir)).toBeGreaterThan(
          initialRevision,
        );
        expect(firstDatabase?.isOpen).toBe(false);
        expect(secondDatabase?.isOpen).toBe(false);
        expect(loadPersistedAuthProfileStore(agentDir)).not.toBeNull();
        expect(openSpy.mock.calls.filter(([, options]) => options?.readOnly === true)).toHaveLength(
          11,
        );
        expect(statementCacheSpy).toHaveBeenCalledTimes(10);
      } finally {
        statementCacheSpy.mockRestore();
        openSpy.mockRestore();
      }
    });
  });

  it("retains scoped readers for a retry when native close fails", async () => {
    await withAgentDirEnv("openclaw-auth-reader-close-", (agentDir) => {
      const siblingAgentDir = `${agentDir}-sibling`;
      saveAuthProfileStore(apiKeyStore("qa-synthetic"), agentDir);
      saveAuthProfileStore(apiKeyStore("qa-sibling"), siblingAgentDir);
      clearRuntimeAuthProfileStoreSnapshots();
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      let reader: DatabaseSync | undefined;
      try {
        expect(loadPersistedAuthProfileStore(agentDir)).not.toBeNull();
        reader = openSpy.mock.results[0]?.value as DatabaseSync;
        expect(loadPersistedAuthProfileStore(siblingAgentDir)).not.toBeNull();
        const siblingReader = openSpy.mock.results[1]?.value as DatabaseSync;
        const close = vi.spyOn(reader, "close").mockImplementationOnce(() => {
          throw new Error("native close failed");
        });
        try {
          expect(() => closeAuthProfileReadPool({ kind: "root", rootPath: agentDir })).toThrow(
            "native close failed",
          );
          expect(reader.isOpen).toBe(true);
          closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
          expect(reader.isOpen).toBe(false);
          expect(siblingReader.isOpen).toBe(true);
          expect(loadPersistedAuthProfileStore(siblingAgentDir)).toMatchObject(
            apiKeyStore("qa-sibling"),
          );
        } finally {
          close.mockRestore();
        }
      } finally {
        openSpy.mockRestore();
        if (reader?.isOpen) {
          reader.close();
        }
      }
    });
  });

  it("retains failed admission handles without opening more readers until cleanup succeeds", async () => {
    await withAgentDirEnv("openclaw-auth-reader-admission-", (agentDir) => {
      const agentDirs = Array.from({ length: 10 }, (_, index) =>
        path.join(path.dirname(path.dirname(agentDir)), `reader-${index}`, "agent"),
      );
      for (const directory of agentDirs) {
        saveAuthProfileStore(apiKeyStore("qa-synthetic"), directory);
      }
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      try {
        for (const directory of agentDirs.slice(0, 8)) {
          expect(loadPersistedAuthProfileStore(directory)).toMatchObject(
            apiKeyStore("qa-synthetic"),
          );
        }
        const oldest = openSpy.mock.results[0]?.value as DatabaseSync;
        const evictionClose = vi.spyOn(oldest, "close").mockImplementation(() => {
          throw new Error("eviction close failed");
        });
        const candidatePath = resolveAuthProfileDatabasePath(agentDirs[8]);
        let candidate: DatabaseSync | undefined;
        let candidateClose: MockInstance<DatabaseSync["close"]> | undefined;
        openSpy.mockImplementationOnce((...args) => {
          candidate = openDatabase(...args);
          candidateClose = vi.spyOn(candidate, "close").mockImplementation(() => {
            throw new Error("candidate close failed");
          });
          return candidate;
        });
        try {
          expect(() => loadPersistedAuthProfileStore(agentDirs[8])).toThrow(AggregateError);
          expect(oldest.isOpen).toBe(true);
          expect(candidate?.isOpen).toBe(true);
          expect(() => loadPersistedAuthProfileStore(agentDirs[9])).toThrow(
            "candidate close failed",
          );
          expect(() => loadPersistedAuthProfileStore(agentDirs[8])).toThrow(
            "candidate close failed",
          );
          expect(openSpy).toHaveBeenCalledTimes(9);
          expect(loadPersistedAuthProfileStore(agentDirs[0])).toMatchObject(
            apiKeyStore("qa-synthetic"),
          );
          candidateClose?.mockRestore();
          closeAuthProfileReadPool({ kind: "database", databasePath: candidatePath });
          expect(candidate?.isOpen).toBe(false);
          evictionClose.mockRestore();
          expect(loadPersistedAuthProfileStore(agentDirs[9])).toMatchObject(
            apiKeyStore("qa-synthetic"),
          );
          expect(openSpy).toHaveBeenCalledTimes(10);
        } finally {
          candidateClose?.mockRestore();
          evictionClose.mockRestore();
        }
      } finally {
        openSpy.mockRestore();
        closeAuthProfileReadPool();
      }
    });
  });
});
