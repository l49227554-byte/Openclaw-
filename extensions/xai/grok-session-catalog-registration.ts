import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import {
  grokSessionStoreAvailable,
  grokUsesProcessHomeFallback,
  isExactGrokSessionCursor,
  listLocalGrokSessionPage,
  readLocalGrokTranscriptPage,
} from "./grok-session-catalog.js";

const LOCAL_HOST_ID = "gateway";

function isGrokSessionCatalogEnabled(pluginConfig: unknown): boolean {
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return false;
  }
  const sessionCatalog = (pluginConfig as { sessionCatalog?: unknown }).sessionCatalog;
  return Boolean(
    sessionCatalog &&
    typeof sessionCatalog === "object" &&
    (sessionCatalog as { enabled?: unknown }).enabled === true,
  );
}

export function registerGrokSessionCatalog(api: OpenClawPluginApi): void {
  if (!isGrokSessionCatalogEnabled(api.pluginConfig)) {
    return;
  }
  const catalog = createGrokSessionCatalogRuntime();
  const provider: SessionCatalogProvider = {
    id: "grok",
    label: "Grok Build",
    supportsProcessHomeIsolation: true,
    list: async (query) => await catalog.list(query),
    read: async (request) => await catalog.read(request),
  };
  api.registerSessionCatalog(provider);
}

export function createGrokSessionCatalogRuntime(): Pick<SessionCatalogProvider, "list" | "read"> {
  return {
    list: async (params) => {
      const requested = params.hostIds ? new Set(params.hostIds) : undefined;
      if (requested && !requested.has(LOCAL_HOST_ID)) {
        return [];
      }
      if (
        (params.allowProcessHomeFallback === false && grokUsesProcessHomeFallback(process.env)) ||
        !grokSessionStoreAvailable(process.env)
      ) {
        return [];
      }
      try {
        const page = await listLocalGrokSessionPage({
          limit: params.limitPerHost,
          ...(params.search ? { searchTerm: params.search } : {}),
          cursor: params.cursors?.[LOCAL_HOST_ID],
        });
        const host = {
          hostId: LOCAL_HOST_ID,
          label: "Local Grok Build",
          kind: "gateway" as const,
          connected: true,
          ...page,
        };
        params.onHost?.(host);
        return [host];
      } catch {
        const host = {
          hostId: LOCAL_HOST_ID,
          label: "Local Grok Build",
          kind: "gateway" as const,
          connected: true,
          sessions: [],
          error: {
            code: "LOCAL_READ_FAILED" as const,
            message: "Local Grok Build sessions are unavailable",
          },
        };
        params.onHost?.(host);
        return [host];
      }
    },
    read: async (params) => {
      if (params.hostId !== LOCAL_HOST_ID) {
        throw new Error("Grok Build session catalog hostId is invalid");
      }
      if (
        (params.allowProcessHomeFallback === false && grokUsesProcessHomeFallback(process.env)) ||
        !grokSessionStoreAvailable(process.env)
      ) {
        throw new Error("Local Grok Build sessions are unavailable");
      }
      if (params.cursor !== undefined && !isExactGrokSessionCursor(params.cursor)) {
        throw new Error("cursor is invalid");
      }
      return await readLocalGrokTranscriptPage({
        threadId: params.threadId,
        ...(params.limit ? { limit: params.limit } : {}),
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      });
    },
  };
}
