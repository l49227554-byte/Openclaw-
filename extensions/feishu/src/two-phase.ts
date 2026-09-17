/**
 * @file two-phase.ts — opt-in "two-phase" Feishu reply UX.
 *
 * Pure, dependency-free logic (no I/O, no openclaw/feishu runtime imports) so
 * the whole behaviour can be unit-tested without a network, SDK, or loaded host.
 *
 * Lifecycle:
 *  - The official streaming card is reused as the live "processing" card.
 *  - While the turn runs, only a tool timeline is rendered as its status line.
 *    The streaming answer text is intentionally never shown in that card.
 *  - On the final reply the processing card is settled with a one-line collapsed
 *    summary; the full answer is delivered as a separate green result card.
 *  - Rich presentation cards, media/voice, error notices, duplicate/over-long
 *    answers, and zero-tool turns use the official delivery path; `eligible`
 *    encodes every guard so the dispatcher's fallback stays mechanical.
 *
 * No function here throws on partial or missing data; every input degrades.
 */

export const TWO_PHASE_COLLAPSED_TITLE = "已完成";
export const TWO_PHASE_RESULT_TITLE = "结果";

const RUNNING_ICON = "⏳";
const DONE_ICON = "✅";

/** Clock abstraction so timeline elapsed time is deterministic in tests. */
export type TwoPhaseClock = () => number;

/** Raw `channels.feishu.twoPhase` (or `accounts.<id>.twoPhase`) config value. */
export type TwoPhaseConfig = {
  /** Master switch. Defaults to false; the feature is entirely opt-in. */
  enabled?: boolean;
  /** Render the grey model/provider/token/duration footer. Defaults to true. */
  footerMeta?: boolean;
};

export type TwoPhaseToolStatus = "running" | "done";

export type TwoPhaseTool = {
  toolCallId: string;
  name: string;
  status: TwoPhaseToolStatus;
  startedAt: number;
  endedAt?: number;
  progressText?: string;
  summary?: string;
};

/** Subset of the host `onToolStart` payload used by the timeline. */
export type TwoPhaseToolStartPayload = {
  itemId?: string;
  toolCallId?: string;
  name?: string;
  phase?: string;
};

/** Subset of the host `onItemEvent` payload used by the timeline. */
export type TwoPhaseItemEventPayload = {
  itemId?: string;
  toolCallId?: string;
  kind?: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  progressText?: string;
};

export type TwoPhaseModelInfo = {
  provider?: unknown;
  model?: unknown;
};

export type TwoPhaseFooterMeta = {
  /** Agent label; rendered only when present. */
  agent?: string;
  /** Model name; normally captured via noteModel, overridable per call. */
  model?: string;
  /** Provider id; normally captured via noteModel, overridable per call. */
  provider?: string;
  /** Total token usage; rendered only when a real number is supplied. */
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Turn duration in milliseconds. */
  durationMs?: number;
};

export type RenderCollapsedOptions = {
  title?: string;
  now?: number;
  maxChars?: number;
};

export type BuildResultCardOptions = {
  footer?: string;
  title?: string;
};

export type EligibleParams = {
  /** Resolved account value of `twoPhase.enabled`. */
  twoPhaseEnabled: boolean;
  /** Delivery info kind; only "final" replies take the two-phase path. */
  kind: string | undefined;
  /** Final answer text; empty/whitespace answers are not eligible. */
  text: string | undefined;
  /** At least one timeline row exists (zero-tool turns stay official). */
  hasActivity: boolean;
  /** A native/presentation card is rendered independently. */
  hasIndependentPresentation: boolean;
  /** The payload carries media or voice attachments. */
  hasMedia: boolean;
  /** Error notices must keep the official delivery path. */
  isError: boolean;
  /** Answer fits a single static card envelope. */
  withinCardLimit: boolean;
};

function truncate(text: unknown, max: number): string {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** Format an elapsed duration: "<1s" as ms, "<10s" with one decimal, else rounded. */
export function fmtElapsed(start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number" || end < start) {
    return "";
  }
  const ms = end - start;
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** Compact token counts: 12345 -> "12k", 1_500_000 -> "1.50m". */
export function fmtTokens(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    return "";
  }
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  }
  return `${(n / 1_000_000).toFixed(2)}m`;
}

/** Trim trailing whitespace so markdown line breaks cannot be smuggled in. */
function trimTrailingWhitespace(text: unknown): string {
  return String(text ?? "").replace(/\s+$/g, "");
}

