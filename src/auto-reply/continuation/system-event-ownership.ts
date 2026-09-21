import { withSystemEventOwner } from "../../infra/system-event-ownership.js";

export function withContinuationOwner<T extends { sessionKey: string }>(
  options: T,
  ownerAgentId: string | undefined,
): Omit<T, "sessionKey"> & { sessionKey: string } {
  if (!ownerAgentId) {
    throw new Error("Continuation system event owner is unavailable.");
  }
  return withSystemEventOwner(options, ownerAgentId);
}

export function bindContinuationOwner(ownerAgentId: string | undefined) {
  return <T extends { sessionKey: string }>(
    options: T,
  ): Omit<T, "sessionKey"> & { sessionKey: string } => withContinuationOwner(options, ownerAgentId);
}
