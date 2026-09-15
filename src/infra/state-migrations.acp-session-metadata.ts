import { createHash } from "node:crypto";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { selectAcpSessionRowForStoreEntry } from "../acp/runtime/session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.sqlite-exact-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { prepareDeferredPluginSessionImportReader } from "./deferred-plugin-session-sources.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";

const RECEIPT_KIND = "deferred-plugin-acp-metadata";

type LegacyAcpMetadataInput = Omit<
  Parameters<typeof writeAcpSessionMetaForMigration>[0],
  "database" | "databasePath"
> & {
  sourcePath: string;
  preserveSource: boolean;
  cfg: OpenClawConfig;
  agentId: string;
  readVerifiedCoreImport: ReturnType<typeof prepareDeferredPluginSessionImportReader>;
};

/** Retained JSON is input history, not authority to reopen a completed ACP import. */
export function importLegacyAcpSessionMetadata(params: LegacyAcpMetadataInput): boolean {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }
  const sourcePath = path.resolve(params.sourcePath);
  const binding = {
    sessionKey,
    sessionBinding: params.lifecycleRevision ?? params.sessionId ?? null,
  };
  const sourceKey = resolveLegacyMigrationSourceKey(
    RECEIPT_KIND,
    sourcePath,
    stableStringify(binding),
  );
  const serialized = stableStringify({ ...binding, meta: params.meta });
  const fingerprint = createHash("sha256").update(serialized).digest("hex");
  const now = params.now?.() ?? Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      const receipt = readLegacyMigrationReceiptFromDatabase(database.db, sourceKey);
      if (receipt) {
        if (receipt.sourceSha256 !== fingerprint) {
          throw new Error(
            `Retained ACP metadata changed after import in ${sourcePath}; resolve the source conflict before rerunning Doctor. Canonical metadata was not replayed.`,
          );
        }
        return false;
      }
      const coreTarget = params.readVerifiedCoreImport(database.db, params.agentId);
      let imported = true;
      if (coreTarget) {
        const canonical = loadExactSessionEntryReadOnly({
          agentId: params.agentId,
          storePath: coreTarget.sqlitePath,
          sessionKey,
          env: params.env,
        })?.entry;
        imported =
          canonical !== undefined &&
          (params.lifecycleRevision !== undefined
            ? canonical.lifecycleRevision === params.lifecycleRevision
            : canonical.sessionId === params.sessionId) &&
          !selectAcpSessionRowForStoreEntry(
            database.db,
            sessionKey,
            params.agentId,
            params.cfg,
            canonical,
          );
      }
      if (imported) {
        writeAcpSessionMetaForMigration({ ...params, sessionKey, database, now: () => now });
      }
      if (params.preserveSource) {
        recordLegacyMigrationReceipt(database.db, {
          sourceKey,
          migrationKind: RECEIPT_KIND,
          sourcePath,
          targetTable: "acp_sessions",
          sourceSha256: fingerprint,
          sourceSizeBytes: Buffer.byteLength(serialized),
          sourceRecordCount: 1,
          runId: sourceKey,
          reportJson: "{}",
          now,
        });
      }
      return imported;
    },
    { env: params.env },
    { operationLabel: "state.import-legacy-acp-metadata" },
  );
}
