/** Stable plugin session-extension namespace for host-visible model selection state. */
export const MODEL_SELECTION_EXTENSION_NAMESPACE = "model-selection";

export const MODEL_SELECTION_MODES = ["auto", "shadow", "off"] as const;
export type ModelSelectionMode = (typeof MODEL_SELECTION_MODES)[number];

export type SessionModelSelectionDecision = {
  /** Provider-qualified model selected by the decision engine, when known. */
  model?: string;
  /** Short, sanitized reason supplied by the decision engine. */
  reason?: string;
  /** Epoch milliseconds when the decision was made. */
  at?: number;
};

export type SessionModelSelection = {
  mode: ModelSelectionMode;
  /** Short, sanitized recovery instruction advertised by the active plugin. */
  recoveryHint?: string;
  lastDecision?: SessionModelSelectionDecision;
};

type ProjectedSessionExtension = {
  namespace?: unknown;
  value?: unknown;
};

const MAX_DECISION_TEXT_LENGTH = 160;

function normalizeShortText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    // Control-character stripping is the purpose of this sanitizer.
    // oxlint-disable-next-line eslint/no-control-regex -- Intentional control-character sanitization for host-visible text.
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return normalized ? normalized.slice(0, MAX_DECISION_TEXT_LENGTH) : undefined;
}

function normalizeMode(value: unknown): ModelSelectionMode | undefined {
  return MODEL_SELECTION_MODES.includes(value as ModelSelectionMode)
    ? (value as ModelSelectionMode)
    : undefined;
}

/**
 * Normalize the public projection so status and UI consumers never trust raw
 * plugin-owned JSON. Prompt text and arbitrary plugin fields are intentionally
 * excluded from the projection.
 */
export function normalizeSessionModelSelection(value: unknown): SessionModelSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    mode?: unknown;
    recoveryHint?: unknown;
    lastDecision?: unknown;
  };
  const mode = normalizeMode(candidate.mode);
  if (!mode) {
    return undefined;
  }
  const recoveryHint = normalizeShortText(candidate.recoveryHint);
  const rawDecision = candidate.lastDecision;
  let lastDecision: SessionModelSelectionDecision | undefined;
  if (rawDecision && typeof rawDecision === "object" && !Array.isArray(rawDecision)) {
    const decision = rawDecision as { model?: unknown; reason?: unknown; at?: unknown };
    const model = normalizeShortText(decision.model);
    const reason = normalizeShortText(decision.reason);
    const at =
      typeof decision.at === "number" && Number.isFinite(decision.at) && decision.at >= 0
        ? decision.at
        : undefined;
    if (model || reason || at !== undefined) {
      lastDecision = {
        ...(model ? { model } : {}),
        ...(reason ? { reason } : {}),
        ...(at !== undefined ? { at } : {}),
      };
    }
  }
  return {
    mode,
    ...(recoveryHint ? { recoveryHint } : {}),
    ...(lastDecision ? { lastDecision } : {}),
  };
}

/**
 * Resolve the active model-selection extension from the host's projected
 * extension list. An unloaded or disabled plugin has no active projection, so
 * stale raw session state cannot make status or Control UI claim Auto mode.
 */
export function resolveSessionModelSelectionFromExtensions(
  extensions: ReadonlyArray<ProjectedSessionExtension> | undefined,
): SessionModelSelection | undefined {
  if (!extensions) {
    return undefined;
  }
  for (const extension of extensions) {
    if (extension.namespace !== MODEL_SELECTION_EXTENSION_NAMESPACE) {
      continue;
    }
    const normalized = normalizeSessionModelSelection(extension.value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}
