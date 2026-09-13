/** Offline SQLite recovery preserves journals before moving the main pathname. */
import fs from "node:fs";
import { hasErrnoCode } from "./errno.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";

export function moveSqliteFilesAside(
  sqlitePath: string,
  assertCurrent: () => void,
): {
  movedFiles: string[];
  skippedFiles: string[];
} {
  const recoveryFiles = inspectSqliteRecoveryFiles(sqlitePath);
  const moves = planSqliteRecoveryMoves(recoveryFiles.existing);
  moveSqliteFilesWithRollback(
    moves.toSorted(
      (left, right) =>
        Number(left.sourcePath === sqlitePath) - Number(right.sourcePath === sqlitePath) ||
        left.sourcePath.localeCompare(right.sourcePath),
    ),
    assertCurrent,
  );
  return {
    movedFiles: moves.map((move) => move.destinationPath),
    skippedFiles: recoveryFiles.missing,
  };
}

/** Execute one planned offline file set; preserve both sides if rollback loses authority. */
export function moveSqliteFilesWithRollback(
  moves: readonly { sourcePath: string; destinationPath: string }[],
  assertCurrent?: () => void,
): void {
  const completed: (typeof moves)[number][] = [];
  try {
    for (const move of moves) {
      assertCurrent?.();
      if (pathExists(move.destinationPath)) {
        throw new Error(`SQLite family destination changed: ${move.destinationPath}`);
      }
      fs.renameSync(move.sourcePath, move.destinationPath);
      completed.push(move);
    }
  } catch (error) {
    rollbackFileMoves(completed, error, assertCurrent);
    throw error;
  }
}

export function rollbackFileMoves(
  moves: readonly { sourcePath: string; destinationPath: string }[],
  error: unknown,
  assertCurrent?: () => void,
): void {
  const rollbackErrors: unknown[] = [];
  const preservedPaths: string[] = [];
  for (const move of moves.toReversed()) {
    try {
      assertCurrent?.();
      if (pathExists(move.sourcePath)) {
        throw new Error(`rollback source was recreated: ${move.sourcePath}`, { cause: error });
      }
      fs.renameSync(move.destinationPath, move.sourcePath);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
      preservedPaths.push(move.destinationPath);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [error, ...rollbackErrors],
      `Could not restore SQLite family ${moves.map((move) => move.sourcePath).join(", ")}; rollback failures: ${rollbackErrors.map(String).join("; ")}. Preserved recovery files: ${preservedPaths.join(", ")}`,
      { cause: error },
    );
  }
}

export function inspectSqliteRecoveryFiles(sqlitePath: string): {
  existing: string[];
  missing: string[];
} {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const candidate of resolveSqliteDatabaseFilePaths(sqlitePath)) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile()) {
        throw new Error(`SQLite recovery path is not a regular file: ${candidate}`);
      }
      existing.push(candidate);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        missing.push(candidate);
        continue;
      }
      throw error;
    }
  }
  return { existing, missing };
}

export function planSqliteRecoveryMoves(
  sourcePaths: readonly string[],
): Array<{ destinationPath: string; sourcePath: string }> {
  const timestampSuffix = `.corrupt-${Date.now()}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? timestampSuffix : `${timestampSuffix}.${attempt}`;
    const moves = sourcePaths.map((sourcePath) => ({
      destinationPath: `${sourcePath}${suffix}`,
      sourcePath,
    }));
    if (moves.every((move) => !pathExists(move.destinationPath))) {
      return moves;
    }
  }
  throw new Error(`Could not choose recovery paths for ${sourcePaths[0] ?? "SQLite files"}`);
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}
