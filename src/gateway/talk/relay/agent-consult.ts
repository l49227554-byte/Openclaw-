import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import type { TalkAgentConsultRequest } from "../client-agent-consult.types.js";
import type { RelaySession } from "./state.js";
import { beginRelayAssistantTranscriptHold } from "./voice.js";

type RelayAgentConsultRunner = RealtimeVoiceAgentConsultRunner & {
  adoptCompletionClaims: () => void;
  claimAppend: () => boolean;
  claimFailureAppend: () => boolean;
  revokeRequesterFinal?: () => void;
  steer?: RealtimeVoiceAgentConsultRunner;
};

export function bindTalkRealtimeRelayAgentConsult(
  runPrompt: RelayAgentConsultRunner,
  getRelay: () => RelaySession | undefined,
  waitForTranscript: (signal?: AbortSignal) => Promise<void>,
) {
  const isCurrent = () => getRelay() !== undefined;
  const runAgentConsult = async (request: TalkAgentConsultRequest) => {
    if (!isCurrent()) {
      throw new Error("Realtime gateway-relay session is closed");
    }
    // Provider-driven consults never pass through talk.client.toolCall, so this wrapper is
    // their hold owner. It opens before the readiness flush: a final admitted during that
    // flush would otherwise persist after the keyed user turn and fail its adoption.
    const release = beginRelayAssistantTranscriptHold(getRelay());
    try {
      await waitForTranscript(request.signal);
      if (!isCurrent()) {
        throw new Error("Realtime gateway-relay session is closed");
      }
      return await runPrompt(request);
    } finally {
      release();
    }
  };
  const steer = runPrompt.steer;
  const lifecycleMethods = {
    adoptCompletionClaims: () => runPrompt.adoptCompletionClaims(),
    claimAppend: () => {
      const current = isCurrent();
      const claimed = runPrompt.claimAppend();
      return current && claimed;
    },
    claimFailureAppend: () => {
      const current = isCurrent();
      const claimed = runPrompt.claimFailureAppend();
      return current && claimed;
    },
    revokeRequesterFinal: () => runPrompt.revokeRequesterFinal?.(),
    ...(steer
      ? {
          steer: async (request: Parameters<RealtimeVoiceAgentConsultRunner>[0]) => {
            if (!isCurrent()) {
              throw new Error("Realtime relay session is no longer active");
            }
            await waitForTranscript(request.signal);
            if (!isCurrent()) {
              throw new Error("Realtime relay session is no longer active");
            }
            const release = beginRelayAssistantTranscriptHold(getRelay());
            try {
              return await steer(request);
            } finally {
              release();
            }
          },
        }
      : {}),
  };
  return Object.assign(runAgentConsult, lifecycleMethods);
}
