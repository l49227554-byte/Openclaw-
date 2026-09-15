import { createHash } from "node:crypto";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
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
      writeAcpSessionMetaForMigration({ ...params, sessionKey, database, now: () => now });
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
      return true;
    },
    { env: params.env },
    { operationLabel: "state.import-legacy-acp-metadata" },
  );
}
