import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  registerNodeSqliteDisposeCallback,
  SQLITE_DESERIALIZE_IN_TRANSACTION_CODE,
} from "./kysely-sync-cache-state.js";

function serializeMarker(value: number): Uint8Array {
  const source = new DatabaseSync(":memory:");
  try {
    source.exec("CREATE TABLE marker (value INTEGER)");
    source.prepare("INSERT INTO marker VALUES (?)").run(value);
    return source.serialize();
  } finally {
    source.close();
  }
}

function readMarker(db: DatabaseSync): number | undefined {
  const row = db.prepare("SELECT value FROM marker").get();
  return typeof row?.value === "number" ? row.value : undefined;
}

// SQLite 3.53.0 (Node 24.16/24.17) and 3.53.3+ (Node >= 24.19) disagree about an
// in-transaction `deserialize`: the older native accepts the destructive swap and
// the newer one rejects it. Both are inside the supported engine range, so the
// wrapper owns the invariant for every runtime.
describe.runIf(typeof DatabaseSync.prototype.deserialize === "function")(
  "node:sqlite deserialize wrapper",
  () => {
    it("refuses a replacement while a transaction is open, after retiring dependents", () => {
      const db = new DatabaseSync(":memory:");
      try {
        const reasons: string[] = [];
        registerNodeSqliteDisposeCallback(db, (reason) => reasons.push(reason));
        db.exec("CREATE TABLE marker (value INTEGER)");
        db.prepare("INSERT INTO marker VALUES (?)").run(1);
        const replacement = serializeMarker(2);

        db.exec("BEGIN IMMEDIATE");
        try {
          let caught: unknown;
          try {
            db.deserialize(replacement);
          } catch (error) {
            caught = error;
          }
          expect(caught).toMatchObject({ code: SQLITE_DESERIALIZE_IN_TRANSACTION_CODE });
          // Dependents are retired before the refusal, matching what a native
          // rejection leaves behind, so proof and read companions never survive a
          // replacement attempt.
          expect(reasons).toEqual(["replace"]);
          // The refusal is non-destructive: this connection keeps its own rows and
          // its open transaction.
          expect(db.isTransaction).toBe(true);
          expect(readMarker(db)).toBe(1);
        } finally {
          db.exec("ROLLBACK");
        }
        expect(readMarker(db)).toBe(1);
      } finally {
        db.close();
      }
    });

    it("still replaces the image when no transaction is open", () => {
      const db = new DatabaseSync(":memory:");
      try {
        const reasons: string[] = [];
        registerNodeSqliteDisposeCallback(db, (reason) => reasons.push(reason));
        db.exec("CREATE TABLE marker (value INTEGER)");
        db.prepare("INSERT INTO marker VALUES (?)").run(1);

        db.deserialize(serializeMarker(2));

        expect(reasons).toEqual(["replace"]);
        expect(db.isTransaction).toBe(false);
        expect(readMarker(db)).toBe(2);
      } finally {
        db.close();
      }
    });
  },
);
