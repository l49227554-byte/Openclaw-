import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import type { ImageContent } from "../agents/command/types.js";
import type { ClientToolDefinition } from "../agents/embedded-agent-runner/run/params.js";
import type { CliDeps } from "../cli/deps.types.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../runtime.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

/** Run a Gateway agent turn for one OpenResponses request. */
export async function runOpenResponsesAgentCommand(params: {
  message: string;
  images: ImageContent[];
  clientTools: ClientToolDefinition[];
  extraSystemPrompt: string;
  modelOverride?: string;
  streamParams: { maxTokens?: number; temperature?: number; topP?: number } | undefined;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  deps: CliDeps;
  resolveGatewayContext?: GatewayContextResolver;
  abortSignal?: AbortSignal;
}) {
  return agentCommandFromGatewayIngress(
    {
      message: params.message,
      images: params.images.length > 0 ? params.images : undefined,
      clientTools: params.clientTools.length > 0 ? params.clientTools : undefined,
      extraSystemPrompt: params.extraSystemPrompt || undefined,
      model: params.modelOverride,
      streamParams: params.streamParams ?? undefined,
      sessionKey: params.sessionKey,
      runId: params.runId,
      deliver: false,
      messageChannel: params.messageChannel,
      senderIsOwner: params.senderIsOwner,
      bestEffortDeliver: false,
      allowModelOverride: params.modelOverride !== undefined,
      abortSignal: params.abortSignal,
      // Same candidate-local opt-in as Chat Completions: each fallback attempt
      // recomputes promptMode from that model's effective tools profile.
      promptModeFromToolsProfile: true,
      ...(params.resolveGatewayContext
        ? {
            onAdmittedRunContext: (context: AdmittedRunContext) =>
              bindGatewayContextResolver(context, params.resolveGatewayContext),
          }
        : {}),
    },
    defaultRuntime,
    params.deps,
    {},
  );
}
