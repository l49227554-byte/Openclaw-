import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import {
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
  type MemoryExtraPath,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type NormalizedExtraMemoryPath = ReturnType<typeof normalizeExtraMemoryPathEntries>[number];

export type TemporalDecayConfig = {
  enabled: boolean;
  halfLifeDays: number;
};

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(?:[^/]+\/)*(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;

function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const { halfLifeDays } = params;
  const clampedAge = Math.max(0, params.ageInDays);
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0 || !Number.isFinite(clampedAge)) {
    return params.score;
  }
  return params.score * Math.exp(-(Math.LN2 / halfLifeDays) * clampedAge);
}

function parseMemoryDateFromPath(filePath: string): Date | null {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const match = DATED_MEMORY_PATH_RE.exec(normalized);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

function isEvergreenMemoryPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "MEMORY.md" || normalized === "USER.md") {
    return true;
  }
  if (!normalized.startsWith("memory/")) {
    return false;
  }
  return !DATED_MEMORY_PATH_RE.test(normalized);
}

async function extractTimestamp(params: {
  filePath: string;
  source?: string;
  workspaceDir?: string;
  evergreenExtraPaths?: NormalizedExtraMemoryPath[];
  sessionSourceMtimes?: ReadonlyMap<string, number | undefined>;
}): Promise<Date | null> {
  if (params.source === "sessions") {
    // Session paths are logical SQLite identities, not workspace files. Ranking
    // uses the indexed source activity, never a same-named filesystem artifact.
    const mtime = params.sessionSourceMtimes?.get(params.filePath);
    return mtime !== undefined && Number.isFinite(mtime) ? new Date(mtime) : null;
  }
  const normalizedPath = params.filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const isCanonicalMemoryPath =
    normalizedPath === "MEMORY.md" ||
    normalizedPath === "USER.md" ||
    normalizedPath.startsWith("memory/");

  const absolutePath = params.workspaceDir
    ? path.isAbsolute(params.filePath)
      ? params.filePath
      : path.resolve(params.workspaceDir, params.filePath)
    : undefined;

  // Stable reference sources can opt out of filesystem-mtime decay without
  // changing their provenance or relevance score. Dated canonical memory
  // files remain governed by their embedded date below.
  if (
    params.source === "memory" &&
    !isCanonicalMemoryPath &&
    absolutePath !== undefined &&
    params.evergreenExtraPaths?.some(
      (entry) =>
        (absolutePath === entry.path || isPathInside(entry.path, absolutePath)) &&
        matchesExtraMemoryPathEntry(entry, absolutePath),
    )
  ) {
    return null;
  }

  const fromPath = parseMemoryDateFromPath(params.filePath);
  if (fromPath) {
    return fromPath;
  }

  // Memory root/topic files are evergreen knowledge and should not decay.
  if (params.source === "memory" && isEvergreenMemoryPath(params.filePath)) {
    return null;
  }

  if (!absolutePath) {
    return null;
  }

  try {
    const stat = await fs.stat(absolutePath);
    if (!Number.isFinite(stat.mtimeMs)) {
      return null;
    }
    return new Date(stat.mtimeMs);
  } catch {
    return null;
  }
}

export async function applyTemporalDecayToHybridResults<
  T extends { path: string; score: number; source: string },
>(params: {
  results: T[];
  temporalDecay?: Partial<TemporalDecayConfig>;
  workspaceDir?: string;
  extraPaths?: MemoryExtraPath[];
  sessionSourceMtimes?: ReadonlyMap<string, number | undefined>;
  nowMs?: number;
}): Promise<T[]> {
  const config = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  if (!config.enabled) {
    return [...params.results];
  }

  const nowMs = params.nowMs ?? Date.now();
  const evergreenExtraPaths = params.workspaceDir
    ? normalizeExtraMemoryPathEntries(params.workspaceDir, params.extraPaths).filter(
        (entry) => entry.evergreen === true,
      )
    : [];
  const timestampPromiseCache = new Map<string, Promise<Date | null>>();

  return Promise.all(
    params.results.map(async (entry) => {
      const cacheKey = `${entry.source}:${entry.path}`;
      let timestampPromise = timestampPromiseCache.get(cacheKey);
      if (!timestampPromise) {
        timestampPromise = extractTimestamp({
          filePath: entry.path,
          source: entry.source,
          workspaceDir: params.workspaceDir,
          evergreenExtraPaths,
          sessionSourceMtimes: params.sessionSourceMtimes,
        });
        timestampPromiseCache.set(cacheKey, timestampPromise);
      }

      const timestamp = await timestampPromise;
      if (!timestamp) {
        return entry;
      }

      const decayedScore = applyTemporalDecayToScore({
        score: entry.score,
        ageInDays: (nowMs - timestamp.getTime()) / DAY_MS,
        halfLifeDays: config.halfLifeDays,
      });

      return {
        ...entry,
        score: decayedScore,
      };
    }),
  );
}
