import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

/** Assemble the before_tool_call hook context without changing wrap order. */
export function resolveOpenClawToolsHookContext(params: {
  hookAgentId?: string;
  resolvedConfig?: OpenClawConfig;
  options?: OpenClawToolsOptions;
}): HookContext {
  const { hookAgentId, resolvedConfig, options } = params;
  return {
    ...(hookAgentId ? { agentId: hookAgentId } : {}),
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.currentChannelId ? { channelId: options.currentChannelId } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: resolvedConfig, agentId: hookAgentId }),
    ...options?.beforeToolCallHookContext,
  };
}
