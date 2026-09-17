import type { AgentStreamParams, ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";

/** Build the Gateway ingress payload for an HTTP Chat Completions turn. */
export function buildOpenAiHttpAgentCommandInput(params: {
  prompt: { message: string; extraSystemPrompt?: string; images?: ImageContent[] };
  clientTools?: ClientToolDefinition[];
  modelOverride?: string;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  abortSignal?: AbortSignal;
  streamParams?: AgentStreamParams;
  promptModeFromToolsProfile?: boolean;
}) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    clientTools: params.clientTools,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false as const,
    messageChannel: params.messageChannel,
    senderIsOwner: params.senderIsOwner,
    bestEffortDeliver: false as const,
    allowModelOverride: params.modelOverride !== undefined,
    abortSignal: params.abortSignal,
    streamParams: params.streamParams,
    // HTTP chat opts into per-attempt derivation so a base tools.profile=minimal
    // does not freeze promptMode; each fallback recomputes from that model.
    promptModeFromToolsProfile: params.promptModeFromToolsProfile,
  };
}
