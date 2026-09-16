import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { RetrySupervisor } from "../../packages/retry/src/index.js";
import { isChannelAccountExplicitlyDisabled } from "../channels/account-config-enabled.js";
import {
  getCredentialUnavailableDiagnostics,
  projectSafeChannelAccountSnapshotFields,
} from "../channels/account-snapshot-fields.js";
import {
  buildChannelAccountSnapshotFromInspection,
  buildChannelAccountSnapshotFromRuntime,
} from "../channels/account-summary.js";
import { isChannelIngressUnavailableError } from "../channels/message/ingress-unavailable.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getLoadedChannelPluginEntryById,
  listLoadedChannelPluginsForRegistry,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import {
  applyChannelAccountState,
  resolveChannelAccountState,
  resolveUnavailableChannelAccountSnapshot,
} from "../channels/status/account-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withGatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { startChannelApprovalHandlerBootstrap } from "../infra/approval-handler-bootstrap.js";
import { type BackoffPolicy, sleepWithAbort } from "../infra/backoff.js";
import {
  createTaskScopedChannelRuntime,
  registerChannelRuntimeContext,
} from "../infra/channel-runtime-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatGatewayCrashLoopManualChannelStartHint } from "../infra/gateway-boot-lifecycle.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../logging/subsystem.js";
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "../plugins/capability-lease.js";
import {
  createPluginHttpRouteHandoff,
  withPluginHttpRouteRegistry,
  type PluginHttpRouteHandoff,
} from "../plugins/http-registry.js";
import { runPluginCleanup } from "../plugins/plugin-instance-scope.js";
import { runOutsidePluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { runOutsidePluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  assertSecretOwnerAvailable,
  clearActiveCredentialDegradedOwner,
  SecretSurfaceUnavailableError,
  setActiveCredentialDegradedOwner,
} from "../secrets/runtime-degraded-state.js";
import { isAccountEnabled } from "../shared/account-enabled.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import type {
  ChannelAccountStartOutcome,
  ChannelRuntimeSnapshot,
  ChannelRuntimeSnapshotOptions,
  StartChannelOptions,
} from "./server-channel-runtime.types.js";

const RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
const MAX_RESTARTS = 10;
const CHANNEL_STABLE_RUN_MS = RESTART_POLICY.maxMs;
const CHANNEL_STOP_ABORT_TIMEOUT_MS = 5_000;
const CHANNEL_STARTUP_CONCURRENCY = 4;
// Private context key carried through the generic Plugin SDK registry. This is
// not a new public capability surface; only the host installs its authority.
const CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY = "approval.gateway";
function waitForChannelStartupHandoff(): Promise<void> {
  return new Promise((resolve) => {
    const handle = setImmediate(resolve);
    handle.unref?.();
  });
}

function isStopAccountTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === `stopAccount timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`
  );
}

type StopAccountFence = {
  settled: Promise<void>;
  timeoutError: Error;
  getLateError: () => unknown;
};

type ChannelRuntimeStore = {
  startFence?: {
    paused: boolean;
    snapshot?: {
      listedAccountIds: ReadonlySet<string>;
      read: () => {
        accounts: Record<string, ChannelAccountSnapshot>;
        defaultAccountId: string;
        defaultAccount: ChannelAccountSnapshot;
      };
    };
  };
  lifetimes: Map<string, ChannelAccountLifetime>;
  routeHandoffs: Map<
    string,
    { handoff: PluginHttpRouteHandoff; parkedBy: AbortController; admittedSignal?: AbortSignal }
  >;
  starting: Map<string, Promise<void>>;
  stops: Map<string, ChannelAccountStopState>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
  startEpochs: Map<string, number>;
  stopAccountFences: Map<string, StopAccountFence>;
};

function sanitizeAbortedTaskStatusPatch(
  patch: ChannelAccountSnapshot,
  current: ChannelAccountSnapshot,
): ChannelAccountSnapshot {
  const next = { ...patch };
  delete next.running;
  delete next.restartPending;
  delete next.reconnectAttempts;
  delete next.lastStartAt;
  delete next.lastStopAt;
  delete next.lifecycle;

  // A stale task may still emit a late "connected" heartbeat after the gateway
  // has already aborted it and marked restart recovery pending. Do not let that
  // old task make the stopped runtime look connected again.
  if (next.connected === true) {
    delete next.connected;
    delete next.lastConnectedAt;
    delete next.lastEventAt;
    delete next.lastTransportActivityAt;
  }

  // Preserve actionable lifecycle diagnostics (for example a stop-timeout
  // recovery error) against late stale-task status patches that merely clear
  // plugin transport errors.
  if (next.lastError === null && current.lastError) {
    delete next.lastError;
  }

  return next;
}

type HealthMonitorConfig = {
  healthMonitor?: {
    enabled?: boolean;
  };
};

type ChannelHealthMonitorConfig = HealthMonitorConfig & {
  accounts?: Record<string, HealthMonitorConfig>;
};

export type ChannelAutostartSuppression = {
  reason: "crash-loop-breaker";
  message: string;
};

type GatewayStartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    lifetimes: new Map(),
    routeHandoffs: new Map(),
    starting: new Map(),
    stops: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
    startEpochs: new Map(),
    stopAccountFences: new Map(),
  };
}

async function waitForChannelStopGracefully(task: Promise<unknown> | undefined, timeoutMs: number) {
  if (!task) {
    return true;
  }
  // Channel stop hooks can hang during provider disconnects. Bound the wait so
  // restart/reload can continue after aborting the runtime.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type ChannelManagerOptions = {
  getRuntimeConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  channelLogs: Partial<Record<ChannelId, SubsystemLogger>>;
  channelRuntimeEnvs: Partial<Record<ChannelId, RuntimeEnv>>;
  /** Supply the complete createPluginRuntime().channel surface; partial stubs are unsupported. */
  channelRuntime?: PluginRuntimeChannel;
  /** Resolve the same complete surface only when a channel account starts. */
  resolveChannelRuntime?: () => PluginRuntimeChannel | Promise<PluginRuntimeChannel>;
  startupTrace?: GatewayStartupTrace;
  deferStartupAccountStartsUntil?: Promise<void>;
  getNativeApprovalRuntime?: () => GatewayNativeApprovalRuntime | undefined;
  ambientAutostartSuppressedChannelIds?: ReadonlySet<string>;
  tryRecoverAutostartSuppression?: () => boolean;
  isClosing?: () => boolean;
};

type StopChannelOptions = {
  manual?: boolean;
  /**
   * Whether this stop should surface as pending restart/recovery in runtime state.
   * Non-manual stops still defer task-owned auto-restart to the caller; this
   * only controls whether health/recovery surfaces should treat the stopped
   * account as awaiting a queued replacement start.
   */
  restartPending?: boolean;
  /**
   * Keep stopped accounts visible to a paired includeKnownAccounts start without
   * marking them restartPending for health/recovery surfaces.
   */
  preserveKnownAccount?: boolean;
};

type ChannelAccountStopOutcome =
  | { status: "fulfilled"; stopAccountFenceSatisfied?: boolean }
  | { status: "rejected"; error: unknown };

type ChannelAccountStopState =
  | { status: "stopping"; attempt: Promise<ChannelAccountStopOutcome> }
  | Extract<ChannelAccountStopOutcome, { status: "rejected" }>;

