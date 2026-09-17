import type { SessionEntryReadSource } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveSessionStoreCompatibilityAgentId,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenClawRegisteredAgentDatabases,
  readOpenClawAgentDatabaseRegistryToken,
} from "../state/openclaw-agent-db-registry-listing.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db-registry.js";
import {
  resolveGatewaySessionStoreLookupCandidates,
  resolveGatewaySessionStoreReadResults,
} from "./session-utils-store-lookup.js";

export type GatewaySessionStoreReadSources = Record<string, readonly SessionEntryReadSource[]>;

/** Bind candidate addresses once; registry metadata uses its existing invalidation owner. */
export function prepareGatewaySessionStoreReadSources(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  registryPath: string;
}): { sources: GatewaySessionStoreReadSources; assertCurrent: () => void } {
  const registryOptions = { env: params.env, path: params.registryPath };
  const registryToken = readOpenClawAgentDatabaseRegistryToken(registryOptions);
  const assertCurrent = () => {
    if (readOpenClawAgentDatabaseRegistryToken(registryOptions) !== registryToken) {
      throw new Error("Session store changed while preparing its metadata. Retry the request.");
    }
  };
  let registered: ReturnType<typeof listOpenClawRegisteredAgentDatabases>;
  try {
    registered = listOpenClawRegisteredAgentDatabases(registryOptions);
  } catch {
    return { sources: {}, assertCurrent };
  }
  const agentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg),
    ...registered.map((entry) => entry.agentId),
  ]);
  const sources = new Map<string, readonly SessionEntryReadSource[]>();
  const isSameDatabasePath = createOpenClawAgentDatabasePathMatcher();
  for (const agentId of agentIds) {
    try {
      const { candidates, readSources } = resolveGatewaySessionStoreLookupCandidates({
        ...params,
        agentId,
        registeredDatabases: registered,
      });
      const resolved: SessionEntryReadSource[] = [];
      if (readSources) {
        for (const source of readSources) {
          if (
            !resolved.some(
              (candidate) =>
                candidate.agentId === source.agentId &&
                isSameDatabasePath(candidate.path, source.path),
            )
          ) {
            resolved.push(source);
          }
        }
        sources.set(agentId, resolved);
        continue;
      }
      for (const candidate of candidates) {
        const target = resolveSqliteTargetFromSessionStorePath(candidate.storePath, {
          agentId: candidate.agentId,
          defaultAgentId: resolveSessionStoreCompatibilityAgentId(params.cfg),
          env: params.env,
          registeredDatabases: registered,
          isSameDatabasePath,
        });
        if (target.ownerSource === "ambiguous-registry") {
          resolved.length = 0;
          break;
        }
        if (!resolved.some((source) => isSameDatabasePath(source.path, target.path))) {
          resolved.push({ agentId: target.agentId ?? candidate.agentId, path: target.path });
        }
      }
      sources.set(agentId, resolved);
    } catch {
      // Auxiliary lineage follows the existing unavailable-store-as-no-rows contract.
      sources.set(agentId, []);
    }
  }
  return {
    sources: Object.fromEntries(sources),
    assertCurrent,
  };
}

/** Auxiliary metadata never chooses one of several matching canonical source rows. */
export function readGatewaySessionEntryFromSources(
  sessionKey: string,
  sources: readonly SessionEntryReadSource[],
  current?: { source: SessionEntryReadSource; entry: SessionEntry | undefined },
): SessionEntry | undefined {
  if (sources.length === 0) {
    return undefined;
  }
  const selected = resolveGatewaySessionStoreReadResults({
    canonicalKey: sessionKey,
    scanTargets: [sessionKey],
    deferCanonicalValidation: true,
    reads: sources.map((source) => ({
      agentId: source.agentId,
      storePath: source.path,
      readSource: source,
      ...(current &&
      source.path === current.source.path &&
      source.agentId === current.source.agentId
        ? { store: current.entry ? { [sessionKey]: current.entry } : {} }
        : {}),
      options: { readSource: source, readOnly: true, exactKeys: [sessionKey], projection: "list" },
    })),
  });
  return selected.canonicalValidationError ? undefined : selected.match?.entry;
}
