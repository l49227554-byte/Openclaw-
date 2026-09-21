import type { DatabaseSync } from "node:sqlite";
import { readSqliteDataVersion } from "../../infra/node-sqlite.js";

/**
 * Connection-local memo for reference analysis over a bounded set of candidate
 * session ids.
 *
 * The reference predicate cannot be served from an index: it has to reach every
 * row that could hold an arbitrary reference (malformed JSON, raw invalid bytes,
 * `previousSessionId`, `usageFamilySessionIds`, `compactionCheckpoints`). So the
 * only way to keep a sweep's database work from growing with the candidate count
 * is to examine the store once for a batch of candidates and then prove, rather
 * than re-scan to discover, that the answer is still current at each later
 * boundary.
 *
 * The proof is a two-part connection-local token:
 *
 * - `PRAGMA data_version` changes whenever another connection commits, which is
 *   the only way an external writer can appear.
 * - A TEMP-table generation counter, bumped by TEMP triggers, observes writes on
 *   *this* connection, which `data_version` deliberately does not report.
 *
 * The triggers count `INSERT` and `UPDATE` only. A `DELETE` can remove a
 * reference but never create one, so a memo taken before a delete stays
 * conservative: it may still claim a candidate is referenced when it no longer
 * is, which abandons a reclaim, and can never claim a referenced candidate is
 * free. That asymmetry is what lets a sweep delete its own candidates without
 * invalidating the batch it is working through.
 */
type SessionReferenceToken = {
  dataVersion: number;
  referenceGeneration: number;
};

type SessionReferenceBatch = {
  token: SessionReferenceToken;
  /** Ids the priming scan actually resolved; anything else falls back. */
  candidateSessionIds: ReadonlySet<string>;
  /** Up to `MAX_TRACKED_OWNERS_PER_ID` distinct keys holding each primed id. */
  ownersByCandidateSessionId: ReadonlyMap<string, ReadonlySet<string>>;
};

/**
 * Two owners answer any single-key exclusion exactly: if two distinct keys hold
 * an id, excluding one still leaves it referenced, so further owners cannot
 * change the verdict. Requests excluding more keys than this fall back to a
 * fresh read rather than guessing.
 */
const MAX_TRACKED_OWNERS_PER_ID = 2;

// Keyed by database PATH, not the DatabaseSync object: a worker-coordinated
// operation (e.g. transcript archive publish) can release and reopen the
// cached connection for this exact path mid-sweep, producing a new
// DatabaseSync instance for the same logical database. Keying by the live
// connection object silently orphans the batch the moment that happens --
// every subsequent candidate in the same sweep sees `activeBatches.get()`
// return undefined and falls back to a full re-scan, defeating the batching
// this module exists to provide (confirmed empirically: identical dispatch
// counts to the archive-publish worker on both a working and a broken tree,
// but a `MISS (fresh open)` on the connection cache immediately follows
// every dispatch only on the tree where the batch gets lost).
const activeBatches = new Map<string, SessionReferenceBatch>();
const referenceTrackerSchemaVersions = new WeakMap<DatabaseSync, number>();

function ensureSessionReferenceTracker(database: DatabaseSync): void {
  const schemaRow = /* sqlite-allow-raw: pragma read has no Kysely form. */ database
    .prepare("PRAGMA schema_version")
    .get() as { schema_version?: unknown };
  if (typeof schemaRow.schema_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA schema_version");
  }
  const trackedSchemaVersion = referenceTrackerSchemaVersions.get(database);
  if (trackedSchemaVersion === schemaRow.schema_version) {
    return;
  }
  // sqlite-allow-raw -- TEMP triggers are the connection-local ownership boundary and see
  // unpublished raw DML. A main-schema change bumps the generation before reinstalling them,
  // so dropping and recreating either table cannot make an older memo look current.
  database.exec(`
    CREATE TEMP TABLE IF NOT EXISTS openclaw_session_reference_generation (id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT;
    INSERT OR IGNORE INTO openclaw_session_reference_generation (id, generation) VALUES (1, 0);
    ${trackedSchemaVersion === undefined ? "" : "UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1;"}
    DROP TRIGGER IF EXISTS openclaw_session_reference_generation_node_insert;
    DROP TRIGGER IF EXISTS openclaw_session_reference_generation_node_update;
    DROP TRIGGER IF EXISTS openclaw_session_reference_generation_window_insert;
    DROP TRIGGER IF EXISTS openclaw_session_reference_generation_window_update;
    CREATE TEMP TRIGGER openclaw_session_reference_generation_node_insert
      AFTER INSERT ON main.session_nodes BEGIN UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_reference_generation_node_update
      AFTER UPDATE ON main.session_nodes BEGIN UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_reference_generation_window_insert
      AFTER INSERT ON main.session_windows BEGIN UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1; END;
    CREATE TEMP TRIGGER openclaw_session_reference_generation_window_update
      AFTER UPDATE ON main.session_windows BEGIN UPDATE openclaw_session_reference_generation SET generation = generation + 1 WHERE id = 1; END;
  `);
  // A rolled-back schema change can reuse its version on retry after SQLite removes the triggers.
  if (!database.isTransaction) {
    referenceTrackerSchemaVersions.set(database, schemaRow.schema_version);
  }
}

