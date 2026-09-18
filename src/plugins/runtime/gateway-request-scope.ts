// Gateway request scope tracks request-local plugin runtime context across async work.
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PluginOrigin } from "../plugin-origin.types.js";
import type { DeclaredProviderOwnerIndex } from "../provider-owner-index.js";
import type { PluginRegistry } from "../registry-types.js";
import { getPluginRegistryState } from "../runtime-state.js";
import type { OpenClawPluginNodeWorkspace } from "../types.node-host.js";
import { getPluginRuntimeLoadContextState } from "./load-context-state.js";

type PluginRuntimeGatewayRequestScope = {
  /** Exact placement owner captured before the local harness begins. */
  assertNodeExecutionCurrent?: (request: {
    runId: string;
    agentId: string;
    nodeId: string;
    workspace: OpenClawPluginNodeWorkspace;
  }) => void;
  /** In-process admitted owner only; never projected into RPC parameters. */
  invokeWithSessionNodeAuthority?: <T>(
    request: {
      pluginId: string;
      command: string;
      source: "session-full" | "human-approved";
      nodeId: string;
      workspace: OpenClawPluginNodeWorkspace;
    },
    invoke: (assertCurrent: () => void, signal: AbortSignal) => Promise<T>,
  ) => Promise<T | undefined>;
  /** Closure-bound admitted owner used to validate placement grant bindings. */
  nodePlacementGrantAuthority?: {
    agentId: string;
    sessionKey: string;
    runId: string;
    assertCurrent: (request: {
      pluginId: string;
      command: string;
      nodeId: string;
      workspace: OpenClawPluginNodeWorkspace;
    }) => void;
  };
  context?: GatewayRequestContext;
  resolveGatewayContext?: GatewayContextResolver;
  client?: GatewayRequestOptions["client"];
  isWebchatConnect: GatewayRequestOptions["isWebchatConnect"];
  pluginId?: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
  gatewayMethodDispatchAllowed?: boolean;
  pluginRegistry?: PluginRegistry;
  declaredProviderOwners?: DeclaredProviderOwnerIndex;
};

type PluginRuntimePluginScope = {
  pluginId: string;
  pluginSource?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
};

// Resolve through Node's private package import, not a bundled/source-aliased import.
// This keeps lease mutation private while source hosts and built plugin chunks share it.
type RequestAuthority = typeof import("../../../plugin-request-authority.cjs");
const require = createRequire(import.meta.url);
// SAFETY: the private package import resolves the shipped native module with this declaration.
const requestAuthority = require("#plugin-request-authority") as RequestAuthority;

const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGatewayRequestScope",
);
const GATEWAY_CONTEXT_RESOLVERS_KEY: unique symbol = Symbol.for("openclaw.gatewayContextResolvers");

const pluginRuntimeGatewayRequestScope = resolveGlobalSingleton<
  AsyncLocalStorage<PluginRuntimeGatewayRequestScope>
>(
  PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY,
  () => new AsyncLocalStorage<PluginRuntimeGatewayRequestScope>(),
);
// Built plugin chunks and source Gateway code must redeem the same host-issued owner bindings.
const gatewayContextResolvers = resolveGlobalSingleton<WeakMap<object, GatewayContextResolver>>(
  GATEWAY_CONTEXT_RESOLVERS_KEY,
  () => new WeakMap(),
);
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * True only while the host request callback that admitted `scope` with an authenticated
 * client is still running. Gateway lifetime, retained scope objects, and continuations armed
 * inside a finished request do not qualify.
 */
export function hasLivePluginRuntimeRequestAuthority(
  scope: PluginRuntimeGatewayRequestScope | undefined = pluginRuntimeGatewayRequestScope.getStore(),
): boolean {
  return requestAuthority.has(scope);
}

export function bindGatewayContextResolver(
  owner: object,
  resolver: GatewayContextResolver | undefined,
): void {
  if (resolver) {
    gatewayContextResolvers.set(owner, resolver);
  }
}

export const getGatewayContextResolver = (owner: object) => gatewayContextResolvers.get(owner);

/** Follows explicit wrapper ownership without invoking any execution resolver. */
export function getCanonicalGatewayContextResolver(
  resolver: GatewayContextResolver,
): GatewayContextResolver | undefined {
  const seen = new Set<GatewayContextResolver>();
  let current = resolver;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = gatewayContextResolvers.get(current);
    if (!parent) {
      return current;
    }
    current = parent;
  }
  return undefined;
}

/** Match the host owner without invoking a possibly retired execution resolver. */
export function hasGatewayContextOwner(
  owner: object,
  gatewayOwner: GatewayContextResolver,
): boolean {
  const resolver = gatewayContextResolvers.get(owner);
  // A lifetime wrapper records one canonical host owner; it remains the execution binding.
  return (
    resolver !== undefined && (gatewayContextResolvers.get(resolver) ?? resolver) === gatewayOwner
  );
}

export const clearGatewayContextResolver = (owner: object) => gatewayContextResolvers.delete(owner);

/** Carry only closure-bound node authorities into a nested request scope. */
export function getPluginRuntimeGatewayNodeAuthorities() {
  const scope = pluginRuntimeGatewayRequestScope.getStore();
  return {
    invokeWithSessionNodeAuthority: scope?.invokeWithSessionNodeAuthority,
    nodePlacementGrantAuthority: scope?.nodePlacementGrantAuthority,
  };
}