function toolLine(tool: TwoPhaseTool, maxLineChars = 120): string {
  const icon = tool.status === "running" ? RUNNING_ICON : DONE_ICON;
  const name = tool.name || "tool";
  const hint =
    tool.status === "done" && tool.summary
      ? truncate(tool.summary, 40)
      : tool.progressText
        ? truncate(tool.progressText, 40)
        : "";
  const label = hint ? `${name} · ${hint}` : name;
  const elapsed =
    tool.status === "done" ? fmtElapsed(tool.startedAt, tool.endedAt) : "";
  return `${icon} ${trimTrailingWhitespace(truncate(label, maxLineChars))}${
    elapsed ? `  \`${elapsed}\`` : ""
  }`;
}

/** Render the live timeline markdown shown inside the processing card. */
export function renderLiveTimeline(
  state: { narration?: string; tools: TwoPhaseTool[] },
  options?: { maxLines?: number; narration?: string },
): string {
  const maxLines = options?.maxLines ?? 8;
  const narration = options?.narration ?? state.narration ?? "";
  const lines: string[] = [];
  if (narration.trim()) {
    lines.push(`**${trimTrailingWhitespace(narration)}**`);
  }
  for (const tool of state.tools.slice(-maxLines)) {
    lines.push(toolLine(tool));
  }
  return lines.length ? lines.join("\n") : " ";
}

function deriveConclusionSource(tools: TwoPhaseTool[]): string | undefined {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i];
    if (tool?.status !== "done") {
      continue;
    }
    const summary = (tool.summary ?? "").trim();
    if (summary) {
      return summary;
    }
    return tool.name || "tool";
  }
  return undefined;
}

/** One-line collapsed summary retained after the turn completes. */
export function renderCollapsed(
  state: {
    tools: TwoPhaseTool[];
    createdAt: number;
    conclusionSource?: string;
  },
  options?: RenderCollapsedOptions,
): string {
  const title = options?.title ?? TWO_PHASE_COLLAPSED_TITLE;
  const now = options?.now ?? Date.now();
  const maxChars = options?.maxChars ?? 100;
  const done = state.tools.filter((tool) => tool.status === "done").length;
  const total = state.tools.length;
  const elapsed = fmtElapsed(state.createdAt, now);
  const source = state.conclusionSource || deriveConclusionSource(state.tools);
  const tail: string[] = [];
  if (source) {
    tail.push(`来源:${trimTrailingWhitespace(source)}`);
  }
  if (total > 0) {
    tail.push(`${done}/${total} 步`);
  }
  if (elapsed) {
    tail.push(elapsed);
  }
  const head = `${DONE_ICON} **${title}**`;
  const line = tail.length ? `${head}  \`${tail.join(" · ")}\`` : head;
  return truncate(line, maxChars);
}

/**
 * Grey footer for the green result card. Only present fields render; returns ""
 * when there is nothing to show. Token/duration values are never invented.
 */
