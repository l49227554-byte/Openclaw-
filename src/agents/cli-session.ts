/**
 * CLI session persistence helpers.
 * Keeps provider-keyed session bindings and reuse fingerprints in one
 * normalized session-store contract.
 */
import crypto from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { normalizeCliSessionReseedReceipt } from "../config/sessions/cli-session-binding.js";
import { readErrorName } from "../infra/errors.js";
import { isFailoverError } from "./failover-error.js";
import type { FailoverReason } from "./failover/signal.js";
export {
  clearAllCliSessions,
  getCliSessionBinding,
} from "../config/sessions/cli-session-binding.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

/**
 * Default epoch-encoding version assumed when a caller omits `authEpochVersion`.
 * Mirrors `CLI_AUTH_EPOCH_VERSION` (kept in sync by an assertion in the epoch
 * tests) so the production reuse path need not thread the constant explicitly.
 */
const DEFAULT_CLI_AUTH_EPOCH_VERSION = 7;

/** Whether a failover proves the provider-side conversation can no longer be resumed. */
export function isCliSessionInvalidatingFailoverReason(reason: FailoverReason): boolean {
  // Auth identity changes are handled by the reuse fingerprint's auth epoch.
  // Other execution failures say nothing about the persisted transcript.
  return reason === "session_expired";
}

/** Hash CLI session-sensitive text so reuse checks can compare stable fingerprints. */
export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

/** Projects explicit native continuity; diagnostic sessionId can name the local session. */
export function applyCliSessionBindingResult(
  entry: SessionEntry,
  provider: string,
  meta?: {
    cliSessionBinding?: CliSessionBinding;
    clearCliSessionBinding?: boolean;
  },
): boolean {
  if (meta?.clearCliSessionBinding === true) {
    clearCliSession(entry, provider);
  } else if (meta?.cliSessionBinding?.sessionId.trim()) {
    setCliSessionBinding(entry, provider, meta.cliSessionBinding);
  } else {
    return false;
  }
  return true;
}

/** Revalidates the exact turn owner at native continuity's synchronous commit edge. */
export function assertCliSessionBindingResultCommitAllowed(
  meta: { clearCliSessionBinding?: boolean } | undefined,
  assertSettlementCurrent: () => void,
  abortSignal?: AbortSignal,
): void {
  assertSettlementCurrent();
  // Explicit invalidation is owner cleanup: abort may clear an unusable
  // handle, but never through a closed, released, or replaced turn.
  if (meta?.clearCliSessionBinding !== true) {
    abortSignal?.throwIfAborted();
  }
}

