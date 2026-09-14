import fs from "node:fs";
import type { FSWatcher } from "chokidar";

type FileStabilitySnapshot = {
  size: number;
  mtimeMs: number;
};

const RAW_SKILL_FILE_POLL_INTERVAL_MS = 100;

function readFileStabilitySnapshot(filePath: string): FileStabilitySnapshot | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

export async function waitForStableSkillFile(
  filePath: string,
  stabilityMs: number,
  watcher: FSWatcher,
  readRevision: () => number,
): Promise<void> {
  if (watcher.closed || stabilityMs <= 0) {
    return;
  }
  let previousRevision = readRevision();
  let previous = readFileStabilitySnapshot(filePath);
  if (!previous) {
    return;
  }
  let stableForMs = 0;
  while (stableForMs < stabilityMs) {
    const delayMs = Math.min(RAW_SKILL_FILE_POLL_INTERVAL_MS, stabilityMs - stableForMs);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    // Closing a watcher retires raw polling, even while the file keeps changing.
    if (watcher.closed) {
      return;
    }
    const nextRevision = readRevision();
    const next = readFileStabilitySnapshot(filePath);
    if (!next) {
      return;
    }
    if (
      nextRevision === previousRevision &&
      next.size === previous.size &&
      next.mtimeMs === previous.mtimeMs
    ) {
      stableForMs += delayMs;
      continue;
    }
    previous = next;
    previousRevision = nextRevision;
    stableForMs = 0;
  }
}
