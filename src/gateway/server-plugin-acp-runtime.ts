/**
 * Gateway-hosted `api.runtime.acp`: one-shot ACP harness runs owned by the calling plugin.
 *
 * The principal is the host plugin id carried by the registry proxy's request scope; every
 * method resolves it fresh, so a plugin can only spawn as itself and only see, wait on,
 * observe, or cancel runs whose task owner key is `plugin:<pluginId>:acp`.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SpawnAcpForPluginResult } from "../agents/subagents/spawn/acp-spawn-plugin.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AgentEventStream, onAgentEventForRun } from "../infra/agent-events.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  hasLivePluginRuntimeRequestAuthority,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { mapCancelledTaskResult } from "../plugins/runtime/runtime-tasks.js";
import {
  hasActivePluginSubagentRequesterContext,
  type PluginSubagentRequesterContext,
  resolvePluginSubagentCompletionRequester,
} from "../plugins/runtime/subagent-requester-context.js";
import {
  type PluginAcpAuthorityMode,
  type PluginAcpErrorCode,
  type PluginAcpObserveEvent,
  PluginAcpRuntimeError,
  type PluginAcpSpawnParams,
  type PluginAcpSpawnResult,
  resolvePluginAcpOwnerKey,
} from "../plugins/runtime/types-acp.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { isAcpSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { mapTaskRunDetail, mapTaskRunView } from "../tasks/task-domain-views.js";
import { isTerminalTaskStatus } from "../tasks/task-executor-policy.js";
import { cancelDetachedTaskRunById } from "../tasks/task-executor.js";
import { isActiveTaskStatus } from "../tasks/task-registry-common.js";
import { getTaskById, listTasksForOwnerKey } from "../tasks/task-registry-query.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";
import { getInProcessGatewayRequestContext } from "./server-plugin-in-process-dispatch.js";
import {
  canTrustedOfficialPluginRequestScopes,
  waitForGatewayAgentRun,
} from "./server-plugin-subagent-runtime.js";

const PLUGIN_ACP_LIST_DEFAULT_LIMIT = 50;
const PLUGIN_ACP_LIST_MAX_LIMIT = 200;
const PLUGIN_ACP_OBSERVE_DEFAULT_MAX_EVENTS = 500;
const PLUGIN_ACP_OBSERVE_MAX_EVENTS = 2_000;
const PLUGIN_ACP_IDEMPOTENCY_TTL_MS = 10 * 60_000;
const PLUGIN_ACP_IDEMPOTENCY_MAX_ENTRIES_PER_PLUGIN = 200;
const PLUGIN_ACP_TASK_MAX_LENGTH = 200_000;

const PLUGIN_ACP_OBSERVED_STREAMS: ReadonlyArray<PluginAcpObserveEvent["stream"]> = [
  "lifecycle",
  "acp",
  "tool",
  "error",
];

function toObservedStream(stream: AgentEventStream): PluginAcpObserveEvent["stream"] | undefined {
  return PLUGIN_ACP_OBSERVED_STREAMS.find((candidate) => candidate === stream);
}

/** sessions_spawn(runtime="acp") options that plugins must not steer through this seam. */
const PLUGIN_ACP_UNSUPPORTED_SPAWN_OPTIONS = [
  "mode",
  "thread",
  "streamTo",
  "resumeSessionId",
  "sandbox",
  "expectsCompletionMessage",
  "requesterSessionKey",
  "parentSessionKey",
  "spawnedBy",
  "steer",
  "setMode",
] as const;

const GATEWAY_REQUIRED_REASON = "Plugin ACP runtime is only available inside the Gateway.";

type ResolvedPluginAcpPrincipal = {
  pluginId: string;
  ownerKey: string;
  mode: PluginAcpAuthorityMode;
  context: GatewayRequestContext;
  cfg: OpenClawConfig;
  detachedAllowed: boolean;
  /** Rechecks the host request lease or requester-bound hook that granted request mode. */
  requestAuthorityLive: () => boolean;
};