async function waitForDeferredAccountStart(
  deferred: Promise<void>,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }
  await Promise.race([
    deferred,
    new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
}

export type ChannelManager = {
  getRuntimeSnapshot: (options?: ChannelRuntimeSnapshotOptions) => ChannelRuntimeSnapshot;
  pauseChannelStarts: (
    channelIds: Iterable<ChannelId>,
  ) => (outcome: "published" | "rollback", channelIds?: ReadonlySet<ChannelId>) => void;
  startChannels: () => Promise<void>;
  startChannel: (
    channel: ChannelId,
    accountId?: string,
    opts?: StartChannelOptions,
  ) => Promise<ReadonlyMap<string, ChannelAccountStartOutcome>>;
  stopChannel: (channel: ChannelId, accountId?: string, opts?: StopChannelOptions) => Promise<void>;
  releaseChannelRouteHandoffs: (channel: ChannelId, accountId?: string) => void;
  setAutostartSuppression: (suppression: ChannelAutostartSuppression | null) => void;
  getAutostartSuppression: () => ChannelAutostartSuppression | null;
  recoverAutostartSuppression: () => Promise<boolean>;
  setAmbientAutostartSuppressedChannelIds: (channelIds: ReadonlySet<string>) => void;
  isAmbientAutostartSuppressed: (channelId: string) => boolean;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  isAccountListed: (channelId: ChannelId, accountId: string) => boolean;
  isAutoRestartScheduled: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isHealthMonitorEnabled: (channelId: ChannelId, accountId: string) => boolean;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager & {
  pruneInactiveChannelAccountState: (activeChannelIds: ReadonlySet<ChannelId>) => void;
  resolveRuntimeAccountId: (channelId: ChannelId, accountId: string) => string | undefined;
  hasCurrentAccountTask: (channelId: ChannelId, accountId: string) => boolean;
} {
  const {
    getRuntimeConfig,
    channelLogs,
    channelRuntimeEnvs,
    channelRuntime,
    resolveChannelRuntime,
    getPluginRegistry,
    startupTrace,
  } = opts;

  // Each operation retains its Gateway's registry; later retries select its successor.
  // Ambient request or process registries may belong to another live Gateway.
  const withRegistry = <T>(run: (registry: PluginRegistry) => T): T => {
    const registry = getPluginRegistry();
    return withPluginRuntimeRegistryScope(registry, () => run(registry));
  };
  const getChannelPlugin = (channelId: ChannelId) =>
    getLoadedChannelPluginEntryById(channelId, getPluginRegistry())?.plugin;
  const cloneDefaultRuntime = (
    channelId: ChannelId,
    accountId: string,
  ): ChannelAccountSnapshot => ({
    ...getChannelPlugin(channelId)?.status?.defaultRuntime,
    accountId,
  });

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  const restarts = new Map<string, RetrySupervisor>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();
  // Tracks stop/restart handoffs where the caller owns the restart, such as hot reload.
  const restartDeferredToCaller = new Set<string>();
  const restartPendingDeferredToCaller = new Set<string>();
  // Tracks private caller-owned handoffs that should stay in includeKnownAccounts
  // restarts without surfacing as health-monitor restart candidates.
  const knownAccountDeferredToCaller = new Set<string>();
  const recoveryStopTimedOut = new Set<string>();
  const recoveryStartRequested = new Set<string>();
  // Accounts whose crash recovery is already owned by the retry supervisor below
  // (backoff sleep plus its replacement start). `restartPending` cannot answer
  // this: the timed-out-stop recovery sets it too, and that one needs the health
  // monitor to keep driving it.
  const pendingAutoRestarts = new Set<string>();
  let autostartSuppression: ChannelAutostartSuppression | null = null;
  let ambientAutostartSuppressedChannelIds = new Set(
    opts.ambientAutostartSuppressedChannelIds ?? [],
  );

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;
  const releaseRouteHandoff = (
    store: ChannelRuntimeStore,
    accountId: string,
    expected = store.routeHandoffs.get(accountId),
  ): void => {
    if (expected && store.routeHandoffs.get(accountId) === expected) {
      expected.handoff.release();
      store.routeHandoffs.delete(accountId);
    }
  };
  const releaseChannelRouteHandoffs = (channelId: ChannelId, accountId?: string): void => {
    const store = getStore(channelId);
    for (const id of accountId ? [accountId] : store.routeHandoffs.keys()) {
      const admittedSignal = store.routeHandoffs.get(id)?.admittedSignal;
      // Partial rollback must preserve ingress owned by an admitted sibling.
      if (!admittedSignal || admittedSignal.aborted) {
        releaseRouteHandoff(store, id);
      }
    }
  };
  const ensureChannelLog = (channelId: ChannelId): SubsystemLogger => {
    channelLogs[channelId] ??= createSubsystemLogger("channels").child(channelId);
    return channelLogs[channelId];
  };
  const ensureChannelRuntime = (channelId: ChannelId): RuntimeEnv => {
    channelRuntimeEnvs[channelId] ??= runtimeForLogger(ensureChannelLog(channelId));
    return channelRuntimeEnvs[channelId];
  };

  const resolveAccountHealthMonitorOverride = (
    channelConfig: ChannelHealthMonitorConfig | undefined,
    channelId: ChannelId,
    accountId: string,
  ): boolean | undefined => {
    if (!channelConfig?.accounts) {
      return undefined;
    }
    const direct = resolveChannelAccountEntry(channelConfig.accounts, accountId, channelId);
    if (typeof direct?.healthMonitor?.enabled === "boolean") {
      return direct.healthMonitor.enabled;
    }
    const normalizedAccountId = normalizeOptionalAccountId(accountId);
    if (!normalizedAccountId) {
      return undefined;
    }
    const match = resolveChannelAccountEntry(
      channelConfig.accounts,
      normalizedAccountId,
      channelId,
      normalizeAccountId,
    );
    if (typeof match?.healthMonitor?.enabled !== "boolean") {
      return undefined;
    }
    return match.healthMonitor.enabled;
  };

  const isHealthMonitorEnabled = (channelId: ChannelId, accountId: string): boolean => {
    if (knownAccountDeferredToCaller.has(restartKey(channelId, accountId))) {
      return false;
    }

    const cfg = getRuntimeConfig();
    const channelConfig = cfg.channels?.[channelId] as ChannelHealthMonitorConfig | undefined;
    const accountOverride = resolveAccountHealthMonitorOverride(
      channelConfig,
      channelId,
      accountId,
    );
    const channelOverride = channelConfig?.healthMonitor?.enabled;

    if (typeof accountOverride === "boolean") {
      return accountOverride;
    }

    if (typeof channelOverride === "boolean") {
      return channelOverride;
    }

    return true;
  };

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next = createRuntimeStore();
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const hasExplicitReadyRecovery =
      Object.hasOwn(patch, "lifecycle") &&
      patch.lifecycle === "ready" &&
      Object.hasOwn(patch, "terminalDisconnect") &&
      patch.terminalDisconnect === undefined;
    // Weaker/derived signals never clear a terminal diagnosis. Gateway-owned starting still
    // begins a new lifecycle; a channel-authored explicit ready + terminal clear proves recovery.
    const lifecycle =
      current.lifecycle === "blocked" &&
      current.terminalDisconnect === true &&
      patch.lifecycle !== "starting" &&
      !hasExplicitReadyRecovery
        ? "blocked"
        : (patch.lifecycle ??
          (patch.restartPending === true
            ? "recovering"
            : patch.connected === true
              ? "ready"
              : undefined));
    const next = { ...current, ...patch, ...(lifecycle ? { lifecycle } : {}), accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const setRuntimeFromTaskStatus = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
    abortSignal: AbortSignal,
  ): ChannelAccountSnapshot => {
    const safePatch = abortSignal.aborted
      ? sanitizeAbortedTaskStatusPatch(patch, getRuntime(channelId, accountId))
      : patch;
    const next = setRuntime(channelId, accountId, safePatch);
    // Ready follows all ingress registrations; terminal startup may wait for abort.
    // Retire on this task's terminal report, never an inherited diagnosis.
    if (!abortSignal.aborted && (next.lifecycle === "ready" || patch.terminalDisconnect === true)) {
      releaseRouteHandoff(getStore(channelId), accountId);
    }
    return next;
  };

  const setStoppedRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: Omit<ChannelAccountSnapshot, "accountId" | "running"> = {},
  ): ChannelAccountSnapshot => {
    const current = getRuntime(channelId, accountId);
    return setRuntime(channelId, accountId, {
      accountId,
      running: false,
      lifecycle: patch.restartPending === true ? "recovering" : "stopped",
      ...(typeof current.connected === "boolean" ? { connected: false } : {}),
      ...patch,
    });
  };

  const getChannelRuntime = async (): Promise<PluginRuntimeChannel | undefined> => {
    if (channelRuntime) {
      return channelRuntime;
    }
    return await resolveChannelRuntime?.();
  };
  const createAccountContext = (
    channelId: ChannelId,
    accountId: string,
    cfg: OpenClawConfig,
    account: unknown,
    abortSignal: AbortSignal,
  ): Omit<ChannelGatewayContext, "setStatus"> => ({
    cfg,
    accountId,
    account,
    abortSignal,
    runtime: ensureChannelRuntime(channelId),
    log: ensureChannelLog(channelId),
    getStatus: () => getRuntime(channelId, accountId),
  });
  const measureStartup = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    return startupTrace ? startupTrace.measure(name, run) : await run();
  };

  const listKnownLiveAccountIds = (
    channelId: ChannelId,
    store: ChannelRuntimeStore,
    options: { includeKnownAccountHandoffs?: boolean } = {},
  ): string[] => {
    const known = new Set<string>();
    const includeKnownAccountHandoffs = options.includeKnownAccountHandoffs === true;
    const addKnownLifecycleId = (id: string) => {
      const rKey = restartKey(channelId, id);
      const snapshot = store.runtimes.get(id);
      if (!includeKnownAccountHandoffs && knownAccountDeferredToCaller.has(rKey)) {
        return;
      }
      if (
        recoveryStopTimedOut.has(rKey) &&
        snapshot?.restartPending !== true &&
        !(includeKnownAccountHandoffs && knownAccountDeferredToCaller.has(rKey))
      ) {
        return;
      }
      known.add(id);
    };
    for (const id of store.aborts.keys()) {
      addKnownLifecycleId(id);
    }
    for (const id of store.starting.keys()) {
      addKnownLifecycleId(id);
    }
    for (const id of store.tasks.keys()) {
      addKnownLifecycleId(id);
    }
    for (const [id, snapshot] of store.runtimes.entries()) {
      // `connected` can be stale after a clean stop. Treat only active or
      // explicitly handoff-pending accounts as known-live restart candidates.
      const rKey = restartKey(channelId, id);
      if (!includeKnownAccountHandoffs && knownAccountDeferredToCaller.has(rKey)) {
        continue;
      }
      if (
        snapshot.running ||
        snapshot.restartPending ||
        (includeKnownAccountHandoffs && knownAccountDeferredToCaller.has(rKey))
      ) {
        known.add(id);
      }
    }
    return [...known];
  };

  const evictStaleChannelAccountState = (
    channelId: ChannelId,
    store: ChannelRuntimeStore,
    accountIds: readonly string[],
  ) => {
    const activeAccountIds = new Set(accountIds);
    for (const id of store.routeHandoffs.keys()) {
      if (!activeAccountIds.has(id)) {
        releaseRouteHandoff(store, id);
      }
    }
    for (const id of store.runtimes.keys()) {
      if (
        activeAccountIds.has(id) ||
        store.lifetimes.has(id) ||
        store.starting.has(id) ||
        store.stops.has(id) ||
        store.tasks.has(id) ||
        store.stopAccountFences.has(id)
      ) {
        continue;
      }
      store.runtimes.delete(id);
      clearActiveCredentialDegradedOwner("account", restartKey(channelId, normalizeAccountId(id)));
      restarts.delete(restartKey(channelId, id));
      manuallyStopped.delete(restartKey(channelId, id));
      restartDeferredToCaller.delete(restartKey(channelId, id));
      restartPendingDeferredToCaller.delete(restartKey(channelId, id));
      knownAccountDeferredToCaller.delete(restartKey(channelId, id));
      recoveryStartRequested.delete(restartKey(channelId, id));
    }
  };

  const pruneInactiveChannelAccountState = (activeChannelIds: ReadonlySet<ChannelId>): void => {
    for (const [channelId, store] of channelStores) {
      if (!activeChannelIds.has(channelId)) {
        evictStaleChannelAccountState(channelId, store, []);
      }
    }
  };

  const startChannelProcessOwned = async (
    registry: PluginRegistry,
    channelId: ChannelId,
    accountId?: string,
    optsValue: StartChannelOptions = {},
  ) => {
    const registration = resolveChannelPluginRegistration(channelId);
    const plugin = registration?.plugin;
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      for (const id of accountId ? [accountId] : store.routeHandoffs.keys()) {
        releaseRouteHandoff(store, id);
      }
      return accountId
        ? new Map([[accountId, { status: "skipped", reason: "unsupported" }]])
        : new Map();
    }
    const {
      includeKnownAccounts = false,
      preserveRestartAttempts = false,
      preserveManualStop = false,
    } = optsValue;
    const cfg = getRuntimeConfig();
    resetDirectoryCache({ cfg, channel: channelId, accountId });
    const store = getStore(channelId);
    const listedAccountIds = accountId
      ? [accountId]
      : await measureStartup(`channels.${channelId}.list-accounts`, () =>
          plugin.config.listAccountIds(cfg),
        );
    const accountIds =
      accountId || !includeKnownAccounts
        ? listedAccountIds
        : Array.from(
            new Set([
              ...listedAccountIds,
              ...listKnownLiveAccountIds(channelId, store, {
                includeKnownAccountHandoffs: true,
              }),
            ]),
          );
    if (!accountId) {
      evictStaleChannelAccountState(channelId, store, accountIds);
    }
    if (accountIds.length === 0) {
      return new Map();
    }
    if (autostartSuppression && optsValue.manual !== true) {
      // Safe mode must block every automatic channel start surface; otherwise
      // config reloads can undo the crash-loop breaker while operators inspect.
      const suffix = accountId ? ` account ${accountId}` : "";
      ensureChannelLog(channelId).warn?.(
        `channel autostart suppressed by crash-loop breaker; refusing automatic start for ${channelId}${suffix}. ${formatGatewayCrashLoopManualChannelStartHint({ channelId, ...(accountId ? { accountId } : {}) })}`,
      );
      for (const id of accountIds) {
        const rKey = restartKey(channelId, id);
        restartDeferredToCaller.delete(rKey);
        restartPendingDeferredToCaller.delete(rKey);
        knownAccountDeferredToCaller.delete(rKey);
        recoveryStopTimedOut.delete(rKey);
        recoveryStartRequested.delete(rKey);
        restarts.delete(rKey);
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastError: autostartSuppression.message,
        });
      }
      return new Map(
        accountIds.map((id) => [
          id,
          { status: "skipped", reason: "autostart-suppressed" } as const,
        ]),
      );
    }
    if (ambientAutostartSuppressedChannelIds.has(channelId) && optsValue.manual !== true) {
      for (const id of accountIds) {
        const rKey = restartKey(channelId, id);
        restartDeferredToCaller.delete(rKey);
        restartPendingDeferredToCaller.delete(rKey);
        knownAccountDeferredToCaller.delete(rKey);
        recoveryStopTimedOut.delete(rKey);
        recoveryStartRequested.delete(rKey);
        restarts.delete(rKey);
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastError:
            "ambient channel credentials suppressed; configure the channel or start the gateway with --ambient-channels",
        });
      }
      return new Map(
        accountIds.map((id) => [id, { status: "skipped", reason: "ambient-suppressed" } as const]),
      );
    }

    const startOutcomes = new Map<string, ChannelAccountStartOutcome>();
    const startup = await runTasksWithConcurrency({
      limit: CHANNEL_STARTUP_CONCURRENCY,
      tasks: accountIds.map((id) => async () => {
        assertStartCurrent();
        const rKey = restartKey(channelId, id);
        // An in-flight plugin teardown may still own resources. A rejected stop
        // outcome only preserves diagnostics; a paired include-known rollback
        // start can retry after the aborted task has actually settled.
        let currentStop = store.stops.get(id);
        if (currentStop?.status === "stopping") {
          return;
        }
        let settledStopAccountFence = false;
        const stopAccountFence = store.stopAccountFences.get(id);
        if (stopAccountFence) {
          const stopAccountSettled = await waitForChannelStopGracefully(
            stopAccountFence.settled,
            CHANNEL_STOP_ABORT_TIMEOUT_MS,
          );
          if (!stopAccountSettled) {
            setRuntime(channelId, id, {
              accountId: id,
              restartPending: true,
              lastError: `stopAccount timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
            });
            throw new Error(`stopAccount timed out before restarting ${channelId} account ${id}`);
          }
          const lateStopAccountError = stopAccountFence.getLateError();
          if (lateStopAccountError !== undefined) {
            if (store.stopAccountFences.get(id) === stopAccountFence) {
              store.stopAccountFences.delete(id);
            }
            store.stops.set(id, { status: "rejected", error: lateStopAccountError });
            restartDeferredToCaller.delete(rKey);
            restartPendingDeferredToCaller.delete(rKey);
            knownAccountDeferredToCaller.delete(rKey);
            recoveryStopTimedOut.delete(rKey);
            recoveryStartRequested.delete(rKey);
            const lateStopAccountErrorMessage = formatErrorMessage(lateStopAccountError);
            setRuntime(channelId, id, {
              accountId: id,
              running: true,
              restartPending: false,
              lastError: lateStopAccountErrorMessage,
            });
            throw lateStopAccountError instanceof Error
              ? lateStopAccountError
              : new Error(lateStopAccountErrorMessage);
          }
          if (store.stopAccountFences.get(id) === stopAccountFence) {
            store.stopAccountFences.delete(id);
          }
          settledStopAccountFence = true;
          const currentStopAfterFence = store.stops.get(id);
          if (
            currentStopAfterFence?.status === "rejected" &&
            currentStopAfterFence.error === stopAccountFence.timeoutError
          ) {
            store.stops.delete(id);
          }
          currentStop = store.stops.get(id);
        }
        if (currentStop?.status === "stopping") {
          return;
        }
        const existingTask = store.tasks.get(id);
        const existingAbort = store.aborts.get(id);
        const abortedTask = existingAbort?.signal.aborted === true;
        const hasCallerDeferredStop = restartDeferredToCaller.has(rKey);
        const hasPairedKnownAccountDeferredStop = includeKnownAccounts && hasCallerDeferredStop;
        const currentStopIsDeferredTimeout =
          currentStop?.status === "rejected" && isStopAccountTimeoutError(currentStop.error);
        const hasSettledDeferredTimeout = currentStopIsDeferredTimeout && hasCallerDeferredStop;
        const hasClearedDeferredStop =
          currentStop === undefined && hasCallerDeferredStop && !store.stopAccountFences.has(id);
        const shouldRetryAfterSettledManualFenceTask =
          settledStopAccountFence &&
          !preserveManualStop &&
          manuallyStopped.has(rKey) &&
          abortedTask;
        const shouldRetryAfterCallerDeferredTask =
          (hasPairedKnownAccountDeferredStop ||
            hasSettledDeferredTimeout ||
            hasClearedDeferredStop ||
            shouldRetryAfterSettledManualFenceTask) &&
          abortedTask;
        if (
          currentStop?.status === "rejected" &&
          !hasPairedKnownAccountDeferredStop &&
          !hasSettledDeferredTimeout
        ) {
          return;
        }
        if (existingTask) {
          let clearedTimedOutRecoveryTask = false;
          if (shouldRetryAfterCallerDeferredTask) {
            const stoppedCleanly = await waitForChannelStopGracefully(
              existingTask,
              CHANNEL_STOP_ABORT_TIMEOUT_MS,
            );
            if (!stoppedCleanly) {
              recoveryStopTimedOut.add(rKey);
              setRuntime(channelId, id, {
                accountId: id,
                restartPending: true,
                lastError: `channel stop timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
              });
              throw new Error(
                `channel stop timed out before restarting ${channelId} account ${id}`,
              );
            }
            if (store.tasks.get(id) === existingTask) {
              store.tasks.delete(id);
            }
            if (store.aborts.get(id) === existingAbort) {
              store.aborts.delete(id);
            }
            if (currentStop?.status === "rejected") {
              store.stops.delete(id);
            }
            if (shouldRetryAfterSettledManualFenceTask) {
              manuallyStopped.delete(rKey);
            }
            if (store.tasks.has(id) || store.starting.has(id) || manuallyStopped.has(rKey)) {
              return;
            }
          } else {
            if (recoveryStopTimedOut.has(rKey)) {
              if (!preserveManualStop) {
                manuallyStopped.delete(rKey);
              }
              if (manuallyStopped.has(rKey)) {
                return;
              }
              // When a previous stop timed out and the health monitor is
              // requesting recovery again, clean up the stuck task so the
              // channel can actually restart instead of staying in limbo.
              if (recoveryStartRequested.has(rKey)) {
                recoveryStopTimedOut.delete(rKey);
                recoveryStartRequested.delete(rKey);
                restarts.delete(rKey);
                store.aborts.delete(id);
                store.tasks.delete(id);
                clearedTimedOutRecoveryTask = true;
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: false,
                  reconnectAttempts: 0,
                });
              } else {
                recoveryStartRequested.add(rKey);
                setRuntime(channelId, id, { accountId: id, restartPending: true });
                return;
              }
            }
            if (!clearedTimedOutRecoveryTask) {
              return;
            }
          }
        }
        if (
          currentStop?.status === "rejected" &&
          (hasPairedKnownAccountDeferredStop || hasSettledDeferredTimeout)
        ) {
          store.stops.delete(id);
          recoveryStopTimedOut.delete(rKey);
          recoveryStartRequested.delete(rKey);
        }
        const existingStart = store.starting.get(id);
        if (existingStart) {
          const shouldRetryAfterDeferredStart =
            includeKnownAccounts &&
            (getRuntime(channelId, id).restartPending === true ||
              knownAccountDeferredToCaller.has(rKey));
          await existingStart;
          if (
            !shouldRetryAfterDeferredStart ||
            // A stop can queue while this caller waits for the manager boundary of
            // an existing start. Let that stop finish teardown before any retry.
            store.stops.has(id) ||
            store.tasks.has(id) ||
            store.starting.has(id) ||
            manuallyStopped.has(rKey)
          ) {
            return;
          }
        }

        const shouldPreserveCallerDeferredRestart = () =>
          restartDeferredToCaller.has(rKey) &&
          restartPendingDeferredToCaller.has(rKey) &&
          !manuallyStopped.has(rKey);

        let resolveStart: (() => void) | undefined;
        const startGate = new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
        store.starting.set(id, startGate);

        // Reserve the account before the first await so overlapping start calls
        // cannot race into duplicate provider boots for the same account.
        const routeHandoff = store.routeHandoffs.get(id);
        const abort = new AbortController();
        const capabilityLease = createPluginRuntimeCapabilityLease("channel account");
        const lifetime: ChannelAccountLifetime = { plugin, abort, capabilityLease };
        store.lifetimes.set(id, lifetime);
        let handedOffTask = false;
        const log = ensureChannelLog(channelId);
        let scopedChannelRuntime: {
          channelRuntime?: PluginRuntimeChannel;
          dispose: () => void;
        } | null = null;
        let channelRuntimeForTask: PluginRuntimeChannel | undefined;
        let stopApprovalBootstrap: () => Promise<void> = async () => {};
        const stopTaskScopedApprovalRuntime = async () => {
          const scopedRuntime = scopedChannelRuntime;
          scopedChannelRuntime = null;
          const stopBootstrap = stopApprovalBootstrap;
          stopApprovalBootstrap = async () => {};
          scopedRuntime?.dispose();
          await stopBootstrap();
        };
        const cleanupTaskScopedApprovalRuntime = async (label: string) => {
          try {
            await stopTaskScopedApprovalRuntime();
          } catch (error) {
            log.error?.(`[${id}] ${label}: ${formatErrorMessage(error)}`);
          }
        };
        const skipDisabledAccount = () => {
          setRuntime(channelId, id, {
            accountId: id,
            enabled: false,
            running: false,
            restartPending: false,
          });
          startOutcomes.set(id, { status: "skipped", reason: "disabled" });
        };

        const retainKnownAccountHandoffUntilReplacement =
          includeKnownAccounts && knownAccountDeferredToCaller.has(rKey);

        try {
          restartDeferredToCaller.delete(rKey);
          restartPendingDeferredToCaller.delete(rKey);
          if (!retainKnownAccountHandoffUntilReplacement) {
            knownAccountDeferredToCaller.delete(rKey);
          }
          // Reject the account before plugin resolution so an explicit failed SecretRef cannot
          // drift into a channel-specific environment or file fallback.
          const secretOwnerId = `${channelId}:${normalizeAccountId(id)}`;
          clearActiveCredentialDegradedOwner("account", secretOwnerId);
          // Explicitly disabled accounts need no credentials. Unlisted requests still go
          // through the plugin resolver so a disable cannot hide account-selection errors.
          if (
            explicitlyDisabled &&
            plugin.config
              .listAccountIds(cfg)
              .some((listed) => normalizeAccountId(listed) === normalizeAccountId(id))
          ) {
            skipDisabledAccount();
            return;
          }
          try {
            assertSecretOwnerAvailable("account", secretOwnerId);
          } catch (error) {
            if (!optsValue.skipUnavailableAccounts) {
              throw error;
            }
            // Only this snapshot-owned assertion is an expected cold reload
            // outcome; plugin startup and credential-file inspection still fail.
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
            startOutcomes.set(id, { status: "skipped", reason: "secret-unavailable" });
            return;
          }
          const account = plugin.config.resolveAccount(cfg, id);
          const accountContext = createAccountContext(channelId, id, cfg, account, abort.signal);
          if (plugin.gateway?.stopAccount) {
            const stopAccount = plugin.gateway.stopAccount;
            const gateway = plugin.gateway;
            lifetime.teardown = {
              context: accountContext,
              run: (context) =>
                runPluginCleanup(stopAccount, () => stopAccount.call(gateway, context)),
            };
          }
          const described = plugin.config.describeAccount?.(account, cfg);
          const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
          if (!enabled) {
            knownAccountDeferredToCaller.delete(rKey);
            setRuntime(channelId, id, {
              accountId: id,
              enabled: false,
              running: false,
              restartPending: false,
            });
            return;
          }

          const credentialDiagnostics = getCredentialUnavailableDiagnostics(account);
          if (credentialDiagnostics.length > 0) {
            setActiveCredentialDegradedOwner({
              ownerKind: "account",
              ownerId: secretOwnerId,
              state: "unavailable",
              paths: credentialDiagnostics.map((diagnostic) => diagnostic.path),
              refKeys: [],
              reason: "credential file is unavailable",
            });
            assertSecretOwnerAvailable("account", secretOwnerId);
          }

          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await measureStartup(`channels.${channelId}.is-configured`, () =>
              plugin.config.isConfigured!(account, cfg),
            );
          }
          capabilityLease.assertActive("startup");
          if (!configured) {
            setRuntime(channelId, id, {
              accountId: id,
              enabled: true,
              configured: false,
              linked: undefined,
              running: false,
              restartPending: false,
            });
            startOutcomes.set(id, { status: "skipped", reason: "unconfigured" });
            return;
          }
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            configured: true,
            ...(plugin.config.isLinked ? { linked: undefined } : {}),
          });

          const fallbackLinked = described?.linked ?? getRuntime(channelId, id).linked;
          const linkState = plugin.config.isLinked
            ? await measureStartup(`channels.${channelId}.is-linked`, () =>
                plugin.config.isLinked!(account, cfg),
              )
            : fallbackLinked === true
              ? "linked"
              : fallbackLinked === false
                ? "not-linked"
                : undefined;
          capabilityLease.assertActive("startup");
          if (linkState === "not-linked" || linkState === "unknown") {
            setRuntime(channelId, id, {
              accountId: id,
              enabled: true,
              linked: linkState === "not-linked" ? false : undefined,
              running: false,
              restartPending: false,
            });
            startOutcomes.set(id, { status: "skipped", reason: "unlinked" });
            return;
          }

          if (abort.signal.aborted || manuallyStopped.has(rKey)) {
            setStoppedRuntime(channelId, id, {
              restartPending: shouldPreserveCallerDeferredRestart(),
              lastStopAt: Date.now(),
            });
            startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
            return;
          }

          scopedChannelRuntime = await measureStartup(`channels.${channelId}.runtime`, async () =>
            createTaskScopedChannelRuntime({
              channelRuntime:
                registration?.resolveChannelRuntime?.() ?? (await getChannelRuntime()),
            }),
          );
          capabilityLease.assertActive("startup");
          channelRuntimeForTask = scopedChannelRuntime.channelRuntime;

          if (abort.signal.aborted || manuallyStopped.has(rKey)) {
            setStoppedRuntime(channelId, id, {
              restartPending: shouldPreserveCallerDeferredRestart(),
              lastStopAt: Date.now(),
            });
            return;
          }

          if (!preserveRestartAttempts) {
            restarts.delete(rKey);
          }
          try {
            stopApprovalBootstrap = await measureStartup(
              `channels.${channelId}.approval-bootstrap`,
              () =>
                startChannelApprovalHandlerBootstrap({
                  plugin,
                  cfg,
                  accountId: id,
                  channelRuntime: channelRuntimeForTask,
                  gatewayRuntime: opts.getNativeApprovalRuntime?.(),
                  logger: log,
                }),
            );
          } catch (error) {
            log.error?.(`[${id}] native approval bootstrap failed: ${formatErrorMessage(error)}`);
          }
          // Preparation can outlive a registry replacement or an operator stop. Never publish
          // its predecessor task after the replacement has admitted new account lifetimes.
          assertStartCurrent();
          capabilityLease.assertActive("startup");
          if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
            startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
            return;
          }
          let channelRunDurationMs: number | undefined;
          store.startEpochs.set(id, (store.startEpochs.get(id) ?? 0) + 1);
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            ...(linkState === "linked" ? { linked: true } : {}),
            running: true,
            lifecycle: "starting",
            restartPending: false,
            lastStartAt: Date.now(),
            lastError: null,
            // Runtime rows are patch-merged; prior ingress or terminal verdicts
            // must not poison a new lifecycle before its plugin reports status.
            ingressUnavailable: undefined,
            terminalDisconnect: undefined,
            reconnectAttempts: preserveRestartAttempts ? (restarts.get(rKey)?.attempts ?? 0) : 0,
          });
          const task = Promise.resolve().then(async () => {
            if (optsValue.deferAccountStartUntil) {
              await waitForDeferredAccountStart(optsValue.deferAccountStartUntil, abort.signal);
            } else if (startupTrace) {
              await waitForChannelStartupHandoff();
            }
            if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
              return;
            }
            const gatewayApprovalRuntime = opts.getNativeApprovalRuntime?.();
            if (channelRuntimeForTask && gatewayApprovalRuntime) {
              const approvalRuntime: Pick<GatewayNativeApprovalRuntime, "request"> = {
                request: async <T>(
                  method: GatewayNativeApprovalMethod,
                  requestParams: Record<string, unknown>,
                  requestOptions?: { clientDisplayName?: string },
                ): Promise<T> => {
                  if (method !== "approval.resolve") {
                    throw new Error(`channel approval runtime cannot dispatch ${method}`);
                  }
                  return await gatewayApprovalRuntime.request<T>(
                    "approval.resolve",
                    requestParams,
                    requestOptions,
                  );
                },
              };
              registerChannelRuntimeContext({
                channelRuntime: channelRuntimeForTask,
                channelId,
                accountId: id,
                capability: CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY,
                context: approvalRuntime,
                abortSignal: abort.signal,
              });
            }
            let startAccountTask: ReturnType<typeof startAccount> | undefined;
            await measureStartup(`channels.${channelId}.start-account-handoff`, () => {
              if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
                return;
              }
              const runStartAccount = () => {
                const startedAt = Date.now();
                const recordDuration = () => {
                  channelRunDurationMs = Date.now() - startedAt;
                };
                try {
                  return withGatewayNativeApprovalRuntime(opts.getNativeApprovalRuntime?.(), () =>
                    startAccount({
                      ...accountContext,
                      setStatus: (next) =>
                        isCurrentTask()
                          ? setRuntimeFromTaskStatus(channelId, id, next, abort.signal)
                          : getRuntime(channelId, id),
                      invalidateDirectoryCache: () =>
                        resetDirectoryCache({ cfg, channel: channelId, accountId: id }),
                      ...(channelRuntimeForTask ? { channelRuntime: channelRuntimeForTask } : {}),
                    }),
                  ).finally(recordDuration);
                } catch (error) {
                  recordDuration();
                  throw error;
                }
              };
              startAccountTask = withPluginHttpRouteRegistry(
                registry,
                runStartAccount,
                capabilityLease,
              );
            });
            if (!startAccountTask) {
              return;
            }
            await startAccountTask;
          });
          // Recovery can replace a timed-out task before the old promise settles.
          // Only the task that still owns the store slot may write lifecycle state.
          const trackedPromise = task
            .finally(() => capabilityLease.revoke())
            .then(() => {
              if (
                abort.signal.aborted ||
                manuallyStopped.has(rKey) ||
                opts.isClosing?.() ||
                !isCurrentTask()
              ) {
                return;
              }
              if (getRuntime(channelId, id).terminalDisconnect) {
                // Terminal status carries the operator-facing diagnosis and restart policy.
                // Do not replace it with a generic clean-exit error before policy consumes it.
                return;
              }
              const message = "channel exited without an error";
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(`[${id}] ${message}`);
            })
            .catch((err: unknown) => {
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
                return;
              }
              const message = formatErrorMessage(err);
              setRuntime(channelId, id, {
                accountId: id,
                lastError: message,
                // A channel that never armed its ingress admission is not "crashed":
                // outbound may work fine while inbound is silently dead. Record the
                // distinct dimension so health stops reading a live socket as healthy.
                ...(isChannelIngressUnavailableError(err) ? { ingressUnavailable: true } : {}),
              });
              log.error?.(`[${id}] channel exited: ${message}`);
            })
            .then(async () => {
              await cleanupTaskScopedApprovalRuntime("channel cleanup failed");
              // stopChannel owns the failed-teardown snapshot until a later
              // successful stop proves replacement is safe.
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
                return;
              }
              setStoppedRuntime(channelId, id, {
                restartPending: shouldPreserveCallerDeferredRestart(),
                lastStopAt: Date.now(),
              });
            })
            .then(async () => {
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
                return;
              }
              if (manuallyStopped.has(rKey)) {
                recoveryStopTimedOut.delete(rKey);
                recoveryStartRequested.delete(rKey);
                return;
              }
              if (getRuntime(channelId, id).terminalDisconnect) {
                // Authentication/session termination wins over pending recovery.
                // Leaving recovery state behind would restart a channel that needs user action.
                recoveryStopTimedOut.delete(rKey);
                recoveryStartRequested.delete(rKey);
                restartDeferredToCaller.delete(rKey);
                restartPendingDeferredToCaller.delete(rKey);
                knownAccountDeferredToCaller.delete(rKey);
                restarts.delete(rKey);
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: false,
                  reconnectAttempts: 0,
                });
                log.info?.(`[${id}] auto-restart skipped, terminal disconnect`);
                return;
              }
              if (recoveryStopTimedOut.has(rKey)) {
                recoveryStopTimedOut.delete(rKey);
                if (!recoveryStartRequested.delete(rKey)) {
                  restartDeferredToCaller.delete(rKey);
                  restartPendingDeferredToCaller.delete(rKey);
                  // A private include-known handoff must survive this inverse ordering:
                  // the stale task can settle after a timed-out stop but before the
                  // paired reload start has had a chance to union known accounts.
                  setRuntime(channelId, id, {
                    accountId: id,
                    restartPending: false,
                    reconnectAttempts: 0,
                  });
                  releaseTask();
                  return;
                }
                restarts.delete(rKey);
                log.info?.(`[${id}] restarting after timed-out channel stop completed`);
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: true,
                  reconnectAttempts: 0,
                });
                releaseTask();
                try {
                  await startChannelInternal(channelId, id, {
                    preserveManualStop: true,
                  });
                } catch {
                  // abort or startup failure — runtime state was recorded by startChannelInternal
                }
                return;
              }
              if (restartDeferredToCaller.has(rKey)) {
                return;
              }
              // Only plugin task lifetime counts. Deferred handoff and cleanup must not
              // make a short crash look stable and erase crash-loop attempts.
              if (
                channelRunDurationMs !== undefined &&
                channelRunDurationMs >= CHANNEL_STABLE_RUN_MS
              ) {
                restarts.delete(rKey);
              }
              const restart =
                restarts.get(rKey) ?? new RetrySupervisor(RESTART_POLICY, MAX_RESTARTS);
              restarts.set(rKey, restart);
              const retry = restart.next(abort.signal);
              if (!retry) {
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: false,
                  reconnectAttempts: restart.attempts,
                });
                log.error?.(`[${id}] giving up after ${MAX_RESTARTS} restart attempts`);
                return;
              }
              log.info?.(
                `[${id}] auto-restart attempt ${restart.attempts}/${MAX_RESTARTS} in ${Math.round(retry.delayMs / 1000)}s`,
              );
              setRuntime(channelId, id, {
                accountId: id,
                restartPending: true,
                reconnectAttempts: restart.attempts,
              });
              pendingAutoRestarts.add(rKey);
              try {
                await sleepWithAbort(retry.delayMs, retry.signal);
                if (manuallyStopped.has(rKey) || opts.isClosing?.()) {
                  return;
                }
                releaseTask();
                await startChannelInternal(channelId, id, {
                  preserveRestartAttempts: true,
                  preserveManualStop: true,
                });
              } catch {
                // abort or startup failure — next crash will retry
              } finally {
                pendingAutoRestarts.delete(rKey);
              }
            })
            .finally(() => {
              releaseTask();
              // Retry ingress spans backoff and preparation. A successful retry
              // transfers admission to its signal before this predecessor ends.
              if (routeHandoff?.admittedSignal === abort.signal) {
                releaseRouteHandoff(store, id, routeHandoff);
              }
            });
          function releaseTask() {
            if (store.tasks.get(id) === trackedPromise) {
              store.tasks.delete(id);
            }
            // Failed or queued teardown retains the admitted context. Every terminal
            // task still aborts before replacement so no predecessor keeps authority.
            if (store.lifetimes.get(id) === lifetime && !store.stops.has(id)) {
              store.lifetimes.delete(id);
            }
            abort.abort();
          }
          function isCurrentTask() {
            return store.tasks.get(id) === trackedPromise;
          }
          handedOffTask = true;
          knownAccountDeferredToCaller.delete(rKey);
          store.tasks.set(id, trackedPromise);
          if (routeHandoff) {
            routeHandoff.admittedSignal = abort.signal;
          }
          startOutcomes.set(id, { status: "handed-off" });
        } catch (error) {
          if (!handedOffTask && capabilityLease.isActive()) {
            setStoppedRuntime(channelId, id, {
              ...(error instanceof SecretSurfaceUnavailableError ? { configured: true } : {}),
              restartPending: abort.signal.aborted && shouldPreserveCallerDeferredRestart(),
              lastError: formatErrorMessage(error),
            });
          }
          throw error;
        } finally {
          if (!handedOffTask) {
            if (routeHandoff && capabilityLease.isActive()) {
              releaseRouteHandoff(store, id, routeHandoff);
            }
            capabilityLease.revoke();
            await cleanupTaskScopedApprovalRuntime("channel startup cleanup failed");
          }
          if (!handedOffTask && store.lifetimes.get(id) === lifetime && !store.stops.has(id)) {
            store.lifetimes.delete(id);
          }
          if (store.starting.get(id) === startGate.promise) {
            store.starting.delete(id);
          }
          startGate.resolve();
        }
      }),
    });
    if (startup.hasError) {
      throw startup.firstError;
    }
    return startOutcomes;
  };

  const startChannel = async (
    channelId: ChannelId,
    accountId?: string,
    startOptions: StartChannelOptions = {},
  ) => {
    await startChannelInternal(channelId, accountId, startOptions);
  };

  const stopChannelInRegistry = async (
    registry: PluginRegistry,
    channelId: ChannelId,
    accountId?: string,
    optsLocal: StopChannelOptions = {},
  ) => {
    const manual = optsLocal.manual ?? true;
    const markRestartPending = optsLocal.restartPending ?? !manual;
    const preserveKnownAccount = optsLocal.preserveKnownAccount === true;
    const plugin = getChannelPlugin(channelId);
    const store = getStore(channelId);
    if (retainCleanupOwner) {
      releaseChannelRouteHandoffs(channelId, accountId);
    }
    const lifecycleIds = new Set<string>([
      ...store.lifetimes.keys(),
      ...store.starting.keys(),
      ...store.stops.keys(),
      ...store.tasks.keys(),
    ]);
    // A completed hot-reload stop can leave only restartPending, a caller-owned
    // restart handoff, or the private known-account handoff marker until the
    // paired start runs; manual stops must still be able to cancel that queued
    // restart.
    const hasRestartPendingRuntime = Array.from(store.runtimes.values()).some(
      (snapshot) => snapshot.restartPending === true,
    );
    const hasRestartDeferredHandoff = accountId
      ? restartDeferredToCaller.has(restartKey(channelId, accountId))
      : Array.from(restartDeferredToCaller.keys()).some((key) => key.startsWith(`${channelId}:`));
    const hasKnownAccountHandoff = accountId
      ? knownAccountDeferredToCaller.has(restartKey(channelId, accountId))
      : Array.from(store.runtimes.keys()).some((id) =>
          knownAccountDeferredToCaller.has(restartKey(channelId, id)),
        );
    const hasCallerOwnedHandoff =
      hasRestartPendingRuntime || hasRestartDeferredHandoff || hasKnownAccountHandoff;
    if (!accountId && lifecycleIds.size === 0 && !hasCallerOwnedHandoff) {
      return;
    }
    // Fast path: nothing running and no explicit plugin shutdown hook to run.
    if (!plugin?.gateway?.stopAccount && lifecycleIds.size === 0 && !hasCallerOwnedHandoff) {
      return;
    }
    const cfg = getRuntimeConfig();
    const knownIds = new Set<string>([
      ...listKnownLiveAccountIds(channelId, store, { includeKnownAccountHandoffs: true }),
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      knownIds.clear();
      knownIds.add(accountId);
    }

    // Gate replacement starts before teardown begins. Failures still reject only
    // after every sibling account has finished its independent lifecycle cleanup.
    const stopOutcomes = await Promise.all(
      Array.from(knownIds.values()).map(async (id): Promise<ChannelAccountStopOutcome> => {
        const initialAbort = store.aborts.get(id);
        const initialTask = store.tasks.get(id);
        const runtimeSnapshot = store.runtimes.get(id);
        const rKey = restartKey(channelId, id);
        const hadCallerHandoff =
          restartDeferredToCaller.has(rKey) || knownAccountDeferredToCaller.has(rKey);
        const hadLiveState = Boolean(
          initialAbort ||
          initialTask ||
          store.starting.has(id) ||
          runtimeSnapshot?.running ||
          runtimeSnapshot?.restartPending ||
          hadCallerHandoff,
        );
        if (!hadLiveState && !plugin?.gateway?.stopAccount) {
          if (manual) {
            manuallyStopped.add(rKey);
            restartDeferredToCaller.delete(rKey);
            restartPendingDeferredToCaller.delete(rKey);
            knownAccountDeferredToCaller.delete(rKey);
          }
          return { status: "fulfilled" };
        }
        const accountRestartPending = markRestartPending && hadLiveState;
        if (manual) {
          manuallyStopped.add(rKey);
          restartDeferredToCaller.delete(rKey);
          restartPendingDeferredToCaller.delete(rKey);
          knownAccountDeferredToCaller.delete(rKey);
        } else if (hadLiveState) {
          restartDeferredToCaller.add(rKey);
          if (accountRestartPending) {
            restartPendingDeferredToCaller.add(rKey);
          } else {
            restartPendingDeferredToCaller.delete(rKey);
          }
          if (preserveKnownAccount) {
            knownAccountDeferredToCaller.add(rKey);
          } else {
            knownAccountDeferredToCaller.delete(rKey);
          }
        } else {
          restartDeferredToCaller.delete(rKey);
          restartPendingDeferredToCaller.delete(rKey);
          knownAccountDeferredToCaller.delete(rKey);
        }

        const currentStop = store.stops.get(id);
        const runStopAttempt = async (
          previousOutcome: ChannelAccountStopOutcome,
        ): Promise<ChannelAccountStopOutcome> => {
          const lifetime = store.lifetimes.get(id);
          const abort = lifetime?.abort;
          const canHandoff =
            optsLocal.routeHandoff &&
            configuredAccountIds.includes(id) &&
            !isChannelAccountExplicitlyDisabled({ cfg, channel: channelId, accountId: id }) &&
            !manuallyStopped.has(rKey);
          if (!canHandoff) {
            releaseRouteHandoff(store, id);
          }
          const task = store.tasks.get(id);
          if (!hadLiveState && !abort && !task && !plugin?.gateway?.stopAccount) {
            return previousOutcome;
          }
          const lease = lifetime?.capabilityLease;
          if (canHandoff && abort && lease && store.routeHandoffs.get(id)?.parkedBy !== abort) {
            const handoff = store.routeHandoffs.get(id)?.handoff ?? createPluginHttpRouteHandoff();
            handoff.park(lease);
            store.routeHandoffs.set(id, { handoff, parkedBy: abort });
          }
          // Parking transfers ingress ownership before cancellation. Retired
          // startup work must never reclaim it while its promise is settling.
          if (optsLocal.routeHandoff) {
            lease?.revoke();
          }
          abort?.abort();
          const log = ensureChannelLog(channelId);
          const runtime = ensureChannelRuntime(channelId);
          const previousStopAccountFenceSatisfied =
            previousOutcome.status === "fulfilled" &&
            previousOutcome.stopAccountFenceSatisfied === true;
          let outcome: ChannelAccountStopOutcome = previousStopAccountFenceSatisfied
            ? { status: "fulfilled", stopAccountFenceSatisfied: true }
            : { status: "fulfilled" };
          let stopAccountAlreadySatisfied = previousStopAccountFenceSatisfied;
          const existingStopAccountFence = store.stopAccountFences.get(id);
          if (existingStopAccountFence) {
            const stopAccountSettled = await waitForChannelStopGracefully(
              existingStopAccountFence.settled,
              CHANNEL_STOP_ABORT_TIMEOUT_MS,
            );
            if (stopAccountSettled) {
              const lateStopAccountError = existingStopAccountFence.getLateError();
              if (lateStopAccountError !== undefined) {
                outcome = { status: "rejected", error: lateStopAccountError };
                if (store.stopAccountFences.get(id) === existingStopAccountFence) {
                  store.stopAccountFences.delete(id);
                }
              } else {
                stopAccountAlreadySatisfied = true;
                outcome = { status: "fulfilled", stopAccountFenceSatisfied: true };
                if (store.stopAccountFences.get(id) === existingStopAccountFence) {
                  store.stopAccountFences.delete(id);
                  const currentStopAfterFence = store.stops.get(id);
                  if (
                    currentStopAfterFence?.status === "rejected" &&
                    currentStopAfterFence.error === existingStopAccountFence.timeoutError
                  ) {
                    store.stops.delete(id);
                  }
                }
              }
            } else {
              outcome = {
                status: "rejected",
                error: existingStopAccountFence.timeoutError,
              };
            }
          }
          if (
            !stopAccountAlreadySatisfied &&
            outcome.status !== "rejected" &&
            plugin?.gateway?.stopAccount
          ) {
            try {
              const account = plugin.config.resolveAccount(cfg, id);
              // A plugin stopAccount that never settles must not wedge every
              // stop-driven flow (health monitor sweeps, thaw recovery, reload).
              // Bound it like the task teardown below; the timed-out path flows
              // into the existing recoveryStopTimedOut two-call restart contract.
              let stopAttemptAbandoned = false;
              let lateStopAccountError: unknown;
              const stopAccountStartEpoch = store.startEpochs.get(id) ?? 0;
              const stopAccountAttempt = plugin.gateway
                .stopAccount({
                  cfg,
                  accountId: id,
                  account,
                  runtime,
                  abortSignal: abort?.signal ?? new AbortController().signal,
                  log,
                  getStatus: () => getRuntime(channelId, id),
                  setStatus: (next) => {
                    // A stop we abandoned may settle after a replacement started;
                    // its late writes must not repaint or tear down that account.
                    setRuntime(
                      channelId,
                      id,
                      stopAttemptAbandoned
                        ? sanitizeAbortedTaskStatusPatch(next, getRuntime(channelId, id))
                        : next,
                    );
                  },
                })
                .catch((error: unknown) => {
                  if (stopAttemptAbandoned) {
                    log.warn?.(
                      `[${id}] abandoned stopAccount failed late: ${formatErrorMessage(error)}`,
                    );
                    lateStopAccountError = error;
                    return;
                  }
                  outcome = { status: "rejected", error };
                  log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`);
                });
              const stopAccountAttempt = withPluginHttpRouteRegistry(
                registry,
                runStopAccount,
                stopLease,
              ).catch((error: unknown) => {
                if (!stopLease.isActive()) {
                  log.warn?.(
                    `[${id}] abandoned stopAccount failed late: ${formatErrorMessage(error)}`,
                  );
                  return;
                }
                outcome = { status: "rejected", error };
                log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`);
              });
              stopAccountSettled = await waitForChannelStopGracefully(
                stopAccountAttempt,
                CHANNEL_STOP_ABORT_TIMEOUT_MS,
              );
              if (!stopAccountSettled) {
                stopAttemptAbandoned = true;
                const stopAccountTimeoutError = new Error(
                  `stopAccount timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
                );
                const stopAccountFence: StopAccountFence = {
                  settled: stopAccountAttempt,
                  timeoutError: stopAccountTimeoutError,
                  getLateError: () => lateStopAccountError,
                };
                const resolveCurrentFenceRestartPending = () => {
                  if (restartDeferredToCaller.has(rKey)) {
                    return restartPendingDeferredToCaller.has(rKey);
                  }
                  if (manuallyStopped.has(rKey)) {
                    return false;
                  }
                  return accountRestartPending;
                };
                void stopAccountFence.settled.finally(() => {
                  if (
                    lateStopAccountError === undefined &&
                    store.stopAccountFences.get(id) === stopAccountFence
                  ) {
                    store.stopAccountFences.delete(id);
                    const currentStopAfterFence = store.stops.get(id);
                    if (
                      currentStopAfterFence?.status === "rejected" &&
                      currentStopAfterFence.error === stopAccountFence.timeoutError
                    ) {
                      store.stops.delete(id);
                      if (
                        (store.startEpochs.get(id) ?? 0) === stopAccountStartEpoch &&
                        !store.aborts.has(id) &&
                        !store.tasks.has(id) &&
                        !store.starting.has(id)
                      ) {
                        recoveryStopTimedOut.delete(rKey);
                        recoveryStartRequested.delete(rKey);
                        clearPluginCommandCatalogOwner(store, id);
                        setStoppedRuntime(channelId, id, {
                          restartPending: resolveCurrentFenceRestartPending(),
                          lastStopAt: Date.now(),
                        });
                      }
                    }
                  }
                });
                store.stopAccountFences.set(id, stopAccountFence);
                outcome = {
                  status: "rejected",
                  error: stopAccountTimeoutError,
                };
                log.warn?.(
                  `[${id}] stopAccount exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms; deferring replacement`,
                );
              }
            }
          } catch (error) {
            outcome = { status: "rejected", error };
            log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`);
          } finally {
            capabilityLease?.revoke();
          }
          const deferTaskWaitToPairedStart =
            outcome.status === "rejected" && !manual && preserveKnownAccount && hadLiveState;
          const stoppedCleanly = deferTaskWaitToPairedStart
            ? false
            : await waitForChannelStopGracefully(task, CHANNEL_STOP_ABORT_TIMEOUT_MS);
          if (!deferTaskWaitToPairedStart && !stoppedCleanly) {
            log.warn?.(
              `[${id}] channel stop exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms after abort; continuing shutdown`,
            );
          }
          if (optsLocal.strict && (!stopAccountSettled || !stoppedCleanly)) {
            outcome = {
              status: "rejected",
              error: new Error(
                `Channel ${channelId}/${id} ${stoppedCleanly ? "stopAccount did not settle" : "still owns running work"}.`,
              ),
            };
          }
          if (outcome.status === "rejected" && retainCleanupOwner) {
            recoveryStopTimedOut.delete(rKey);
            recoveryStartRequested.delete(rKey);
            if (stoppedCleanly && store.tasks.get(id) === task) {
              store.tasks.delete(id);
            }
            setRuntime(channelId, id, {
              accountId: id,
              running: true,
              restartPending: false,
              lastError: formatErrorMessage(outcome.error),
            });
            return outcome;
          }
          if (!stoppedCleanly && retainCleanupOwner) {
            const stoppedPatch = {
              restartPending: accountRestartPending,
              lastError: `channel stop timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
            };
            if (manual) {
              setRuntime(channelId, id, {
                accountId: id,
                running: true,
                ...stoppedPatch,
              });
            } else {
              setStoppedRuntime(channelId, id, stoppedPatch);
            }
            if (!manual && hadLiveState) {
              restartDeferredToCaller.delete(rKey);
              restartPendingDeferredToCaller.delete(rKey);
              recoveryStopTimedOut.add(rKey);
            }
            return outcome;
          }
          recoveryStopTimedOut.delete(rKey);
          recoveryStartRequested.delete(rKey);
          if (store.tasks.get(id) === task) {
            store.tasks.delete(id);
          }
          // Only the final stop releases the captured owner. Handoff retires pending
          // preparation too; its revoked lease fences late results and route writes.
          const latestStop = store.stops.get(id);
          if (
            latestStop?.status === "stopping" &&
            latestStop.attempt === stopAttempt &&
            store.lifetimes.get(id) === lifetime
          ) {
            store.lifetimes.delete(id);
            if (!retainCleanupOwner) {
              store.starting.delete(id);
            }
          }
          setStoppedRuntime(channelId, id, {
            restartPending: accountRestartPending,
            lastStopAt: Date.now(),
            ...(outcome.status === "rejected"
              ? { lastError: formatErrorMessage(outcome.error) }
              : {}),
          });
          return outcome;
        };

        const previousStop =
          currentStop?.status === "stopping"
            ? currentStop.attempt
            : Promise.resolve<ChannelAccountStopOutcome>(currentStop ?? { status: "fulfilled" });
        const stopAttempt = previousStop.then(runStopAttempt);
        store.stops.set(id, { status: "stopping", attempt: stopAttempt });
        const outcome = await stopAttempt;
        const latestStop = store.stops.get(id);
        if (latestStop?.status === "stopping" && latestStop.attempt === stopAttempt) {
          if (outcome.status === "rejected" && retainCleanupOwner) {
            store.stops.set(id, outcome);
          } else {
            store.stops.delete(id);
            if (!store.tasks.has(id) && !store.starting.has(id)) {
              store.lifetimes.delete(id);
            }
          }
        }
        return outcome;
      }),
    );
    const failedStop = stopOutcomes.find((outcome) => outcome.status === "rejected");
    if (failedStop?.status === "rejected") {
      throw failedStop.error;
    }
  };

  const stopChannel: ChannelManager["stopChannel"] = (...args) =>
    withRegistry((registry) => stopChannelInRegistry(registry, ...args));

  const startChannelsWithOptions = async (startOptions: StartChannelOptions = {}) => {
    let releaseAccountStarts: (() => void) | undefined;
    const deferAccountStartUntil =
      opts.deferStartupAccountStartsUntil ??
      (startupTrace
        ? new Promise<void>((resolve) => {
            releaseAccountStarts = () => {
              const handle = setImmediate(resolve);
              handle.unref?.();
            };
          })
        : undefined);
    try {
      await runTasksWithConcurrency({
        limit: CHANNEL_STARTUP_CONCURRENCY,
        tasks: listLoadedChannelPluginsForRegistry(getPluginRegistry()).map(
          (plugin) => async () => {
            try {
              await measureStartup(`channels.${plugin.id}.start`, () =>
                startChannelInternal(plugin.id, undefined, {
                  ...startOptions,
                  ...(deferAccountStartUntil ? { deferAccountStartUntil } : {}),
                }),
              );
            } catch (err) {
              ensureChannelLog(plugin.id).error?.(
                `[${plugin.id}] channel startup failed: ${formatErrorMessage(err)}`,
              );
            }
          },
        ),
      });
    } finally {
      releaseAccountStarts?.();
    }
  };

  const startChannels = async () => await startChannelsWithOptions();

  const recoverAutostartSuppression = async (): Promise<boolean> => {
    if (
      !autostartSuppression ||
      opts.isClosing?.() ||
      !opts.tryRecoverAutostartSuppression?.() ||
      opts.isClosing?.()
    ) {
      return false;
    }
    autostartSuppression = null;
    // Recovery resumes the autostart attempt that safe mode deferred. Preserve
    // explicit operator stops while still covering health-monitor opt-outs.
    await startChannelsWithOptions({ preserveManualStop: true });
    return true;
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const cfg = getRuntimeConfig();
    const resolvedId =
      accountId ??
      resolveChannelDefaultAccountId({
        plugin,
        cfg,
      });
    const current = getRuntime(channelId, resolvedId);
    setStoppedRuntime(channelId, resolvedId, {
      ...(cleared ? { linked: false } : {}),
      restartPending: false,
      lastError: cleared ? "logged out" : current.lastError,
    });
  };

  const captureChannelSnapshot = (plugin: ChannelPlugin, inspectAccounts = true) => {
    const channelId = plugin.id;
    const store = getStore(channelId);
    const cfg = getRuntimeConfig();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listChannelPlugins()) {
      const store = getStore(plugin.id);
      const listedAccountIds = plugin.config.listAccountIds(cfg);
      const listedAccountIdSet = new Set(listedAccountIds);
      const accountIds = Array.from(
        new Set([...listedAccountIds, ...listKnownLiveAccountIds(plugin.id, store)]),
      );
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        let account: ReturnType<typeof plugin.config.resolveAccount>;
        try {
          account = plugin.config.resolveAccount(cfg, id);
        } catch (err) {
          if (!listedAccountIdSet.has(id)) {
            continue;
          }
          throw err;
        }
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const configured = described?.configured ?? current.configured ?? true;
        const state = resolveChannelAccountState({
          enabled,
          configured,
          linked: plugin.config.isLinked
            ? current.linked
            : typeof current.linked === "boolean"
              ? current.linked
              : described?.linked,
          runtime: current,
          disabledReason: plugin.config.disabledReason?.(account, cfg),
          unconfiguredReason: plugin.config.unconfiguredReason?.(account, cfg),
          unlinkedReason: plugin.config.unlinkedReason?.(account, cfg),
        });
        const next = { ...current, accountId: id, enabled };
        applyChannelAccountState(next, state);
        if (described?.mode !== undefined) {
          next.mode = described.mode;
        }
      }
      return () => {
        const current = runtime();
        return (
          resolveUnavailableChannelAccountSnapshot(getRuntimeConfig(), {
            registry: getPluginRegistry(),
            channelId,
            accountId: id,
            runtime: current,
          }) ?? project(current)
        );
      };
    });
    return {
      listedAccountIds: configuredAccountIdSet,
      read: () => {
        const snapshots = Object.fromEntries(
          accountIds.map((id, index) => [id, accounts[index]!()]),
        );
        return {
          accounts: snapshots,
          defaultAccountId,
          defaultAccount: snapshots[defaultAccountId] ?? {
            ...defaultRuntime,
            accountId: defaultAccountId,
          },
        };
      },
    };
  };

  const getRuntimeSnapshot = (
    options: ChannelRuntimeSnapshotOptions = {},
  ): ChannelRuntimeSnapshot => {
    const { channelId, inspectAccounts = true } = options;
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    const reloadingChannels = new Map<ChannelId, string | undefined>();
    for (const plugin of listLoadedChannelPluginsForRegistry(getPluginRegistry())) {
      if (channelId !== undefined && plugin.id !== channelId) {
        continue;
      }
      const fence = getStore(plugin.id).startFence;
      const snapshot = (
        fence?.paused ? fence.snapshot : captureChannelSnapshot(plugin, inspectAccounts)
      )?.read();
      if (fence?.paused) {
        reloadingChannels.set(plugin.id, snapshot?.defaultAccountId);
      }
      if (snapshot) {
        channels[plugin.id] = snapshot.defaultAccount;
        channelAccounts[plugin.id] = snapshot.accounts;
      }
    }
    return { channels, channelAccounts, reloadingChannels };
  };

  const isManuallyStoppedFlag = (channelId: ChannelId, accountId: string): boolean => {
    return manuallyStopped.has(restartKey(channelId, accountId));
  };

  const isAutoRestartScheduled = (channelId: ChannelId, accountId: string): boolean => {
    return pendingAutoRestarts.has(restartKey(channelId, accountId));
  };

  const resetRestartAttempts = (channelId: ChannelId, accountId: string): void => {
    restarts.delete(restartKey(channelId, accountId));
  };

  return {
    getRuntimeSnapshot,
    pauseChannelStarts: (channelIds) => {
      const reservations = [...new Set(channelIds)].map((channelId) => {
        const store = getStore(channelId);
        const previous = store.startFence;
        const plugin = getChannelPlugin(channelId);
        const fence = {
          paused: true,
          snapshot: previous?.paused
            ? previous.snapshot
            : plugin
              ? captureChannelSnapshot(plugin)
              : undefined,
        };
        return { channelId, store, previous, fence };
      });
      // Capture every target before pausing any of them; a failed capture must not strand a sibling.
      for (const { store, fence } of reservations) {
        store.startFence = fence;
      }
      return (outcome, selected) => {
        for (const { channelId, store, previous, fence } of reservations) {
          if (selected && !selected.has(channelId)) {
            continue;
          }
          if (store.startFence === fence && fence.paused) {
            // Publication keeps the token so delayed predecessor preparation stays stale.
            // A cancelled retry restores an earlier failed replacement's pause.
            if (outcome === "published") {
              fence.paused = false;
            } else {
              store.startFence = previous;
            }
          }
        }
      };
    },
    startChannels,
    startChannel: startChannelInternal,
    stopChannel,
    releaseChannelRouteHandoffs,
    pruneInactiveChannelAccountState,
    setAutostartSuppression: (suppression) => {
      autostartSuppression = suppression;
    },
    getAutostartSuppression: () => autostartSuppression,
    recoverAutostartSuppression,
    setAmbientAutostartSuppressedChannelIds: (channelIds) => {
      ambientAutostartSuppressedChannelIds = new Set(channelIds);
    },
    isAmbientAutostartSuppressed: (channelId) =>
      ambientAutostartSuppressedChannelIds.has(channelId),
    markChannelLoggedOut,
    isManuallyStopped: isManuallyStoppedFlag,
    hasCurrentAccountTask: (channelId, accountId) => {
      const store = channelStores.get(channelId);
      const lifetime = store?.lifetimes.get(accountId);
      // A retained task slot can be an aborted predecessor or supervised backoff.
      return Boolean(
        store &&
        lifetime &&
        store.tasks.has(accountId) &&
        !store.stops.has(accountId) &&
        !lifetime.abort.signal.aborted &&
        lifetime.capabilityLease.isActive() &&
        lifetime.plugin === getChannelPlugin(channelId),
      );
    },
    isAccountListed: (channelId, accountId) => {
      const fence = channelStores.get(channelId)?.startFence;
      // Health and thaw read captured configuration while plugin callbacks are paused.
      return fence?.paused
        ? (fence.snapshot?.listedAccountIds.has(accountId) ?? false)
        : withRegistry(
            (registry) =>
              getLoadedChannelPluginEntryById(channelId, registry)
                ?.plugin.config.listAccountIds(getRuntimeConfig())
                .includes(accountId) ?? false,
          );
    },
    resolveRuntimeAccountId: (channelId, accountId) => {
      const matches = [...(channelStores.get(channelId)?.runtimes.keys() ?? [])].filter(
        (id) => normalizeAccountId(id) === accountId,
      );
      return matches.length === 1 ? matches[0] : undefined;
    },
    isAutoRestartScheduled,
    resetRestartAttempts,
    isHealthMonitorEnabled,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
