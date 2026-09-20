import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  isHeartbeatContentEffectivelyEmpty,
} from "../auto-reply/heartbeat.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readHeartbeatMonitorScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "../sessions/session-state-event-kinds.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { formatErrorMessage } from "./errors.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
  isHeartbeatDeliveryAwarenessEvent,
  isRelayableExecCompletionEvent,
} from "./heartbeat-events-filter.js";
import { heartbeatLog as log } from "./heartbeat-log.js";
import {
  resolveConfiguredHeartbeatPrompt,
  resolveHeartbeatResponseToolPrompt,
} from "./heartbeat-runner-config.js";
import { resolveHeartbeatSessionSelection } from "./heartbeat-runner-session.js";
import {
  resolveHeartbeatWakePayloadFlags,
  type HeartbeatWakePayloadFlags,
} from "./heartbeat-wake-policy.js";
import {
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  type HeartbeatScheduledTask,
  type HeartbeatWakeSource,
} from "./heartbeat-wake.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import {
  peekSystemEventEntries,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
} from "./system-events.js";

export function truncateHeartbeatPreview(value: string | undefined): string | undefined {
  return value ? truncateUtf16Safe(value, 200) : undefined;
}

type HeartbeatSkipReason = "empty-heartbeat-file" | typeof HEARTBEAT_SKIP_NO_PENDING_EVENT;

export type HeartbeatPreflight = HeartbeatWakePayloadFlags & {
  session: ReturnType<typeof resolveHeartbeatSessionSelection>;
  pendingEventEntries: ReturnType<typeof peekSystemEventEntries>;
  turnSourceDeliveryContext: ReturnType<typeof resolveSystemEventDeliveryContext>;
  hasTaggedCronEvents: boolean;
  shouldInspectPendingEvents: boolean;
  authoritativeScheduledTick: boolean;
  skipReason?: HeartbeatSkipReason;
  scratchJobId?: string;
  scratchRevision?: number;
  heartbeatScratchContent?: string;
};

/**
 * Terminal no-op preflight (empty scratch, consumed exec events) must resolve
 * before retryable busy guards; wakes carrying heartbeat tasks keep deferral.
 */
export function shouldPreflightWakeBeforeBusy(
  source: HeartbeatWakeSource | undefined,
  scheduledEveryMs: number | undefined,
  scheduledTaskCount: number,
): boolean {
  return (
    scheduledTaskCount === 0 &&
    (source === "interval" ||
      (source === "exec-event" &&
        !(
          typeof scheduledEveryMs === "number" &&
          Number.isSafeInteger(scheduledEveryMs) &&
          scheduledEveryMs > 0
        )))
  );
}