function readSessionReferenceToken(database: DatabaseSync): SessionReferenceToken {
  ensureSessionReferenceTracker(database);
  const row =
    /* sqlite-allow-raw: the generation counter lives in the TEMP schema, outside the generated Kysely types. */ database
      .prepare("SELECT generation FROM temp.openclaw_session_reference_generation WHERE id = 1")
      .get() as { generation?: unknown };
  if (typeof row.generation !== "number") {
    throw new Error("SQLite session reference generation is unavailable");
  }
  return {
    dataVersion: readSqliteDataVersion(database),
    referenceGeneration: row.generation,
  };
}

/** Owner collector handed to a priming scan. */
export type SessionReferenceOwnerSink = {
  add: (candidateSessionId: string, ownerSessionKey: string) => void;
};

function createOwnerSink(): {
  sink: SessionReferenceOwnerSink;
  owners: Map<string, Set<string>>;
} {
  const owners = new Map<string, Set<string>>();
  return {
    owners,
    sink: {
      add: (candidateSessionId, ownerSessionKey) => {
        const tracked = owners.get(candidateSessionId) ?? new Set<string>();
        if (tracked.size < MAX_TRACKED_OWNERS_PER_ID || tracked.has(ownerSessionKey)) {
          tracked.add(ownerSessionKey);
        }
        owners.set(candidateSessionId, tracked);
      },
    },
  };
}

/**
 * Examines the store once for `candidateSessionIds` and serves every reference
 * question about a subset of them from that one pass while `run` executes.
 *
 * `prime` performs the real scan and reports which key holds each id. The batch
 * is released when `run` settles, so nothing here is a long-lived cache: a later
 * sweep starts from a fresh pass.
 */
export async function withSessionReferenceBatch<T>(
  database: DatabaseSync,
  path: string,
  candidateSessionIds: readonly string[],
  prime: (sink: SessionReferenceOwnerSink) => void,
  run: () => Promise<T>,
): Promise<T> {
  const previous = activeBatches.get(path);
  const { owners, sink } = createOwnerSink();
  try {
    const token = readSessionReferenceToken(database);
    prime(sink);
    activeBatches.set(path, {
      candidateSessionIds: new Set(candidateSessionIds),
      ownersByCandidateSessionId: owners,
      token,
    });
  } catch {
    // A store that cannot host the tracker keeps the unbatched read path.
    activeBatches.delete(path);
  }
  try {
    return await run();
  } finally {
    if (previous) {
      activeBatches.set(path, previous);
    } else {
      activeBatches.delete(path);
    }
  }
}

/**
 * Ids among `candidateSessionIds` still referenced by a key outside
 * `excludedSessionKeys`, or `undefined` when the active batch cannot answer and
 * the caller must read the store.
 */
export function resolveBatchedReferencedSessionIds(
  database: DatabaseSync,
  path: string,
  excludedSessionKeys: ReadonlySet<string>,
  candidateSessionIds: readonly string[],
): Set<string> | undefined {
  const batch = activeBatches.get(path);
  if (
    !batch ||
    candidateSessionIds.length === 0 ||
    excludedSessionKeys.size >= MAX_TRACKED_OWNERS_PER_ID ||
    candidateSessionIds.some((sessionId) => !batch.candidateSessionIds.has(sessionId))
  ) {
    return undefined;
  }
  let token: SessionReferenceToken;
  try {
    token = readSessionReferenceToken(database);
  } catch {
    return undefined;
  }
  if (
    token.dataVersion !== batch.token.dataVersion ||
    token.referenceGeneration !== batch.token.referenceGeneration
  ) {
    // An insert or update since the priming scan could have created a reference,
    // so the caller re-reads instead of trusting the memo.
    activeBatches.delete(path);
    return undefined;
  }
  return new Set(
    candidateSessionIds.filter((sessionId) =>
      [...(batch.ownersByCandidateSessionId.get(sessionId) ?? [])].some(
        (ownerSessionKey) => !excludedSessionKeys.has(ownerSessionKey),
      ),
    ),
  );
}