/** Store a CLI session binding and mirror it to the provider-keyed session-id map. */
export function setCliSessionBinding(
  entry: SessionEntry,
  provider: string,
  binding: CliSessionBinding,
): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = binding.sessionId.trim();
  if (!trimmed) {
    return;
  }
  const previousBinding = entry.cliSessionBindings?.[normalized];
  const previousReceipt =
    normalizeOptionalString(previousBinding?.sessionId) === trimmed
      ? normalizeCliSessionReseedReceipt(previousBinding?.reseedReceipt)
      : undefined;
  const reseedReceipt = normalizeCliSessionReseedReceipt(binding.reseedReceipt) ?? previousReceipt;
  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: {
      sessionId: trimmed,
      ...(normalizeOptionalString(binding.resumeCheckpointId)
        ? { resumeCheckpointId: normalizeOptionalString(binding.resumeCheckpointId) }
        : {}),
      ...(binding.forceReuse === true ? { forceReuse: true } : {}),
      ...(binding.forkNextResume === true ? { forkNextResume: true } : {}),
      ...(normalizeOptionalString(binding.authProfileId)
        ? { authProfileId: normalizeOptionalString(binding.authProfileId) }
        : {}),
      ...(normalizeOptionalString(binding.authEpoch)
        ? { authEpoch: normalizeOptionalString(binding.authEpoch) }
        : {}),
      ...(typeof binding.authEpochVersion === "number" && Number.isFinite(binding.authEpochVersion)
        ? { authEpochVersion: binding.authEpochVersion }
        : {}),
      ...(normalizeOptionalString(binding.extraSystemPromptHash)
        ? { extraSystemPromptHash: normalizeOptionalString(binding.extraSystemPromptHash) }
        : {}),
      ...(normalizeOptionalString(binding.messageToolPolicyHash)
        ? { messageToolPolicyHash: normalizeOptionalString(binding.messageToolPolicyHash) }
        : {}),
      ...(normalizeOptionalString(binding.promptToolNamesHash)
        ? { promptToolNamesHash: normalizeOptionalString(binding.promptToolNamesHash) }
        : {}),
      ...(normalizeOptionalString(binding.cwdHash)
        ? { cwdHash: normalizeOptionalString(binding.cwdHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpConfigHash)
        ? { mcpConfigHash: normalizeOptionalString(binding.mcpConfigHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpResumeHash)
        ? { mcpResumeHash: normalizeOptionalString(binding.mcpResumeHash) }
        : {}),
      ...(reseedReceipt ? { reseedReceipt } : {}),
    },
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
}

/** Remove the stored CLI session binding for one provider. */
export function clearCliSession(entry: SessionEntry, provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (entry.cliSessionBindings?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionBindings };
    delete next[normalized];
    entry.cliSessionBindings = Object.keys(next).length > 0 ? next : undefined;
  }
  if (entry.cliSessionIds?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionIds };
    delete next[normalized];
    entry.cliSessionIds = Object.keys(next).length > 0 ? next : undefined;
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = undefined;
  }
}

/** Cancellation invalidates an unfinished replacement, not established continuity. */
export function shouldClearInterruptedCliSessionBinding(params: {
  interrupted: boolean;
  bindingReplacedDuringRun: boolean;
}): boolean {
  return params.interrupted && params.bindingReplacedDuringRun;
}

/** Decide whether a failed CLI turn invalidates the binding it tried to resume. */
export function shouldClearFailedCliSessionBinding(params: {
  error: unknown;
  binding?: CliSessionBinding;
  bindingReplacedDuringRun?: boolean;
  hasNewGeneratedMediaTask?: boolean;
}): boolean {
  if (!normalizeOptionalString(params.binding?.sessionId)) {
    return false;
  }
  // Detached media delivers back into this run later and still needs the binding.
  if (params.hasNewGeneratedMediaTask === true) {
    return false;
  }
  if (isFailoverError(params.error)) {
    return isCliSessionInvalidatingFailoverReason(params.error.reason);
  }
  return shouldClearInterruptedCliSessionBinding({
    interrupted: readErrorName(params.error) === "AbortError",
    bindingReplacedDuringRun: params.bindingReplacedDuringRun === true,
  });
}

/** Stable reason used when recording why a failed reused CLI session was cleared. */
export function resolveCliSessionClearReason(error: unknown): string {
  return isFailoverError(error) ? error.reason : (readErrorName(error) ?? "error");
}

type CliSessionInvalidatedReason = "auth-profile" | "auth-epoch" | "message-policy" | "cwd" | "mcp";

type CliSessionContentDriftReason = "system-prompt" | "prompt-tools";

export type CliSessionReuseResult =
  | { mode: "none" }
  | { mode: "reuse"; sessionId: string }
  | {
      mode: "reuse-with-drift";
      sessionId: string;
      drift: { reasons: CliSessionContentDriftReason[] };
    }
  | { mode: "invalidate"; invalidatedReason: CliSessionInvalidatedReason };

const CLI_SESSION_DRIFT_NOTE_PREFIX =
  "OpenClaw resumed this CLI session after prompt content changed.";