export async function resolveHeartbeatPreflight(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  sessionKey?: string;
  reason?: string;
  source?: HeartbeatWakeSource;
  scheduledEveryMs?: number;
  scheduledTasks?: readonly HeartbeatScheduledTask[];
}): Promise<HeartbeatPreflight> {
  const wakeFlags = resolveHeartbeatWakePayloadFlags({
    source: params.source,
    reason: params.reason,
  });
  const session = resolveHeartbeatSessionSelection(
    params.cfg,
    params.agentId,
    params.heartbeat,
    params.sessionKey,
  );
  const pendingEventEntries = peekSystemEventEntries(
    resolveSystemEventQueueKey(session.sessionKey, params.agentId),
  ).filter((event) => !isHeartbeatDeliveryAwarenessEvent(event));
  const turnSourceDeliveryContext = resolveSystemEventDeliveryContext(pendingEventEntries);
  const hasTaggedCronEvents = pendingEventEntries.some((event) =>
    event.contextKey?.startsWith("cron:"),
  );
  // The selected queue follows isolated execution into reply admission; the base queue does not.
  const shouldInspectWakePendingEvents = wakeFlags.isWakePayload && session.inspectsRunQueue;
  const shouldInspectPendingEvents =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    shouldInspectWakePendingEvents ||
    hasTaggedCronEvents;
  const shouldBypassScratchGates =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    wakeFlags.isWakePayload ||
    hasTaggedCronEvents;
  let monitorScratch: ReturnType<typeof readHeartbeatMonitorScratch>;
  try {
    monitorScratch = readHeartbeatMonitorScratch(
      resolveCronJobsStorePathFromConfig(params.cfg),
      params.agentId,
    );
  } catch (error) {
    log.warn(`heartbeat: scratch read failed: ${formatErrorMessage(error)}`);
  }
  const heartbeatScratchContent = monitorScratch?.state.scratch?.content;
  const basePreflight = {
    ...wakeFlags,
    session,
    pendingEventEntries,
    turnSourceDeliveryContext,
    hasTaggedCronEvents,
    shouldInspectPendingEvents,
    authoritativeScheduledTick:
      typeof params.scheduledEveryMs === "number" &&
      Number.isSafeInteger(params.scheduledEveryMs) &&
      params.scheduledEveryMs > 0,
    ...(monitorScratch?.jobId
      ? {
          scratchJobId: monitorScratch.jobId,
          scratchRevision: monitorScratch.state.currentRevision,
        }
      : {}),
    // Bypass scopes (cron/exec events and wake payloads) stay
    // self-contained: only the job identity travels so heartbeat_respond can
    // still persist scratch, never the monitor instructions themselves.
    ...(!shouldBypassScratchGates && heartbeatScratchContent !== undefined
      ? { heartbeatScratchContent }
      : {}),
  } satisfies Omit<HeartbeatPreflight, "skipReason">;

  // The exec completion can be acknowledged by process poll after its wake is
  // queued. Treat that stale wake as consumed without touching unrelated events.
  if (
    wakeFlags.isExecEventWake &&
    !basePreflight.authoritativeScheduledTick &&
    !params.scheduledTasks?.length &&
    !hasTaggedCronEvents &&
    !pendingEventEntries.some((event) => isExecCompletionEvent(event.text))
  ) {
    return {
      ...basePreflight,
      skipReason: HEARTBEAT_SKIP_NO_PENDING_EVENT,
    };
  }
  if (shouldBypassScratchGates) {
    return basePreflight;
  }
  // Cron owns task due-ness. Task wakes still receive ordinary scratch prose,
  // but empty or missing scratch must never suppress the independently scheduled job.
  if (params.scheduledTasks?.length) {
    return basePreflight;
  }
  if (heartbeatScratchContent === undefined) {
    // Without scratch, the model still gets the generic monitor prompt and
    // decides whether anything needs attention.
    return basePreflight;
  }
  if (isHeartbeatContentEffectivelyEmpty(heartbeatScratchContent)) {
    return {
      ...basePreflight,
      skipReason: "empty-heartbeat-file",
    };
  }
  return basePreflight;
}

type HeartbeatPromptResolution = {
  prompt: string;
  hasTaskContinuation: boolean;
  hasExecCompletion: boolean;
  hasRelayableExecCompletion: boolean;
  hasCronEvents: boolean;
  usesHeartbeatResponseTool: boolean;
  genericEvents: SystemEvent[];
  inspectedSystemEventsToConsume: SystemEvent[];
};

/** Appends monitor scratch prose to the generated heartbeat prompt. */
function appendHeartbeatScratch(prompt: string, heartbeatScratchContent?: string): string {
  if (!heartbeatScratchContent) {
    return prompt;
  }
  const directives = heartbeatScratchContent.trim();
  if (!directives || prompt.includes(directives)) {
    return prompt;
  }
  return `${prompt}\n\nHeartbeat monitor scratch:\n${directives}`;
}

export type HeartbeatTurnEventSelection = {
  execEvents: SystemEvent[];
  cronEvents: SystemEvent[];
  cronNoise: SystemEvent[];
  genericEvents: SystemEvent[];
  turnSourceDeliveryContext?: DeliveryContext;
};