export function renderFooter(meta: TwoPhaseFooterMeta = {}): string {
  const identity = (["agent", "model", "provider"] as const)
    .map((key) => {
      const value = meta[key];
      if (!value || !key) {
        return "";
      }
      const label = `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
      return `${label}: ${trimTrailingWhitespace(String(value))}`;
    })
    .filter(Boolean)
    .join(" | ");
  const parts: string[] = [];
  const total =
    typeof meta.totalTokens === "number"
      ? meta.totalTokens
      : typeof meta.inputTokens === "number" || typeof meta.outputTokens === "number"
        ? (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0)
        : undefined;
  const tokenLabel = total === undefined ? "" : fmtTokens(total);
  if (tokenLabel) {
    parts.push(`${tokenLabel} tokens`);
  }
  const duration = fmtElapsed(0, meta.durationMs ?? -1);
  if (duration) {
    parts.push(`耗时 ${duration}`);
  }
  const segments: string[] = [];
  if (identity) {
    segments.push(identity);
  }
  if (parts.length) {
    segments.push(parts.join(" · "));
  }
  return segments.length ? `<font color='grey'>${segments.join("　　")}</font>` : "";
}

/** Build the independent green result card carrying the full final answer. */
export function buildResultCard(
  finalText: string,
  options?: BuildResultCardOptions,
): Record<string, unknown> {
  const footer = options?.footer ?? "";
  const title = options?.title ?? TWO_PHASE_RESULT_TITLE;
  const elements: Record<string, unknown>[] = [{ tag: "markdown", content: finalText }];
  if (footer) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: footer });
  }
  return {
    schema: "2.0",
    config: { width_mode: "fill" },
    header: { title: { tag: "plain_text", content: title }, template: "green" },
    body: { elements },
  };
}

export type TwoPhaseController = {
  /** Resolved master switch for this turn. */
  enabled: boolean;
  /** Capture provider/model from the host onModelSelected callback. */
  noteModel: (info?: TwoPhaseModelInfo | null) => void;
  /** Record or refresh a running tool row; returns the live timeline markdown. */
  toolStart: (event?: TwoPhaseToolStartPayload) => string;
  /** Apply a host item event (progress/summary/completion); returns timeline. */
  itemEvent: (event?: TwoPhaseItemEventPayload) => string;
  /** Replace the utility-model narration headline; returns the timeline. */
  setNarration: (text: string) => string;
  /** Settle all running rows and produce the collapsed one-liner. */
  collapse: (options?: RenderCollapsedOptions) => string;
  /** Whether at least one tool timeline row exists. */
  hasActivity: () => boolean;
  /** Current live timeline markdown. */
  timeline: () => string;
  /** Footer markdown for the result card; "" when disabled/unavailable. */
  footer: (extra?: TwoPhaseFooterMeta) => string;
  /** Build the green result card. */
  buildResultCard: (
    finalText: string,
    options?: BuildResultCardOptions,
  ) => Record<string, unknown>;
  /** Guard so the green result card is emitted at most once per turn. */
  markFinalSent: () => boolean;
  readonly finalSent: boolean;
};

/**
 * Create a turn-scoped two-phase controller. The dispatcher constructs one per
 * inbound message, so tool rows and final-sent state never leak across turns.
 */
export function createTwoPhase(
  cfg?: TwoPhaseConfig | null,
  deps?: { now?: TwoPhaseClock },
): TwoPhaseController {
  const now: TwoPhaseClock =
    typeof deps?.now === "function" ? deps.now : () => Date.now();
  const enabled = cfg?.enabled === true;
  const footerEnabled = cfg?.footerMeta !== false;
  const createdAt = now();
  const state: {
    narration: string;
    tools: TwoPhaseTool[];
    conclusionSource?: string;
    createdAt: number;
  } = {
    narration: "",
    tools: [],
    createdAt,
  };
  const captured: { provider?: string; model?: string } = {};
  let finalSent = false;

  const timeline = () => renderLiveTimeline(state);

  return {
    enabled,

    noteModel(info) {
      if (!info || typeof info !== "object") {
        return;
      }
      if (info.provider) {
        captured.provider = String(info.provider);
      }
      if (info.model) {
        captured.model = String(info.model);
      }
    },

    toolStart(event = {}) {
      const id = event.toolCallId || event.itemId;
      if (id) {
        state.tools = state.tools.filter((tool) => tool.toolCallId !== id);
        state.tools.push({
          toolCallId: id,
          name: event.name ?? "tool",
          status: "running",
          startedAt: now(),
        });
      }
      return timeline();
    },

    itemEvent(event = {}) {
      const id = event.toolCallId || event.itemId;
      if (!id) {
        return timeline();
      }
      let matched = false;
      state.tools = state.tools.map((tool) => {
        if (tool.toolCallId !== id) {
          return tool;
        }
        matched = true;
        const next: TwoPhaseTool = { ...tool };
        if (event.progressText !== undefined) {
          next.progressText = String(event.progressText);
        }
        if (event.summary !== undefined) {
          next.summary = String(event.summary);
        }
        if (event.phase === "end" || event.status === "completed" || event.status === "done") {
          next.status = "done";
          next.endedAt = now();
        }
        return next;
      });
      if (!matched && (event.name || event.kind)) {
        const done = event.phase === "end" || event.status === "completed" || event.status === "done";
        state.tools.push({
          toolCallId: id,
          name: event.name ?? event.kind ?? "tool",
          status: done ? "done" : "running",
          startedAt: now(),
          ...(done ? { endedAt: now() } : {}),
        });
      }
      return timeline();
    },

    setNarration(text) {
      state.narration = typeof text === "string" ? text : "";
      return timeline();
    },

    collapse(options) {
      const end = options?.now ?? now();
      state.tools = state.tools.map((tool) =>
        tool.status === "running" ? { ...tool, status: "done" as const, endedAt: end } : tool,
      );
      return renderCollapsed(state, { ...(options ? options : {}), now: end });
    },

    hasActivity() {
      return state.tools.length > 0;
    },

    timeline,

    footer(extra = {}) {
      if (!footerEnabled) {
        return "";
      }
      return renderFooter({
        ...(captured.provider ? { provider: captured.provider } : {}),
        ...(captured.model ? { model: captured.model } : {}),
        ...extra,
        durationMs:
          typeof extra.durationMs === "number" ? extra.durationMs : now() - createdAt,
      });
    },

    buildResultCard: (finalText, options) => buildResultCard(finalText, options),

    markFinalSent() {
      if (finalSent) {
        return false;
      }
      finalSent = true;
      return true;
    },

    get finalSent() {
      return finalSent;
    },
  };
}

/**
 * Decide whether a final outbound payload should take the two-phase path.
 * Every rejection reason maps to a case the official delivery path already
 * handles correctly (chunking, media, native cards, errors, duplicates).
 */
export function eligible(params: EligibleParams): boolean {
  const text = params.text ?? "";
  return Boolean(
    params.twoPhaseEnabled &&
      params.kind === "final" &&
      params.hasActivity &&
      !params.isError &&
      text.trim().length > 0 &&
      !params.hasIndependentPresentation &&
      !params.hasMedia &&
      params.withinCardLimit,
  );
}