/** User-turn note telling a resumed CLI session that its prompt content drifted. */
export function buildCliSessionDriftNote(reasons: readonly CliSessionContentDriftReason[]): string {
  return `${CLI_SESSION_DRIFT_NOTE_PREFIX} Follow the current turn's instructions; changed=${reasons.join(",")}.`;
}

const CLI_SESSION_DRIFT_NOTE_PREFIXES = [
  buildCliSessionDriftNote(["system-prompt"]),
  buildCliSessionDriftNote(["prompt-tools"]),
  buildCliSessionDriftNote(["system-prompt", "prompt-tools"]),
].map((note) => `${note}\n\n`);

// Match only complete notes the producer emits; similar native user text is not context.
export function stripCliSessionDriftNote(text: string): string {
  for (const prefix of CLI_SESSION_DRIFT_NOTE_PREFIXES) {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length);
    }
  }
  return text;
}

/**
 * Report whether the operator declared `storedProfileId` and `currentProfileId`
 * as their OWN equivalent identities — i.e. whether some SINGLE group in
 * `historyEquivalenceGroups` contains BOTH (normalized) ids, and the ids are
 * distinct. Membership is decided per group, so overlapping groups such as
 * `[["a","b"],["b","c"]]` correctly recognize the `b`↔`c` swap via the second
 * group in either direction; a swap whose endpoints never co-occur in one group,
 * or a same-profile pair (ids equal), returns `false` and keeps today's strict
 * per-profile invalidation.
 */
function areOperatorEquivalentProfiles(
  historyEquivalenceGroups: readonly (readonly string[])[] | undefined,
  storedProfileId: string | undefined,
  currentProfileId: string | undefined,
): boolean {
  const stored = normalizeOptionalString(storedProfileId);
  const current = normalizeOptionalString(currentProfileId);
  if (!stored || !current || stored === current || !historyEquivalenceGroups) {
    return false;
  }
  for (const group of historyEquivalenceGroups) {
    let containsStored = false;
    let containsCurrent = false;
    for (const member of group) {
      const normalized = normalizeOptionalString(member);
      if (normalized === undefined) {
        continue;
      }
      if (normalized === stored) {
        containsStored = true;
      }
      if (normalized === current) {
        containsCurrent = true;
      }
    }
    if (containsStored && containsCurrent) {
      return true;
    }
  }
  return false;
}