function selectRouteCompatibleEventCohort(events: readonly SystemEvent[]): {
  events: SystemEvent[];
  turnSourceDeliveryContext?: DeliveryContext;
} {
  let authority: DeliveryContext | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]?.deliveryContext;
    if (candidate) {
      authority = candidate;
      break;
    }
  }
  if (!authority) {
    return { events: [...events] };
  }
  const authorityKey = channelRouteDedupeKey(authority);
  const selected = events.filter(
    (event) =>
      event.deliveryContext === undefined ||
      channelRouteDedupeKey(event.deliveryContext) === authorityKey,
  );
  return {
    events: selected,
    turnSourceDeliveryContext: resolveSystemEventDeliveryContext(selected),
  };
}

/**
 * Generic queue content rides along with a dedicated cohort only when it cannot
 * redirect the turn: the cohort's route owns delivery, so a generic event must
 * carry that same route or carry none at all. Differently routed events stay
 * queued for a wake that owns their conversation.
 */
function selectRouteCompatibleGenericEvents(
  candidates: readonly SystemEvent[],
  authority: DeliveryContext | undefined,
): SystemEvent[] {
  const authorityKey = authority ? channelRouteDedupeKey(authority) : undefined;
  return candidates.filter((event) => {
    if (event.deliveryContext === undefined) {
      return true;
    }
    return (
      authorityKey !== undefined && channelRouteDedupeKey(event.deliveryContext) === authorityKey
    );
  });
}

/**
 * Selects one route-authorized event cohort for this turn. Content admission,
 * delivery authority, and queue consumption must all use this same selection.
 * Differently routed events remain queued for a later wake.
 */
export function resolveHeartbeatTurnEventSelection(params: {
  preflight: HeartbeatPreflight;
  scheduledTasks: readonly HeartbeatScheduledTask[];
}): HeartbeatTurnEventSelection {
  const genericCandidates: SystemEvent[] = [];
  const cronCandidates: SystemEvent[] = [];
  const execCandidates: SystemEvent[] = [];
  const cronNoise: SystemEvent[] = [];

  for (const event of params.preflight.pendingEventEntries) {
    if (event.contextKey?.startsWith(SESSION_CREATED_NOTICE_CONTEXT_PREFIX)) {
      genericCandidates.push(event);
    } else if (isExecCompletionEvent(event.text)) {
      if (params.preflight.shouldInspectPendingEvents) {
        execCandidates.push(event);
      }
    } else if (params.preflight.isCronWake || event.contextKey?.startsWith("cron:")) {
      (isCronSystemEvent(event.text) ? cronCandidates : cronNoise).push(event);
    } else {
      genericCandidates.push(event);
    }
  }

  // A scheduled turn is not event-derived: its authority comes from the job's own
  // configured destination, so no queued event supplies a route to ride along on.
  if (params.scheduledTasks.length > 0) {
    return {
      execEvents: [],
      cronEvents: [],
      cronNoise,
      genericEvents: [],
    };
  }

  const routeAuthority = (selected: { turnSourceDeliveryContext?: DeliveryContext }) =>
    params.preflight.session.inspectsRunQueue ? selected.turnSourceDeliveryContext : undefined;

  if (execCandidates.length > 0) {
    const selected = selectRouteCompatibleEventCohort(execCandidates);
    return {
      execEvents: selected.events,
      // Preserve awareness of queued cron work without admitting or consuming it.
      cronEvents: cronCandidates,
      cronNoise,
      genericEvents: selectRouteCompatibleGenericEvents(
        genericCandidates,
        selected.turnSourceDeliveryContext,
      ),
      turnSourceDeliveryContext: routeAuthority(selected),
    };
  }

  if (cronCandidates.length > 0) {
    const selected = selectRouteCompatibleEventCohort(cronCandidates);
    return {
      execEvents: [],
      cronEvents: selected.events,
      cronNoise,
      genericEvents: selectRouteCompatibleGenericEvents(
        genericCandidates,
        selected.turnSourceDeliveryContext,
      ),
      turnSourceDeliveryContext: routeAuthority(selected),
    };
  }

  const selected = selectRouteCompatibleEventCohort(genericCandidates);
  return {
    execEvents: [],
    cronEvents: [],
    cronNoise,
    genericEvents: selected.events,
    turnSourceDeliveryContext: routeAuthority(selected),
  };
}

