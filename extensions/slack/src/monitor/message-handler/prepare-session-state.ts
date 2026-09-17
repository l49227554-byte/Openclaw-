import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionEntry, resolveStorePath } from "../config.runtime.js";

export function resolveSlackSessionState(
  cfg: OpenClawConfig,
  route: { agentId: string },
  sessionKey: string,
) {
  const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
  const sessionEntry = getSessionEntry({ storePath, sessionKey });
  return {
    storePath,
    previousTimestamp: sessionEntry?.updatedAt,
    sessionDisplayName: sessionEntry?.displayName,
  };
}
