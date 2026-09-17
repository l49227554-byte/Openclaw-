// One guarded owner for include-file publication: stage in memory (no disk
// effects), publish inside the caller's commit window under a per-target lock
// with a hash fence, and restore-only-if-unchanged on failure. Authority is
// asserted immediately before every disk effect via the caller-supplied
// assertConfigPathForWrite, the same contract the root config file uses.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { formatErrorMessage, isMissingPathError } from "../infra/errors.js";
import { root as createFsRoot, type Root as FsSafeRoot } from "../infra/fs-safe.js";
import { isPathInside } from "../security/scan-paths.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { restoreEnvVarRefs } from "./env-preserve.js";
import {
  resolveKeyedAgentEntryIncludePreservation,
  resolveKeyedProviderModelsIncludePreservation,
} from "./include-write-boundary.js";
import {
  ConfigIncludeError,
  hashConfigIncludeRaw,
  isInternalIncludeWriteTarget,
  resolveConfigIncludeWritePath,
  type ConfigIncludeOwnership,
} from "./includes.js";
import { hashConfigRaw, rejectConfigNonFiniteNumbers } from "./io.read-helpers.js";
import { createConfigIncludeOwnershipError } from "./io.write-errors.js";
import {
  captureConfigFileWritePathProof,
  createGuardedConfigFileSystem,
  rollbackConfigFileWriteIfUnchanged,
} from "./io.write-safety.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { withConfigWriteLock } from "./write-lock.js";

/** Combines the two keyed-preservation resolvers into the single path list
 * resolvePersistCandidateForWrite/captureIncludeWriteThrough need. */
export function resolveIncludeWriteThroughPaths(params: {
  configPath: string;
  provenance: Parameters<typeof resolveKeyedAgentEntryIncludePreservation>[0]["provenance"];
}): {
  keyedAgentEntryIncludePaths?: readonly (readonly string[])[];
  includeWriteThroughPaths: readonly (readonly string[])[];
} {
  const keyedAgentEntry = resolveKeyedAgentEntryIncludePreservation(params);
  const keyedProviderModels = resolveKeyedProviderModelsIncludePreservation(params);
  return {
    keyedAgentEntryIncludePaths: keyedAgentEntry?.includePaths,
    includeWriteThroughPaths: [
      ...(keyedAgentEntry?.includePaths ?? []),
      ...(keyedProviderModels?.includePaths ?? []),
    ],
  };
}

export type PendingIncludeWrite = {
  includePath: string[];
  value: unknown;
};

// Keyed-path predicates for the two write-through-eligible include shapes.
// Moved beside captureIncludeWriteThrough; io.write-prepare.ts owns the tree
// walk (collectIncludeOwnedPaths) and filters with these.
export function isKeyedAgentEntryIncludePath(keyPath: readonly string[]): boolean {
  return keyPath.length === 3 && keyPath[0] === "agents" && keyPath[1] === "entries";
}

export function isKeyedProviderModelsIncludePath(keyPath: readonly string[]): boolean {
  return (
    keyPath.length === 4 &&
    keyPath[0] === "models" &&
    keyPath[1] === "providers" &&
    keyPath[3] === "models"
  );
}

// Filters collectIncludeOwnedPaths's tree walk (owned by io.write-prepare.ts,
// which still does the walk) down to the two write-through-eligible shapes,
// honoring caller overrides of either result list.
export function resolveIncludeOwnedWriteThroughPaths(params: {
  includeOwnedPaths?: readonly (readonly string[])[];
  keyedAgentEntryIncludePathsOverride?: readonly (readonly string[])[];
  includeWriteThroughPathsOverride?: readonly (readonly string[])[];
}): {
  keyedAgentEntryIncludePaths?: readonly (readonly string[])[];
  includeWriteThroughPaths?: readonly (readonly string[])[];
} {
  const keyedAgentEntryPaths = params.includeOwnedPaths?.filter(isKeyedAgentEntryIncludePath);
  const keyedAgentEntryIncludePaths =
    params.keyedAgentEntryIncludePathsOverride ??
    (params.includeWriteThroughPathsOverride === undefined ? keyedAgentEntryPaths : undefined);
  const includeWriteThroughPaths =
    params.includeWriteThroughPathsOverride ??
    (params.includeOwnedPaths
      ? [
          ...keyedAgentEntryPaths!,
          ...params.includeOwnedPaths.filter(isKeyedProviderModelsIncludePath),
        ]
      : undefined);
  return { keyedAgentEntryIncludePaths, includeWriteThroughPaths };
}

function includeConfigPathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

