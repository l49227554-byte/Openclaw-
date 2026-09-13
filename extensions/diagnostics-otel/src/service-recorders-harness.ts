import { SpanStatusCode } from "@opentelemetry/api";
import {
  normalizeDiagnosticValue,
  normalizeDiagnosticLane,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "../api.js";
import { normalizeOtelErrorMessage } from "./service-content-normalization.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { HarnessRunDiagnosticEvent, ModelFailoverDiagnosticEvent } from "./service-types.js";

function harnessTiming(evt: HarnessRunDiagnosticEvent) {
  const timing = evt.type === "harness.run.started" ? undefined : evt.timing;
  if (
    timing?.clock !== "process-monotonic" ||
    !Number.isSafeInteger(timing.startedAtUnixMs) ||
    timing.startedAtUnixMs < 0 ||
    !Number.isSafeInteger(timing.endedAtUnixMs) ||
    timing.endedAtUnixMs < 0
  ) {
    return undefined;
  }
  const elapsedMs = timing.elapsedMs;
  return {
    ...timing,
    elapsedMs:
      typeof elapsedMs === "number" &&
      Number.isSafeInteger(elapsedMs) &&
      elapsedMs >= 0 &&
      elapsedMs <= 86_400_000
        ? elapsedMs
        : undefined,
  };
}

function harnessTimingAttrs(timing: ReturnType<typeof harnessTiming>) {
  return timing
    ? {
        "openclaw.harness.timing.clock": timing.clock,
        ...(timing.elapsedMs !== undefined
          ? { "openclaw.harness.timing.elapsed_ms": timing.elapsedMs }
          : {}),
        // OTel normalizes an end before start to zero duration. Preserve both raw
        // producer observations before ending the span; elapsed never moves them.
        "openclaw.harness.timing.started_at_unix_ms": timing.startedAtUnixMs,
        "openclaw.harness.timing.ended_at_unix_ms": timing.endedAtUnixMs,
      }
    : {};
}

export function createHarnessRecorders(runtime: DiagnosticsRecorderRuntime) {
  const {
    harnessDurationHistogram,
    modelFailoverCounter,
    activeTrustedSpans,
    spanWithDuration,
    trustedTraceContext,
    activeTrustedParentContext,
    trackTrustedSpan,
    setSpanAttrs,
    completeTrackedLifecycleSpan,
    addRunAttrs,
    tracesEnabled,
  } = runtime;

  const harnessRunMetricAttrs = (evt: HarnessRunDiagnosticEvent) => ({
    "openclaw.harness.id": normalizeDiagnosticValue(evt.harnessId, "unknown"),
    "openclaw.harness.plugin": normalizeDiagnosticValue(evt.pluginId),
    ...(evt.type === "harness.run.started"
      ? {}
      : {
          "openclaw.outcome": evt.type === "harness.run.error" ? "error" : evt.outcome,
        }),
    "openclaw.provider": normalizeDiagnosticValue(evt.provider, "unknown"),
    "openclaw.model": normalizeDiagnosticValue(evt.model, "unknown"),
    ...(evt.channel ? { "openclaw.channel": normalizeDiagnosticValue(evt.channel) } : {}),
  });

  const recordHarnessRunStarted = (
    evt: Extract<DiagnosticEventPayload, { type: "harness.run.started" }>,
    metadata: DiagnosticEventMetadata,
  ) => {
    if (!tracesEnabled || !metadata.trusted) {
      return;
    }
    trackTrustedSpan(
      evt,
      metadata,
      spanWithDuration("openclaw.harness.run", harnessRunMetricAttrs(evt), undefined, {
        parentContext: activeTrustedParentContext(evt, metadata),
        startTimeMs: evt.ts,
      }),
      "harness.run",
    );
  };

  const recordHarnessRunCompleted = (
    evt: Extract<DiagnosticEventPayload, { type: "harness.run.completed" }>,
    metadata: DiagnosticEventMetadata,
    privateData: DiagnosticEventPrivateData,
  ) => {
    const timing = harnessTiming(evt);
    if (timing?.elapsedMs !== undefined) {
      harnessDurationHistogram.record(timing.elapsedMs, harnessRunMetricAttrs(evt));
    }
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      ...harnessRunMetricAttrs(evt),
      ...harnessTimingAttrs(timing),
    };
    if (evt.resultClassification) {
      spanAttrs["openclaw.harness.result_classification"] = normalizeDiagnosticValue(
        evt.resultClassification,
      );
    }
    if (typeof evt.yieldDetected === "boolean") {
      spanAttrs["openclaw.harness.yield_detected"] = evt.yieldDetected;
    }
    if (evt.replyDisposition === "silent") {
      spanAttrs["openclaw.reply.disposition"] = evt.replyDisposition;
    }
    if (evt.itemLifecycle) {
      spanAttrs["openclaw.harness.items.started"] = evt.itemLifecycle.startedCount;
      spanAttrs["openclaw.harness.items.completed"] = evt.itemLifecycle.completedCount;
      spanAttrs["openclaw.harness.items.active"] = evt.itemLifecycle.activeCount;
    }
    // Redacted message goes on the span only, never the low-cardinality metric attrs.
    const redactedError = normalizeOtelErrorMessage(privateData.errorMessage);
    if (redactedError) {
      spanAttrs["openclaw.error"] = redactedError;
    }
    const trustedTrace = trustedTraceContext(evt, metadata);
    const trackedSpan = trustedTrace?.spanId
      ? activeTrustedSpans.get(trustedTrace.spanId)
      : undefined;
    const span =
      trackedSpan ??
      spanWithDuration("openclaw.harness.run", spanAttrs, evt.durationMs, {
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: timing?.endedAtUnixMs ?? evt.ts,
        startTimeMs: timing?.startedAtUnixMs,
      });
    setSpanAttrs(span, spanAttrs);
    if (evt.outcome === "error") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: redactedError ?? "error",
      });
    }
    if (trackedSpan && trustedTrace?.spanId) {
      completeTrackedLifecycleSpan(trustedTrace, trackedSpan, timing?.endedAtUnixMs ?? evt.ts);
      return;
    }
    runtime.bindTrustedSpan(evt, metadata, span, "harness.run");
    span.end(timing?.endedAtUnixMs ?? evt.ts);
  };

  const recordHarnessRunError = (
    evt: Extract<DiagnosticEventPayload, { type: "harness.run.error" }>,
    metadata: DiagnosticEventMetadata,
    privateData: DiagnosticEventPrivateData,
  ) => {
    const errorType = normalizeDiagnosticValue(evt.errorCategory, "other");
    const attrs = {
      ...harnessRunMetricAttrs(evt),
      "openclaw.harness.phase": evt.phase,
      "openclaw.errorCategory": errorType,
    };
    const timing = harnessTiming(evt);
    if (timing?.elapsedMs !== undefined) {
      harnessDurationHistogram.record(timing.elapsedMs, attrs);
    }
    if (!tracesEnabled) {
      return;
    }
    // Redacted message goes on the span only; attrs above feed the metric.
    const redactedError = normalizeOtelErrorMessage(privateData.errorMessage);
    const spanAttrs: Record<string, string | number | boolean> = {
      ...attrs,
      ...harnessTimingAttrs(timing),
      "error.type": errorType,
      ...(redactedError ? { "openclaw.error": redactedError } : {}),
      ...(evt.cleanupFailed ? { "openclaw.harness.cleanup_failed": true } : {}),
    };
    const trustedTrace = trustedTraceContext(evt, metadata);
    const trackedSpan = trustedTrace?.spanId
      ? activeTrustedSpans.get(trustedTrace.spanId)
      : undefined;
    const span =
      trackedSpan ??
      spanWithDuration("openclaw.harness.run", spanAttrs, evt.durationMs, {
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: timing?.endedAtUnixMs ?? evt.ts,
        startTimeMs: timing?.startedAtUnixMs,
      });
    setSpanAttrs(span, spanAttrs);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: redactedError ?? errorType,
    });
    // Retain on the error path too: for the openclaw harness this span is the only
    // ancestor a late child can attach to, and aborted turns emit no run.completed.
    if (trackedSpan && trustedTrace?.spanId) {
      completeTrackedLifecycleSpan(trustedTrace, trackedSpan, timing?.endedAtUnixMs ?? evt.ts);
      return;
    }
    runtime.bindTrustedSpan(evt, metadata, span, "harness.run");
    span.end(timing?.endedAtUnixMs ?? evt.ts);
  };

  const recordContextAssembled = (
    evt: Extract<DiagnosticEventPayload, { type: "context.assembled" }>,
    metadata: DiagnosticEventMetadata,
  ) => {
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "openclaw.context.message_count": evt.messageCount,
      "openclaw.context.history_text_chars": evt.historyTextChars,
      "openclaw.context.history_image_blocks": evt.historyImageBlocks,
      "openclaw.context.max_message_text_chars": evt.maxMessageTextChars,
      "openclaw.context.system_prompt_chars": evt.systemPromptChars,
      "openclaw.context.prompt_chars": evt.promptChars,
      "openclaw.context.prompt_images": evt.promptImages,
    };
    addRunAttrs(spanAttrs, evt);
    if (evt.contextTokenBudget !== undefined) {
      spanAttrs["openclaw.context.token_budget"] = evt.contextTokenBudget;
    }
    if (evt.reserveTokens !== undefined) {
      spanAttrs["openclaw.context.reserve_tokens"] = evt.reserveTokens;
    }
    const span = spanWithDuration("openclaw.context.assembled", spanAttrs, 0, {
      parentContext: activeTrustedParentContext(evt, metadata),
      endTimeMs: evt.ts,
    });
    span.end(evt.ts);
  };

  const recordModelFailover = (
    evt: ModelFailoverDiagnosticEvent,
    metadata: DiagnosticEventMetadata,
  ) => {
    const metricAttrs: Record<string, string> = {
      "openclaw.failover.reason": normalizeDiagnosticValue(evt.reason, "unknown"),
      "openclaw.failover.suspended":
        evt.suspended === undefined ? "unknown" : String(evt.suspended),
      "openclaw.lane": normalizeDiagnosticLane(evt.lane, "unknown"),
      "openclaw.model": normalizeDiagnosticValue(evt.fromModel),
      "openclaw.provider": normalizeDiagnosticValue(evt.fromProvider),
      "openclaw.failover.to_model": normalizeDiagnosticValue(evt.toModel),
      "openclaw.failover.to_provider": normalizeDiagnosticValue(evt.toProvider),
    };
    modelFailoverCounter.add(1, metricAttrs);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "openclaw.failover.reason": normalizeDiagnosticValue(evt.reason, "unknown"),
    };
    if (evt.fromProvider) {
      spanAttrs["openclaw.provider"] = evt.fromProvider;
    }
    if (evt.fromModel) {
      spanAttrs["openclaw.model"] = evt.fromModel;
    }
    if (evt.toProvider) {
      spanAttrs["openclaw.failover.to_provider"] = evt.toProvider;
    }
    if (evt.toModel) {
      spanAttrs["openclaw.failover.to_model"] = evt.toModel;
    }
    if (evt.lane) {
      spanAttrs["openclaw.lane"] = normalizeDiagnosticLane(evt.lane, "unknown");
    }
    if (evt.suspended !== undefined) {
      spanAttrs["openclaw.failover.suspended"] = evt.suspended;
    }
    if (evt.cascadeDepth !== undefined) {
      spanAttrs["openclaw.failover.cascade_depth"] = evt.cascadeDepth;
    }
    const span = spanWithDuration("openclaw.model.failover", spanAttrs, 0, {
      parentContext: activeTrustedParentContext(evt, metadata),
      endTimeMs: evt.ts,
    });
    span.end(evt.ts);
  };

  return {
    recordHarnessRunStarted,
    recordHarnessRunCompleted,
    recordHarnessRunError,
    recordContextAssembled,
    recordModelFailover,
  };
}
