import fs from "node:fs";
import path from "node:path";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";

export const SQLITE_STAGING_TOKEN_FILES = [
  "owner.sqlite",
  "owner.sqlite-journal",
  "owner.sqlite-wal",
  "owner.sqlite-shm",
] as const;

export type SqliteStagingToken = (retiring?: boolean) => void;

export class SqliteStagingRetiredError extends Error {
  constructor() {
    super("SQLite snapshot parent retired; aborting snapshot allocation");
  }
}

/** Native transactions fence private staging admission and committed retirement. */
export function acquireSqliteStagingToken(
  directory: string,
  mode: "create" | "read" | "reclaim",
  options: { allowMissing?: boolean } = {},
): SqliteStagingToken {
  const location = path.join(directory, SQLITE_STAGING_TOKEN_FILES[0]);
  // Check sidecars before SQLite may recover or remove a private journal.
  const family = SQLITE_STAGING_TOKEN_FILES.map((file) =>
    fs.lstatSync(path.join(directory, file), { throwIfNoEntry: false }),
  );
  const existing = family[0];
  if (
    family.some(
      (file) => file && (!file.isFile() || (process.getuid && file.uid !== process.getuid())),
    ) ||
    (!existing && mode !== "create" && !options.allowMissing)
  ) {
    throw new Error("SQLite snapshot token ownership is unknown");
  }
  // Legacy callers may supply a parent without a token. Cooperating owners
  // create the same inode; SQLite arbitrates admission without recreating parents.
  const db = openNodeSqliteDatabase(existing ? resolveExistingSqliteFileUri(location) : location);
  const release: SqliteStagingToken = (retiring = false) => {
    if (!db.isOpen) {
      return;
    }
    if (retiring) {
      // Windows handles omit FILE_SHARE_DELETE: commit retirement while fenced,
      // then close for removal. Late workers reject the committed marker.
      if (!db.isTransaction) {
        db.exec("BEGIN IMMEDIATE");
      }
      db.exec("PRAGMA user_version=1; COMMIT");
    } else if (db.isTransaction) {
      // Bun can retain statements after close_v2; end the transaction now so
      // a released worker cannot keep its parent's retirement commit locked.
      db.exec("ROLLBACK");
    }
    db.close();
  };
  try {
    db.exec(
      `PRAGMA busy_timeout=0; ${mode === "create" ? "BEGIN IMMEDIATE" : mode === "reclaim" ? "BEGIN EXCLUSIVE" : "BEGIN; SELECT rootpage FROM sqlite_schema LIMIT 1"}`,
    );
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
      throw new Error("SQLite snapshot token journal mode is unknown");
    }
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && (mode !== "reclaim" || version !== 1)) {
      throw new SqliteStagingRetiredError();
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