/** One receipt per (idempotency key, canonical input) tuple; failed spawns are evicted. */
type IdempotencyEntry = {
  expiresAt: number;
  pending?: Promise<PluginAcpSpawnResult>;
  result?: PluginAcpSpawnResult;
};

function invalidInput(message: string, option?: string): PluginAcpRuntimeError {
  return new PluginAcpRuntimeError("ACP_PLUGIN_INVALID_INPUT", message, option);
}

function requireOptionalStringOption(
  value: unknown,
  option: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidInput(`"${option}" must be a string.`, option);
  }
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) {
    throw invalidInput(`"${option}" must not be empty.`, option);
  }
  return trimmed || undefined;
}

type CanonicalSpawnInput = {
  task: string;
  label?: string;
  agentId?: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  idempotencyKey?: string;
  completionDelivery?: "current-requester";
  attachments?: Array<{ mediaType: string; data: string }>;
};

function normalizeSpawnParams(raw: unknown): CanonicalSpawnInput {
  if (!isRecord(raw)) {
    throw invalidInput("spawn params must be an object.");
  }
  const params = raw;
  for (const option of PLUGIN_ACP_UNSUPPORTED_SPAWN_OPTIONS) {
    if (params[option] !== undefined) {
      throw new PluginAcpRuntimeError(
        "ACP_PLUGIN_UNSUPPORTED_OPTION",
        `api.runtime.acp.spawn does not support "${option}"; plugin ACP runs are one-shot, unbound, and owned by the plugin.`,
        option,
      );
    }
  }
  const task = typeof params.task === "string" ? params.task.trim() : "";
  if (!task) {
    throw invalidInput('"task" is required.', "task");
  }
  if (task.length > PLUGIN_ACP_TASK_MAX_LENGTH) {
    throw invalidInput(`"task" exceeds ${PLUGIN_ACP_TASK_MAX_LENGTH} characters.`, "task");
  }
  const cwd = requireOptionalStringOption(params.cwd, "cwd");
  if (cwd !== undefined && !path.isAbsolute(cwd)) {
    throw invalidInput('"cwd" must be an absolute path.', "cwd");
  }
  let runTimeoutSeconds: number | undefined;
  if (params.runTimeoutSeconds !== undefined) {
    const value = params.runTimeoutSeconds;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw invalidInput(
        '"runTimeoutSeconds" must be a finite, non-negative number.',
        "runTimeoutSeconds",
      );
    }
    runTimeoutSeconds = Math.floor(value);
  }
  let cleanup: "delete" | "keep" | undefined;
  if (params.cleanup !== undefined) {
    if (params.cleanup !== "delete" && params.cleanup !== "keep") {
      throw invalidInput('"cleanup" must be "delete" or "keep".', "cleanup");
    }
    cleanup = params.cleanup;
  }
  let completionDelivery: CanonicalSpawnInput["completionDelivery"];
  if (params.completionDelivery !== undefined) {
    if (params.completionDelivery !== "current-requester") {
      throw invalidInput(
        '"completionDelivery" must be "current-requester" or omitted.',
        "completionDelivery",
      );
    }
    completionDelivery = params.completionDelivery;
  }
  let attachments: CanonicalSpawnInput["attachments"];
  if (params.attachments !== undefined) {
    if (!Array.isArray(params.attachments)) {
      throw invalidInput('"attachments" must be an array.', "attachments");
    }
    attachments = params.attachments.map((entry, index) => {
      const record = isRecord(entry) ? entry : undefined;
      const mediaType = normalizeOptionalString(record?.mediaType);
      const data = typeof record?.data === "string" ? record.data : "";
      if (!mediaType || !data) {
        throw invalidInput(
          `"attachments[${index}]" requires string mediaType and base64 data.`,
          "attachments",
        );
      }
      return { mediaType, data };
    });
  }
  return {
    task,
    label: requireOptionalStringOption(params.label, "label", { allowEmpty: true }),
    agentId: requireOptionalStringOption(params.agentId, "agentId"),
    cwd,
    model: requireOptionalStringOption(params.model, "model"),
    thinking: requireOptionalStringOption(params.thinking, "thinking"),
    runTimeoutSeconds,
    cleanup,
    idempotencyKey: requireOptionalStringOption(params.idempotencyKey, "idempotencyKey"),
    completionDelivery,
    attachments,
  };
}

