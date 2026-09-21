import { withContinuationOwner } from "../auto-reply/continuation/system-event-ownership.js";
import { hasCrossSessionDelegateTargeting } from "../auto-reply/continuation/targeting-pure.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../infra/system-events.js";
import { defaultRuntime } from "../runtime.js";

export async function rejectOwnedCrossSessionTargeting(params: {
  crossSessionTargeting: "disabled" | "enabled";
  dispatchingSessionKey: string;
  eventSessionKey: string;
  ownerAgentId?: string;
  source: "bracket" | "tool";
  targeting: {
    targetSessionKey?: string;
    targetSessionKeys?: readonly string[];
    fanoutMode?: "tree" | "all";
  };
  task: string;
}): Promise<boolean> {
  if (
    params.crossSessionTargeting !== "disabled" ||
    !hasCrossSessionDelegateTargeting(params.targeting, params.dispatchingSessionKey)
  ) {
    return false;
  }
  defaultRuntime.log(
    `[subagent-chain-hop] Cross-session targeting rejected by policy for ${params.source} delegate in session ${params.dispatchingSessionKey}`,
  );
  enqueueSystemEvent(
    "[continuation] Delegate rejected: cross-session targeting is disabled by policy. " +
      'Use the default return target, targetSessionKey set to this session, or fanoutMode="tree". ' +
      `Task: ${params.task}`,
    withContinuationOwner(
      { sessionKey: params.eventSessionKey, trusted: true },
      params.ownerAgentId,
    ),
  );
  return true;
}

export function reportOwnedDelegateAdmissionFailure(params: {
  childSessionKey: string;
  eventSessionKey: string;
  ownerAgentId?: string;
}): void {
  defaultRuntime.error?.(
    `[continuation:delegate-admission-failed] child=${params.childSessionKey}`,
  );
  enqueueSystemEvent(
    "[continuation] Delegate was not scheduled because durable TaskFlow admission failed. Retry the delegation.",
    withContinuationOwner(
      { sessionKey: params.eventSessionKey, trusted: true },
      params.ownerAgentId,
    ),
  );
}