// Canonical immutable path get/set, moved from io.write-prepare.ts (which
// re-imports them) so there is exactly one copy. Config paths can traverse
// array indices (roster entries), hence parseConfigPathArrayIndex.
export function getPathValue(value: unknown, keyPath: string[]): unknown {
  let current = value;
  for (const segment of keyPath) {
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      if (index === undefined || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function setPathValue(value: unknown, keyPath: string[], nextValue: unknown): unknown {
  if (keyPath.length === 0) {
    return structuredClone(nextValue);
  }
  const head = expectDefined(keyPath[0], "config path head");
  const tail = keyPath.slice(1);
  if (Array.isArray(value)) {
    const index = parseConfigPathArrayIndex(head);
    if (index === undefined || index >= value.length) {
      return value;
    }
    const next = [...value];
    next[index] = setPathValue(value[index], tail, nextValue);
    return next;
  }
  if (!isRecord(value)) {
    return value;
  }
  return {
    ...value,
    [head]: setPathValue(value[head], tail, nextValue),
  };
}

/** Diff-and-capture pass: pulls keyed include-owned values out of nextConfig
 * into pendingIncludeWrites and restores the root-authored value in their
 * place, so the root persist candidate never carries include-owned content. */
export function captureIncludeWriteThrough(params: {
  includeWriteThroughPaths: readonly (readonly string[])[];
  nextConfig: unknown;
  sourceConfig: unknown;
  runtimeConfig: unknown;
  pendingIncludeWrites: PendingIncludeWrite[];
}): unknown {
  let nextConfig = params.nextConfig;
  for (const includePath of params.includeWriteThroughPaths) {
    const segments = [...includePath];
    const nextValue = getPathValue(nextConfig, segments);
    const sourceValue = getPathValue(params.sourceConfig, segments);
    const runtimeValue = getPathValue(params.runtimeConfig, segments);
    if (
      nextValue === undefined ||
      isDeepStrictEqual(nextValue, sourceValue) ||
      isDeepStrictEqual(nextValue, runtimeValue)
    ) {
      continue;
    }
    params.pendingIncludeWrites.push({ includePath: segments, value: nextValue });
    const restoreValue = sourceValue !== undefined ? sourceValue : runtimeValue;
    if (restoreValue !== undefined) {
      nextConfig = setPathValue(nextConfig, segments, restoreValue);
    }
  }
  return nextConfig;
}

export function formatJsonFileValue(value: unknown): string {
  rejectConfigNonFiniteNumbers(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type RootBoundIncludeFile = {
  absolutePath: string;
  relativePath: string;
  root: FsSafeRoot;
};

async function resolveRootBoundIncludeFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
}): Promise<RootBoundIncludeFile> {
  const absolutePath = resolveConfigIncludeWritePath(params);
  const candidateRoots = [path.dirname(params.configPath), ...params.allowedRoots];
  for (const candidateRoot of candidateRoots) {
    const rootReal = await fs.realpath(candidateRoot).catch(() => null);
    if (!rootReal || !isPathInside(rootReal, absolutePath)) {
      continue;
    }
    const relativePath = path.relative(rootReal, absolutePath);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.split(path.sep)[0] === ".."
    ) {
      continue;
    }
    return {
      absolutePath,
      relativePath,
      root: await createFsRoot(rootReal, {
        hardlinks: "reject",
        mkdir: true,
        mode: 0o600,
        symlinks: "reject",
      }),
    };
  }
  throw new Error(`Config include write path has no approved existing root: ${absolutePath}`);
}

export async function resolveExpectedRootBoundIncludeFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
  expectedAbsolutePath: string;
}): Promise<RootBoundIncludeFile> {
  let target: RootBoundIncludeFile;
  try {
    target = await resolveRootBoundIncludeFile(params);
  } catch (error) {
    if (
      error instanceof ConfigIncludeError ||
      (error instanceof Error &&
        error.message.startsWith("Config include write path has no approved existing root:"))
    ) {
      throw new ConfigMutationConflictError("included config target changed since last load");
    }
    throw error;
  }
  if (path.normalize(target.absolutePath) !== path.normalize(params.expectedAbsolutePath)) {
    throw new ConfigMutationConflictError("included config target changed since last load");
  }
  return target;
}

