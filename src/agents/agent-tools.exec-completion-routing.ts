import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type EventSessionRoutingPolicy,
  resolveEventSessionRoutingPolicy,
} from "../infra/event-session-routing.js";

export type ExecCompletionSessionGeneration = {
  sessionId: string;
  lifecycleRevision?: string;
};

export type AgentRunIdentityOptions = {
  sessionId?: string;
  runId?: string;
  trigger?: string;
  jobId?: string;
  memoryFlushWritePath?: string;
};

export type ExecCompletionRoutingOptions = {
  agentAccountId?: string;
  sessionKey?: string;
  runSessionKey?: string;
  execCompletionSessionKey?: string;
  execCompletionSessionGeneration?: ExecCompletionSessionGeneration;
};

export function resolveExecCompletionRouting(
  options?: ExecCompletionRoutingOptions & {
    config?: OpenClawConfig;
    messageProvider?: string;
  },
): {
  notifySessionKey?: string;
  eventRouting: EventSessionRoutingPolicy;
} {
  const notifySessionKey =
    options?.execCompletionSessionKey ?? options?.runSessionKey ?? options?.sessionKey;
  return {
    notifySessionKey,
    eventRouting: {
      ...resolveEventSessionRoutingPolicy({
        cfg: options?.config,
        sessionKey: notifySessionKey,
        channel: options?.messageProvider,
        accountId: options?.agentAccountId,
      }),
      ...(options?.execCompletionSessionKey &&
      options.execCompletionSessionKey !== (options.runSessionKey ?? options.sessionKey)
        ? {
            isolateCompletionRun: true,
            expectedSessionGeneration: options.execCompletionSessionGeneration,
            sessionStore: options.config?.session?.store,
          }
        : {}),
    },
  };
}