export function getSharedGatewayContextResolver(
  owners: readonly object[],
): GatewayContextResolver | undefined {
  const resolvers = owners.map(getGatewayContextResolver);
  if (resolvers.every((resolve) => !resolve)) {
    return undefined;
  }
  // Separate caller wrappers may own one instance. Recheck every captured fence;
  // never replace it with a current global resolver or permit mixed ambient routing.
  const shared = () => {
    const contexts = resolvers.map((resolve) => {
      try {
        return resolve?.();
      } catch {
        return undefined;
      }
    });
    if (resolvers.some((resolve) => !resolve)) {
      throw new Error("incompatible Gateway bindings: bound and unbound owners");
    }
    if (contexts.some((context) => !context)) {
      return undefined;
    }
    if (contexts.some((context) => context !== contexts[0])) {
      throw new Error("incompatible Gateway instances");
    }
    return contexts[0];
  };
  const canonical = resolvers.map((resolve) =>
    resolve ? getCanonicalGatewayContextResolver(resolve) : undefined,
  );
  const owner = canonical[0];
  if (owner && canonical.every((candidate) => candidate === owner)) {
    bindGatewayContextResolver(shared, owner);
  }
  return shared;
}

/**
 * Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
 * The request lease lives exactly as long as `run`: released synchronously for a plain
 * return or throw, otherwise when the returned promise settles.
 */
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => Promise<T>,
): Promise<T>;
export function withPluginRuntimeGatewayRequestScope<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
): T;
export function withPluginRuntimeGatewayRequestScope(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => unknown,
): unknown {
  const scoped: PluginRuntimeGatewayRequestScope = { ...scope };
  const release = requestAuthority.mint(scoped, scope.client !== undefined);
  let result: unknown;
  try {
    result = pluginRuntimeGatewayRequestScope.run(scoped, run);
    // Inspecting a thenable can itself throw (getter/proxy). Release in that case too.
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(release);
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

/** Runs detached work with its captured Gateway binding, including an explicitly unbound owner. */
export function withPluginRuntimeGatewayContextResolver<T>(
  resolveGatewayContext: GatewayContextResolver | undefined,
  run: () => T,
  options?: { inheritRequestScope?: boolean },
): T {
  // Scheduler-owned work must not retain the request-local client or context
  // that happened to exist when its timer was armed.
  const current =
    options?.inheritRequestScope === false
      ? undefined
      : pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = {
    ...current,
    isWebchatConnect: current?.isWebchatConnect ?? (() => false),
    resolveGatewayContext,
  };
  delete scoped.context;
  requestAuthority.inherit(current, scoped);
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/** Runs work against an owned registry handle while preserving any gateway request facts. */
export function withPluginRuntimeRegistryScope<T>(
  registry: PluginRegistry | undefined,
  run: () => T,
  declaredProviderOwners?: DeclaredProviderOwnerIndex,
): T {
  if (!registry) {
    return run();
  }
  const current = pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = {
    isWebchatConnect: () => false,
    ...current,
    pluginRegistry: registry,
    declaredProviderOwners:
      declaredProviderOwners ?? getPluginRuntimeLoadContextState(registry)?.declaredProviderOwners,
  };
  requestAuthority.inherit(current, scoped);
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginScope<T>(scope: PluginRuntimePluginScope, run: () => T): T {
  const current = pluginRuntimeGatewayRequestScope.getStore();
  const scoped: PluginRuntimeGatewayRequestScope = current
    ? { ...current, pluginId: scope.pluginId }
    : {
        pluginId: scope.pluginId,
        isWebchatConnect: () => false,
      };
  if (scope.pluginSource !== undefined) {
    scoped.pluginSource = scope.pluginSource;
  } else {
    delete scoped.pluginSource;
  }
  if (scope.pluginOrigin !== undefined) {
    scoped.pluginOrigin = scope.pluginOrigin;
  } else {
    delete scoped.pluginOrigin;
  }
  if (scope.pluginTrustedOfficialInstall !== undefined) {
    scoped.pluginTrustedOfficialInstall = scope.pluginTrustedOfficialInstall;
  } else {
    delete scoped.pluginTrustedOfficialInstall;
  }
  requestAuthority.inherit(current, scoped);
  return pluginRuntimeGatewayRequestScope.run(scoped, run);
}

/**
 * Runs work under the current gateway request scope while attaching plugin identity.
 */
export function withPluginRuntimePluginIdScope<T>(pluginId: string, run: () => T): T {
  return withPluginRuntimePluginScope({ pluginId }, run);
}

/**
 * Returns the current plugin gateway request scope when called from a plugin request handler.
 */
export function getPluginRuntimeGatewayRequestScope():
  | PluginRuntimeGatewayRequestScope
  | undefined {
  return pluginRuntimeGatewayRequestScope.getStore();
}

/** Reads registration/request/active registry precedence without initializing a cold runtime. */
export function getPluginRegistryForContext(): PluginRegistry | null {
  const state = getPluginRegistryState();
  return (
    state?.registrationContext?.registry ??
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
    state?.activeRegistry ??
    null
  );
}
