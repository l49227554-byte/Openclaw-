import { readSessionWorkspaceRecoveryRequiredError } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { confirmContinueSessionOnGateway } from "./session-placement-recovery.runtime.ts";

export function formatBatchSessionRemovalError(error: unknown): string {
  const message = formatUiError(error);
  return readSessionWorkspaceRecoveryRequiredError(error)
    ? `${message} ${t("sessionsView.workspaceRecoveryBatchHint")}`
    : message;
}

/** One explicit loss decision and one retry of the already requested removal. */
export async function withSessionWorkspaceRecovery<T>(params: {
  action: "delete" | "archive";
  session: { key: string; sessionId?: string; label: string; agentId?: string };
  scope: {
    client: Pick<GatewayBrowserClient, "request">;
    gateway: { readonly snapshot: ApplicationGatewaySnapshot };
    signal?: AbortSignal;
  };
  isCurrent: () => boolean;
  request: () => Promise<T>;
}): Promise<T | undefined> {
  if (!params.isCurrent()) {
    return;
  }
  try {
    return await params.request();
  } catch (error) {
    if (!params.isCurrent()) {
      return;
    }
    const details = readSessionWorkspaceRecoveryRequiredError(error);
    if (!details || details.sessionId !== params.session.sessionId) {
      throw error;
    }
    const move = {
      key: params.session.key,
      ...(params.session.agentId ? { agentId: params.session.agentId } : {}),
      expected: details.source,
      target: { kind: "gateway" as const },
      abandonSource: true,
    };
    const authorize = () => {
      const access = readSessionMethodAccess(params.scope.gateway.snapshot, {
        method: "sessions.move",
        params: move,
        requiredScope: "operator.write",
      });
      if (!access.allowed) {
        throw new Error(access.reason, { cause: error });
      }
    };
    authorize();
    const confirmed = await confirmContinueSessionOnGateway({
      label: params.session.label,
      action: params.action,
      signal: params.scope.signal,
    });
    if (!params.isCurrent()) {
      return;
    }
    if (!confirmed) {
      throw error;
    }
    authorize();
    await params.scope.client.request("sessions.move", move);
    if (!params.isCurrent()) {
      return;
    }
    return await params.request();
  }
}