/** Decide whether a stored CLI session can be reused for the current auth/prompt/cwd/MCP state. */
export function resolveCliSessionReuse(params: {
  binding?: CliSessionBinding;
  authProfileId?: string;
  authEpoch?: string;
  /** Epoch-encoding version; defaults to the current runtime version when omitted. */
  authEpochVersion?: number;
  extraSystemPromptHash?: string;
  messageToolPolicyHash?: string;
  promptToolNamesHash?: string;
  cwdHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  /**
   * Operator-declared groups of auth profile ids that name the SAME person's own
   * equivalent identities (`auth.historyEquivalenceGroups`, passed straight from
   * config). A failover BETWEEN two profiles that share a declared group is a
   * routing change of the operator's own identities, not a cross-account identity
   * change, so it must not discard the reused session's transcript. Undefined or a
   * profile that shares no group preserves today's strict per-profile
   * invalidation byte-for-byte.
   */
  historyEquivalenceGroups?: readonly (readonly string[])[];
}): CliSessionReuseResult {
  const binding = params.binding;
  const sessionId = normalizeOptionalString(binding?.sessionId);
  if (!sessionId) {
    return { mode: "none" };
  }
  if (binding?.forceReuse === true) {
    return { mode: "reuse", sessionId };
  }
  const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
  const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
  const authEpochVersion = params.authEpochVersion ?? DEFAULT_CLI_AUTH_EPOCH_VERSION;
  const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
  const currentMessageToolPolicyHash = normalizeOptionalString(params.messageToolPolicyHash);
  const currentPromptToolNamesHash = normalizeOptionalString(params.promptToolNamesHash);
  const currentCwdHash = normalizeOptionalString(params.cwdHash);
  const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
  const currentMcpResumeHash = normalizeOptionalString(params.mcpResumeHash);
  const storedAuthProfileId = normalizeOptionalString(binding?.authProfileId);
  const storedAuthEpoch = normalizeOptionalString(binding?.authEpoch);
  const hasMatchingVersionedAuthEpoch =
    binding?.authEpochVersion === authEpochVersion &&
    storedAuthEpoch !== undefined &&
    currentAuthEpoch !== undefined &&
    storedAuthEpoch === currentAuthEpoch;
  // A failover BETWEEN two operator-declared-equivalent profiles rebinds the
  // live session's profile id and its per-leg auth epoch. That is a routing
  // change of the operator's OWN identities, so it must not discard the reused
  // transcript. Gate strictly on the stored and current ids being distinct
  // profiles that co-occur in a SINGLE declared group (per-group membership, so
  // overlapping groups resolve in both directions): a same-profile credential
  // rotation (ids equal) still falls through to the epoch check below, and a
  // swap whose endpoints never share a group keeps today's strict cross-account
  // guard.
  const isOperatorEquivalentProfileSwap = areOperatorEquivalentProfiles(
    params.historyEquivalenceGroups,
    storedAuthProfileId,
    currentAuthProfileId,
  );
  if (storedAuthProfileId !== currentAuthProfileId) {
    if (!hasMatchingVersionedAuthEpoch && !isOperatorEquivalentProfileSwap) {
      return { mode: "invalidate", invalidatedReason: "auth-profile" };
    }
  }
  if (
    binding?.authEpochVersion === authEpochVersion &&
    storedAuthEpoch !== currentAuthEpoch &&
    !isOperatorEquivalentProfileSwap
  ) {
    return { mode: "invalidate", invalidatedReason: "auth-epoch" };
  }
  const storedMessageToolPolicyHash = normalizeOptionalString(binding?.messageToolPolicyHash);
  if (storedMessageToolPolicyHash !== currentMessageToolPolicyHash) {
    return { mode: "invalidate", invalidatedReason: "message-policy" };
  }
  const storedCwdHash = normalizeOptionalString(binding?.cwdHash);
  if (storedCwdHash !== undefined && storedCwdHash !== currentCwdHash) {
    return { mode: "invalidate", invalidatedReason: "cwd" };
  }
  const storedMcpResumeHash = normalizeOptionalString(binding?.mcpResumeHash);
  if (storedMcpResumeHash && currentMcpResumeHash) {
    // Resume hashes are stricter than raw MCP config hashes: a match proves the
    // exact resumed CLI tool topology still belongs to this session.
    if (storedMcpResumeHash !== currentMcpResumeHash) {
      return { mode: "invalidate", invalidatedReason: "mcp" };
    }
  } else {
    const storedMcpConfigHash = normalizeOptionalString(binding?.mcpConfigHash);
    if (storedMcpConfigHash !== currentMcpConfigHash) {
      return { mode: "invalidate", invalidatedReason: "mcp" };
    }
  }

  const driftReasons: CliSessionContentDriftReason[] = [];
  const storedExtraSystemPromptHash = normalizeOptionalString(binding?.extraSystemPromptHash);
  if (storedExtraSystemPromptHash !== currentExtraSystemPromptHash) {
    driftReasons.push("system-prompt");
  }
  const storedPromptToolNamesHash = normalizeOptionalString(binding?.promptToolNamesHash);
  if (storedPromptToolNamesHash !== currentPromptToolNamesHash) {
    driftReasons.push("prompt-tools");
  }
  if (driftReasons.length > 0) {
    // Content drift resumes by contract (#99729): the transcript remains usable.
    // Deleting this binding here makes queued turns spawn without session history.
    return { mode: "reuse-with-drift", sessionId, drift: { reasons: driftReasons } };
  }
  return { mode: "reuse", sessionId };
}