/**
 * Requester-bound completion delivery is only honored through the host's own capture of the
 * live hook requester; the plugin never names a session, route, or scope. Outside such an
 * invocation (detached timers, operator requests, tool calls) the option fails closed.
 */
function resolveCompletionRequester(
  input: CanonicalSpawnInput,
): PluginSubagentRequesterContext | undefined {
  try {
    return resolvePluginSubagentCompletionRequester(input.completionDelivery);
  } catch (error) {
    throw invalidInput(
      error instanceof Error ? error.message : String(error),
      "completionDelivery",
    );
  }
}

/**
 * Digest of the canonical input plus the full host-captured completion route. The same key
 * from a different requester session, or from the same session captured on a different
 * channel/account/destination/thread, is a different run; a replay must never route one
 * requester's completion to another destination.
 */
function fingerprintSpawnInput(
  input: CanonicalSpawnInput,
  requester: PluginSubagentRequesterContext | undefined,
): string {
  const { idempotencyKey: _idempotencyKey, ...rest } = input;
  const ordered = Object.fromEntries(
    Object.entries({
      ...rest,
      ...(requester
        ? {
            requesterSessionKey: requester.sessionKey,
            requesterRoute: channelRouteDedupeKey(requester.origin),
          }
        : {}),
    })
      .filter(([, value]) => value !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function idempotencyReceiptKey(idempotencyKey: string, fingerprint: string): string {
  return `${idempotencyKey}\u0000${fingerprint}`;
}

function mapSpawnFailureCode(errorCode: string): PluginAcpErrorCode {
  switch (errorCode) {
    case "acp_disabled":
      return "ACP_PLUGIN_DISABLED";
    case "agent_forbidden":
    case "runtime_agent_mismatch":
      return "ACP_PLUGIN_AGENT_FORBIDDEN";
    case "subagent_policy":
      return "ACP_PLUGIN_ADMISSION_REJECTED";
    case "target_agent_required":
    case "cwd_resolution_failed":
      return "ACP_PLUGIN_INVALID_INPUT";
    default:
      return "ACP_PLUGIN_SPAWN_FAILED";
  }
}

function resolveOwnedRun(
  ownerKey: string,
  lookup: { runId?: string; taskId?: string },
): TaskRecord | undefined {
  const runId = normalizeOptionalString(lookup.runId);
  const taskId = normalizeOptionalString(lookup.taskId);
  if (!runId && !taskId) {
    return undefined;
  }
  // Owner-key index first: a run id is never looked up globally, so another owner's
  // task with the same run id can neither be seen nor acted on.
  const owned = listTasksForOwnerKey(ownerKey).filter(
    (task) => (runId ? task.runId === runId : true) && (taskId ? task.taskId === taskId : true),
  );
  if (owned.length === 0) {
    return undefined;
  }
  owned.sort((left, right) => right.createdAt - left.createdAt);
  return owned.find((task) => isActiveTaskStatus(task.status)) ?? owned[0];
}

function isTrackedPluginAcpTask(task: TaskRecord): boolean {
  return task.runtime === "subagent" && isAcpSessionKey(task.childSessionKey);
}

type OwnedChildSession = { agentId: string; entry: SessionEntry };

/**
 * Rereads the exact child session entry and requires live plugin ownership. Ownership lives
 * on the entry, so foreign, replaced, and missing sessions all resolve to `undefined`.
 */
function loadOwnedChildSession(
  principal: Pick<ResolvedPluginAcpPrincipal, "pluginId" | "cfg">,
  sessionKey: string | undefined,
): OwnedChildSession | undefined {
  const agentId = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
  if (!sessionKey || !agentId || !isAcpSessionKey(sessionKey)) {
    return undefined;
  }
  const entry = loadSessionEntry({
    storePath: resolveSessionStorePathCore(principal.cfg.session?.store, { agentId }),
    sessionKey,
    agentId,
    clone: false,
  });
  return entry && entry.pluginOwnerId === principal.pluginId ? { agentId, entry } : undefined;
}

/** The live task row must still be the same run, child session, and plugin owner. */
function isSameOwnedTaskBinding(
  ownerKey: string,
  task: Pick<TaskRecord, "taskId" | "runId" | "childSessionKey">,
): boolean {
  const current = getTaskById(task.taskId);
  return (
    current !== undefined &&
    current.ownerKey === ownerKey &&
    current.runId === task.runId &&
    current.childSessionKey === task.childSessionKey
  );
}

export function createGatewayAcpRuntime(
  resolveGatewayContext?: GatewayContextResolver,
  runtimeLifetime?: AbortSignal,
): PluginRuntime["acp"] {
  const idempotencyByPlugin = new Map<string, Map<string, IdempotencyEntry>>();
  const activeObservers = new Set<() => void>();
  runtimeLifetime?.addEventListener(
    "abort",
    () => {
      for (const unsubscribe of activeObservers) {
        unsubscribe();
      }
      idempotencyByPlugin.clear();
    },
    { once: true },
  );

  const resolvePrincipal = (): ResolvedPluginAcpPrincipal => {
    if (runtimeLifetime?.aborted) {
      throw new PluginAcpRuntimeError(
        "ACP_PLUGIN_RUNTIME_CLOSED",
        "Plugin ACP runtime was retired with its Gateway; reload the plugin runtime.",
      );
    }
    const scope = getPluginRuntimeGatewayRequestScope();
    const pluginId = normalizeOptionalString(scope?.pluginId);
    if (!pluginId) {
      throw new PluginAcpRuntimeError(
        "ACP_PLUGIN_PRINCIPAL_REQUIRED",
        "api.runtime.acp requires a plugin principal; call it through the plugin's own runtime handle.",
      );
    }
    const context = getInProcessGatewayRequestContext(resolveGatewayContext);
    if (!context) {
      throw new PluginAcpRuntimeError("ACP_PLUGIN_GATEWAY_REQUIRED", GATEWAY_REQUIRED_REASON);
    }
    const cfg = context.getRuntimeConfig();
    // Request mode needs the host-minted lease of a still-running request callback (an
    // ambient client on a retained or mutated scope object grants nothing) or a live
    // requester-bound hook invocation. Both expire when their host callback returns.
    const requestAuthorityLive = () =>
      hasLivePluginRuntimeRequestAuthority(scope) || hasActivePluginSubagentRequesterContext();
    const mode: PluginAcpAuthorityMode = requestAuthorityLive() ? "request" : "detached";
    const detachedAllowed =
      normalizePluginsConfig(cfg.plugins).entries[pluginId]?.acp?.allowDetachedSpawn === true &&
      canTrustedOfficialPluginRequestScopes(scope ?? {});
    return {
      pluginId,
      ownerKey: resolvePluginAcpOwnerKey(pluginId),
      mode,
      context,
      cfg,
      detachedAllowed,
      requestAuthorityLive,
    };
  };

  const detachedForbidden = (principal: ResolvedPluginAcpPrincipal, reason: string) =>
    new PluginAcpRuntimeError(
      "ACP_PLUGIN_DETACHED_FORBIDDEN",
      `Plugin "${principal.pluginId}" ${reason}. Detached ACP spawns require a bundled or trusted official plugin with plugins.entries.${principal.pluginId}.acp.allowDetachedSpawn=true.`,
    );

  const assertSpawnAuthority = (principal: ResolvedPluginAcpPrincipal) => {
    if (principal.mode === "detached" && !principal.detachedAllowed) {
      throw detachedForbidden(principal, "has no live Gateway request");
    }
  };

  const createAssertActive = (principal: ResolvedPluginAcpPrincipal) => () => {
    runtimeLifetime?.throwIfAborted();
    if (getInProcessGatewayRequestContext(resolveGatewayContext) !== principal.context) {
      throw new PluginAcpRuntimeError(
        "ACP_PLUGIN_RUNTIME_CLOSED",
        "Gateway instance changed while the plugin ACP spawn was in flight.",
      );
    }
    // A spawn admitted under request authority must still hold it at every side effect;
    // work the host awaits keeps the lease, an unawaited continuation loses it here.
    if (!principal.detachedAllowed && !principal.requestAuthorityLive()) {
      throw detachedForbidden(principal, "lost its Gateway request while the spawn was in flight");
    }
  };

  const runSpawn = async (
    principal: ResolvedPluginAcpPrincipal,
    input: CanonicalSpawnInput,
    completionRequester: PluginSubagentRequesterContext | undefined,
  ): Promise<PluginAcpSpawnResult> => {
    // The ACP control plane stays off the plugin setup path until a plugin actually spawns.
    const { spawnAcpForPlugin } = await import("../agents/subagents/spawn/acp-spawn-plugin.js");
    const assertActive = createAssertActive(principal);
    assertActive();
    const run = () =>
      spawnAcpForPlugin(
        {
          task: input.task,
          label: input.label,
          agentId: input.agentId,
          cwd: input.cwd,
          model: input.model,
          thinking: input.thinking,
          runTimeoutSeconds: input.runTimeoutSeconds,
          cleanup: input.cleanup,
          attachments: input.attachments,
        },
        {
          pluginId: principal.pluginId,
          ownerKey: principal.ownerKey,
          ...(completionRequester ? { completionRequester } : {}),
          assertActive,
        },
      );
    const result: SpawnAcpForPluginResult = resolveGatewayContext
      ? await withPluginRuntimeGatewayContextResolver(resolveGatewayContext, run)
      : await run();
    if (result.status !== "accepted") {
      throw new PluginAcpRuntimeError(
        mapSpawnFailureCode(result.errorCode),
        result.error,
        result.errorCode,
      );
    }
    const task = resolveOwnedRun(principal.ownerKey, { runId: result.runId });
    return {
      runId: result.runId,
      ...(task ? { taskId: task.taskId } : {}),
      sessionKey: result.childSessionKey,
      agentId: result.targetAgentId,
      runTimeoutSeconds: result.runTimeoutSeconds ?? 0,
    };
  };

  const spawnWithIdempotency = async (
    principal: ResolvedPluginAcpPrincipal,
    input: CanonicalSpawnInput,
    completionRequester: PluginSubagentRequesterContext | undefined,
  ): Promise<PluginAcpSpawnResult> => {
    const key = input.idempotencyKey;
    if (!key) {
      return await runSpawn(principal, input, completionRequester);
    }
    const now = Date.now();
    const entries =
      idempotencyByPlugin.get(principal.pluginId) ?? new Map<string, IdempotencyEntry>();
    idempotencyByPlugin.set(principal.pluginId, entries);
    for (const [existingKey, entry] of entries) {
      if (entry.expiresAt <= now && !entry.pending) {
        entries.delete(existingKey);
      }
    }
    // Receipts are keyed by (key, canonical input). Same key with different input is a
    // distinct request that gets its own receipt without erasing the earlier one, so an
    // A -> B -> A retry within the window replays A. A matching in-flight or accepted spawn
    // replays instead of launching a duplicate; only a failed spawn (evicted below) lets the
    // same tuple run again.
    const receiptKey = idempotencyReceiptKey(
      key,
      fingerprintSpawnInput(input, completionRequester),
    );
    const existing = entries.get(receiptKey);
    if (existing) {
      const replay = existing.result ?? (await existing.pending);
      if (replay) {
        return { ...replay, replayed: true };
      }
    }
    if (entries.size >= PLUGIN_ACP_IDEMPOTENCY_MAX_ENTRIES_PER_PLUGIN) {
      // Pending receipts own in-flight deduplication regardless of age. Only a settled
      // receipt may make room; otherwise refuse admission before launching another run.
      const oldest = [...entries.entries()]
        .filter(([, entry]) => !entry.pending)
        .toSorted(([, left], [, right]) => left.expiresAt - right.expiresAt)[0];
      if (!oldest) {
        throw new PluginAcpRuntimeError(
          "ACP_PLUGIN_ADMISSION_REJECTED",
          "Plugin ACP idempotency capacity is occupied by pending spawns; retry after one settles.",
        );
      }
      entries.delete(oldest[0]);
    }
    const entry: IdempotencyEntry = { expiresAt: now + PLUGIN_ACP_IDEMPOTENCY_TTL_MS };
    entry.pending = runSpawn(principal, input, completionRequester).then(
      (result) => {
        entry.result = result;
        entry.pending = undefined;
        return result;
      },
      (error: unknown) => {
        // Failed spawns never replay; the next attempt with this tuple runs again.
        if (entries.get(receiptKey) === entry) {
          entries.delete(receiptKey);
        }
        throw error;
      },
    );
    entries.set(receiptKey, entry);
    return await entry.pending;
  };

  const acpRuntime: PluginRuntime["acp"] = {
    async isAvailable() {
      let principal: ResolvedPluginAcpPrincipal;
      try {
        principal = resolvePrincipal();
      } catch (error) {
        if (error instanceof PluginAcpRuntimeError) {
          return { ok: false, code: error.code, reason: error.message };
        }
        throw error;
      }
      if (principal.cfg.acp?.enabled === false) {
        return {
          ok: false,
          code: "ACP_PLUGIN_DISABLED",
          reason: "ACP is disabled by policy (`acp.enabled=false`).",
        };
      }
      try {
        assertSpawnAuthority(principal);
      } catch (error) {
        if (error instanceof PluginAcpRuntimeError) {
          return { ok: false, code: error.code, reason: error.message };
        }
        throw error;
      }
      return { ok: true, mode: principal.mode };
    },
    async spawn(params: PluginAcpSpawnParams) {
      const principal = resolvePrincipal();
      const input = normalizeSpawnParams(params);
      const completionRequester = resolveCompletionRequester(input);
      assertSpawnAuthority(principal);
      return await spawnWithIdempotency(principal, input, completionRequester);
    },
    async getRun(params) {
      const principal = resolvePrincipal();
      const task = resolveOwnedRun(principal.ownerKey, params);
      return task && isTrackedPluginAcpTask(task) ? mapTaskRunDetail(task) : undefined;
    },
    async listRuns(params) {
      const principal = resolvePrincipal();
      const includeTerminal = params?.includeTerminal === true;
      const limit =
        params?.limit == null || !Number.isFinite(params.limit)
          ? PLUGIN_ACP_LIST_DEFAULT_LIMIT
          : Math.min(PLUGIN_ACP_LIST_MAX_LIMIT, Math.max(1, Math.floor(params.limit)));
      return listTasksForOwnerKey(principal.ownerKey)
        .filter(
          (task) =>
            isTrackedPluginAcpTask(task) && (includeTerminal || !isTerminalTaskStatus(task.status)),
        )
        .toSorted((left, right) => right.createdAt - left.createdAt)
        .slice(0, limit)
        .map((task) => mapTaskRunView(task));
    },
    async getSession(params) {
      const principal = resolvePrincipal();
      const sessionKey = normalizeOptionalString(params?.sessionKey);
      if (!sessionKey) {
        throw invalidInput('"sessionKey" is required.', "sessionKey");
      }
      const owned = loadOwnedChildSession(principal, sessionKey);
      if (!owned) {
        return undefined;
      }
      const { agentId, entry } = owned;
      const { readAcpSessionMeta } = await import("../acp/runtime/session-meta.js");
      const meta = readAcpSessionMeta({ sessionKey, agentId, cfg: principal.cfg });
      return {
        sessionKey,
        agentId,
        ...(meta?.backend ? { backend: meta.backend } : {}),
        ...(meta?.mode ? { mode: meta.mode } : {}),
        ...(meta?.cwd ? { cwd: meta.cwd } : {}),
        ...(meta?.state ? { state: meta.state } : {}),
        ...(meta?.lastActivityAt != null ? { lastActivityAt: meta.lastActivityAt } : {}),
        ...(meta?.lastError ? { lastError: meta.lastError } : {}),
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
        ...(entry.updatedAt != null ? { updatedAt: entry.updatedAt } : {}),
      };
    },
    async waitForRun(params) {
      const principal = resolvePrincipal();
      const runId = normalizeOptionalString(params?.runId);
      if (!runId) {
        throw invalidInput('"runId" is required.', "runId");
      }
      if (!resolveOwnedRun(principal.ownerKey, { runId })) {
        throw new PluginAcpRuntimeError(
          "ACP_PLUGIN_RUN_NOT_FOUND",
          `No ACP run "${runId}" is owned by plugin "${principal.pluginId}".`,
        );
      }
      return await waitForGatewayAgentRun(
        { runId, timeoutMs: params.timeoutMs },
        resolveGatewayContext,
      );
    },
    async cancel(params) {
      const principal = resolvePrincipal();
      const runId = normalizeOptionalString(params?.runId);
      if (!runId) {
        throw invalidInput('"runId" is required.', "runId");
      }
      const notFound = { found: false, cancelled: false, reason: "Task not found." };
      const task = resolveOwnedRun(principal.ownerKey, { runId });
      if (!task) {
        return notFound;
      }
      // Final reread immediately before the canonical cancel: the child session entry must
      // still name this plugin as owner and the live task row must still bind the same run
      // and session to this owner. A session replaced, released, or re-owned after the
      // lookup above is indistinguishable from a missing run, and cancellation never starts.
      if (
        !loadOwnedChildSession(principal, task.childSessionKey) ||
        !isSameOwnedTaskBinding(principal.ownerKey, task)
      ) {
        return notFound;
      }
      return mapCancelledTaskResult(
        await cancelDetachedTaskRunById({
          cfg: principal.cfg,
          taskId: task.taskId,
          ...(params.reason ? { reason: params.reason } : {}),
        }),
      );
    },
    async observe(params, listener) {
      const principal = resolvePrincipal();
      const runId = normalizeOptionalString(params?.runId);
      if (!runId) {
        throw invalidInput('"runId" is required.', "runId");
      }
      if (typeof listener !== "function") {
        throw invalidInput("observe requires a listener function.", "listener");
      }
      const task = resolveOwnedRun(principal.ownerKey, { runId });
      if (!task) {
        throw new PluginAcpRuntimeError(
          "ACP_PLUGIN_RUN_NOT_FOUND",
          `No ACP run "${runId}" is owned by plugin "${principal.pluginId}".`,
        );
      }
      const maxEvents =
        params.maxEvents == null || !Number.isFinite(params.maxEvents)
          ? PLUGIN_ACP_OBSERVE_DEFAULT_MAX_EVENTS
          : Math.min(PLUGIN_ACP_OBSERVE_MAX_EVENTS, Math.max(1, Math.floor(params.maxEvents)));
      const signal = params.signal;
      if (isTerminalTaskStatus(task.status) || signal?.aborted || runtimeLifetime?.aborted) {
        return () => {};
      }
      let delivered = 0;
      let stopped = false;
      // Subscribing never emits synchronously, so `stop` is initialized before any event
      // can reach this listener.
      const unsubscribeEvents = onAgentEventForRun(runId, (evt) => {
        const stream = toObservedStream(evt.stream);
        if (stopped || !stream) {
          return;
        }
        delivered += 1;
        const phase = evt.data.phase;
        const terminal = evt.stream === "lifecycle" && (phase === "end" || phase === "error");
        const truncated = !terminal && delivered >= maxEvents;
        const event: PluginAcpObserveEvent = {
          runId,
          seq: evt.seq,
          ts: evt.ts,
          stream,
          data: evt.data,
          ...(truncated ? { truncated: true } : {}),
        };
        if (terminal || truncated) {
          stop();
        }
        listener(event);
      });
      const stop = () => {
        if (stopped) {
          return;
        }
        stopped = true;
        unsubscribeEvents();
        signal?.removeEventListener("abort", stop);
        activeObservers.delete(stop);
      };
      signal?.addEventListener("abort", stop, { once: true });
      activeObservers.add(stop);
      return stop;
    },
  };
  if (resolveGatewayContext) {
    bindGatewayContextResolver(acpRuntime, resolveGatewayContext);
  }
  return acpRuntime;
}