export function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  startedAt: number;
  scheduledTasks: readonly HeartbeatScheduledTask[];
  heartbeatScratchContent?: string;
  useHeartbeatResponseTool: boolean;
  eventSelection?: HeartbeatTurnEventSelection;
}): HeartbeatPromptResolution {
  const selection =
    params.eventSelection ??
    resolveHeartbeatTurnEventSelection({
      preflight: params.preflight,
      scheduledTasks: params.scheduledTasks,
    });
  const { genericEvents, cronEvents, execEvents, cronNoise } = selection;
  const hasExecCompletion = execEvents.length > 0;
  const hasRelayableExecCompletion =
    params.canRelayToUser && execEvents.some((event) => isRelayableExecCompletionEvent(event.text));
  const hasCronEvents = cronEvents.length > 0;
  const hasBackgroundTaskEvent =
    params.preflight.session.inspectsRunQueue &&
    genericEvents.some((event) => event.contextKey?.startsWith("task:"));
  if (params.scheduledTasks.length > 0) {
    const taskList = params.scheduledTasks
      .map((task) => `- ${task.name}: ${task.prompt}`)
      .join("\n");
    const completionInstruction = params.useHeartbeatResponseTool
      ? `After completing all due tasks:\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`
      : `After completing all due tasks, reply ${SILENT_REPLY_TOKEN}.`;
    const taskPrompt = `Run the following periodic tasks (only those due based on their intervals):

${taskList}

${completionInstruction}`;
    const prompt = appendHeartbeatScratch(taskPrompt, params.heartbeatScratchContent);
    return {
      prompt,
      // Scheduled work must not coalesce queued generic events whose delivery
      // authority may belong to another conversation. Leave those events queued
      // so their own wake can process them with their original delivery context.
      hasTaskContinuation: false,
      hasExecCompletion: false,
      hasRelayableExecCompletion: false,
      hasCronEvents: false,
      usesHeartbeatResponseTool: params.useHeartbeatResponseTool,
      genericEvents: [],
      inspectedSystemEventsToConsume: cronNoise,
    };
  }

  const baseUsesHeartbeatResponseTool = params.useHeartbeatResponseTool;
  const basePrompt = hasExecCompletion
    ? buildExecEventPrompt(
        execEvents.map((event) => event.text),
        {
          deliverToUser: params.canRelayToUser,
          useHeartbeatResponseTool: baseUsesHeartbeatResponseTool,
        },
      )
    : hasCronEvents
      ? buildCronEventPrompt(
          cronEvents.map((event) => event.text),
          {
            deliverToUser: params.canRelayToUser,
            useHeartbeatResponseTool: baseUsesHeartbeatResponseTool,
          },
        )
      : baseUsesHeartbeatResponseTool
        ? resolveHeartbeatResponseToolPrompt(params.cfg, params.heartbeat)
        : resolveConfiguredHeartbeatPrompt(params.cfg, params.heartbeat);
  const basePromptWithDirectives = appendHeartbeatScratch(
    basePrompt,
    params.heartbeatScratchContent,
  );
  return {
    prompt: basePromptWithDirectives,
    hasTaskContinuation:
      hasExecCompletion ||
      hasBackgroundTaskEvent ||
      cronEvents.some((event) => event.contextKey?.startsWith("task:")),
    hasExecCompletion,
    hasRelayableExecCompletion,
    hasCronEvents,
    usesHeartbeatResponseTool: baseUsesHeartbeatResponseTool,
    genericEvents,
    inspectedSystemEventsToConsume: [
      ...cronNoise,
      ...(hasExecCompletion ? execEvents : cronEvents),
    ],
  };
}