export async function readRootBoundFileRawIfExists(
  target: RootBoundIncludeFile,
): Promise<string | null> {
  try {
    return await target.root.readText(target.relativePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

export async function rollbackJsonFileWriteIfUnchanged(params: {
  target: RootBoundIncludeFile;
  previousRaw: string | null;
  committedRaw: string | null;
  assertCurrent?: () => void;
}): Promise<boolean> {
  return await rollbackConfigFileWriteIfUnchanged({
    configPath: params.target.absolutePath,
    previousSnapshot: {
      path: params.target.absolutePath,
      exists: params.previousRaw !== null,
      raw: params.previousRaw,
    },
    // rollbackConfigFileWriteIfUnchanged compares the CURRENT file via
    // hashConfigRaw (io.write-safety.ts:343), not hashConfigIncludeRaw --
    // the two hash different byte layouts for the same non-null input.
    committedHash: hashConfigRaw(params.committedRaw),
    fsModule: fsNode,
    assertCurrent: params.assertCurrent,
    preserveDirectoryMode: true,
    durable: true,
    destinationHardlinks: "reject",
  });
}

export type StagedIncludeWrite = {
  includePath: string[];
  targetPath: string;
  bytes: string;
  previousRaw: string | null;
  previousHash: string;
};

/** Pure staging: no disk writes. Resolves ownership/target from provenance,
 * refuses external targets, reads the current raw + hash fence, and projects
 * the pending delta onto the AUTHORED include value so ${VAR} placeholders
 * survive (finding 3) instead of ever serializing the resolved config. */
// Both windows are fenced: snapshot-to-stage via the caller's load-time
// include hashes (snapshotIncludeHashes/Targets, when the load captured them)
// and stage-to-publish via previousHash re-hashed under the publish lock.
export type StagedIncludeWriteResult = {
  staged: StagedIncludeWrite[];
  // Keyed by normalized target path; feeds context.resolveRuntimePreflightSourceConfig
  // so validation/revision-hashing see the bytes publish will produce.
  overlay: ReadonlyMap<string, string> | undefined;
};

export async function stageIncludeWriteThrough(params: {
  snapshot: { path: string; includeProvenance?: readonly ConfigIncludeOwnership[] };
  pendingIncludeWrites: readonly PendingIncludeWrite[];
  envForRestore: NodeJS.ProcessEnv;
  // Load-time include hashes/targets (caller-captured or snapshot-read),
  // keyed by normalized lexical include path -> hash / canonical target.
  snapshotIncludeHashes?: Record<string, string>;
  snapshotIncludeTargets?: Record<string, string>;
}): Promise<StagedIncludeWriteResult> {
  const staged: StagedIncludeWrite[] = [];
  for (const pending of params.pendingIncludeWrites) {
    const ownership = params.snapshot.includeProvenance?.find(
      (entry) =>
        includeConfigPathsEqual(entry.path, pending.includePath) &&
        typeof entry.targetPath === "string",
    );
    const targetPath = ownership?.targetPath;
    if (!targetPath) {
      throw createConfigIncludeOwnershipError({
        ownedConfigPath: pending.includePath.join("."),
      });
    }
    if (
      !isInternalIncludeWriteTarget({
        configPath: params.snapshot.path,
        includePath: targetPath,
      })
    ) {
      throw new Error(
        `Config mutation cannot update external $include target ${targetPath}; edit the included file directly or move it under the config directory.`,
      );
    }
    const target = await resolveExpectedRootBoundIncludeFile({
      configPath: params.snapshot.path,
      includePath: targetPath,
      allowedRoots: [],
      expectedAbsolutePath: targetPath,
    });
    const previousRaw = await readRootBoundFileRawIfExists(target);
    const previousHash = hashConfigIncludeRaw(previousRaw);
    // Snapshot-to-stage fence: the pending value was computed against the
    // load-time snapshot, so an include edited since load must conflict here
    // instead of being overwritten with a stale projection.
    if (params.snapshotIncludeHashes && params.snapshotIncludeTargets) {
      const loadKey = Object.keys(params.snapshotIncludeTargets).find(
        (key) =>
          path.normalize(params.snapshotIncludeTargets![key] ?? "") ===
          path.normalize(target.absolutePath),
      );
      const loadHash = loadKey === undefined ? undefined : params.snapshotIncludeHashes[loadKey];
      if (loadHash !== undefined && loadHash !== previousHash) {
        throw new ConfigMutationConflictError("included config changed since last load");
      }
    }
    let authoredIncludeValue: unknown;
    if (previousRaw !== null) {
      authoredIncludeValue = parseJsonWithJson5Fallback(previousRaw);
    }
    const stagedValue = restoreEnvVarRefs(
      pending.value,
      authoredIncludeValue,
      params.envForRestore,
    );
    staged.push({
      includePath: pending.includePath,
      targetPath: target.absolutePath,
      bytes: formatJsonFileValue(stagedValue),
      previousRaw,
      previousHash,
    });
  }
  return {
    staged,
    overlay:
      staged.length > 0
        ? new Map(staged.map((entry) => [path.normalize(entry.targetPath), entry.bytes]))
        : undefined,
  };
}

export type IncludeWriteRestorer = {
  targetPath: string;
  previousRaw: string | null;
  committedRaw: string | null;
  // Same hardlink/inode identity proof publish itself relied on, carried
  // forward so restore verifies the file is still the one it wrote.
  pathProof: ReturnType<typeof captureConfigFileWritePathProof>;
};

/** Publish inside the caller's commit window, before the root file. Per
 * target: re-resolve (target moved/symlinked since stage -> conflict),
 * re-hash-fence against previousHash (concurrent edit -> conflict), durable
 * temp-file+rename write, then push the restorer immediately so a throw at
 * entry N leaves 1..N-1 restorable. */
export async function publishStagedIncludeWrites(params: {
  staged: readonly StagedIncludeWrite[];
  restorers: IncludeWriteRestorer[];
  configPath: string;
  assertConfigPathForWrite?: () => void;
  skipOutputLogs?: boolean;
}): Promise<void> {
  const ordered = params.staged.toSorted((a, b) => a.targetPath.localeCompare(b.targetPath));
  for (const entry of ordered) {
    await withConfigWriteLock(entry.targetPath, async () => {
      params.assertConfigPathForWrite?.();
      const target = await resolveExpectedRootBoundIncludeFile({
        configPath: params.configPath,
        includePath: entry.targetPath,
        allowedRoots: [],
        expectedAbsolutePath: entry.targetPath,
      });
      const currentRaw = await readRootBoundFileRawIfExists(target);
      if (hashConfigIncludeRaw(currentRaw) !== entry.previousHash) {
        throw new ConfigMutationConflictError("included config changed while preparing write");
      }
      const pathProof = captureConfigFileWritePathProof(
        entry.targetPath,
        target.absolutePath,
        fsNode,
      );
      const assertCurrent = () => {
        params.assertConfigPathForWrite?.();
        pathProof.assertCurrent();
      };
      warnIfJSON5CommentsWillBeStripped({
        raw: currentRaw,
        filePath: target.absolutePath,
        skipOutputLogs: params.skipOutputLogs,
      });
      const guardedFs = createGuardedConfigFileSystem(target.absolutePath, fsNode, assertCurrent, {
        snapshot: { path: target.absolutePath, exists: currentRaw !== null, raw: currentRaw },
        includeGraph: { hashes: {}, targets: {} },
        targetPathProof: pathProof,
        preserveDirectoryMode: true,
      });
      await using preparedFile = await prepareConfigFileWrite({
        configPath: target.absolutePath,
        previousRaw: currentRaw,
        content: entry.bytes,
        fsModule: guardedFs,
        assertCurrent,
        destinationHardlinks: "reject",
        durable: true,
      });
      preparedFile.publish();
      params.restorers.push({
        targetPath: target.absolutePath,
        previousRaw: entry.previousRaw,
        committedRaw: entry.bytes,
        pathProof,
      });
    });
  }
}

/** Restore-only-if-unchanged, reverse publish order. An external edit made
 * after publish survives (rollbackJsonFileWriteIfUnchanged compares current
 * bytes to committedRaw before restoring previousRaw). Failures aggregate;
 * the original failure that triggered restoration always stays primary. */
export async function restoreStagedIncludeWrites(
  restorers: readonly IncludeWriteRestorer[],
  params: { configPath: string; assertConfigPathForWrite?: () => void },
): Promise<void> {
  const failures: unknown[] = [];
  for (const restorer of restorers.toReversed()) {
    try {
      await withConfigWriteLock(restorer.targetPath, async () => {
        params.assertConfigPathForWrite?.();
        const target = await resolveExpectedRootBoundIncludeFile({
          configPath: params.configPath,
          includePath: restorer.targetPath,
          allowedRoots: [],
          expectedAbsolutePath: restorer.targetPath,
        });
        await rollbackJsonFileWriteIfUnchanged({
          target,
          previousRaw: restorer.previousRaw,
          committedRaw: restorer.committedRaw,
          assertCurrent: () => {
            params.assertConfigPathForWrite?.();
            restorer.pathProof.assertCurrent();
          },
        });
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Include restore failed for one or more targets");
  }
}

/** Same as restoreStagedIncludeWrites, but folds a restore failure onto the
 * caller's primary failure (original stays primary) instead of throwing --
 * for use inside an already-failed commit-window catch block. */
export async function restoreStagedIncludeWritesOrFold(
  restorers: readonly IncludeWriteRestorer[],
  failure: unknown,
  params: { configPath: string; assertConfigPathForWrite?: () => void },
): Promise<unknown> {
  try {
    await restoreStagedIncludeWrites(restorers, params);
    return failure;
  } catch (includeRestoreError) {
    return new AggregateError(
      [failure, includeRestoreError],
      `${formatErrorMessage(failure)} Include restore failed: ${formatErrorMessage(includeRestoreError)}`,
    );
  }
}
