import { t } from "../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../i18n/locales/en-session-placement.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";

registerSessionPlacementEnglish();

export async function confirmContinueSessionOnGateway(params: {
  label: string;
  action?: "delete" | "archive";
  signal?: AbortSignal;
}): Promise<boolean> {
  return await showConfirmDialog({
    message: t(
      params.action === "delete"
        ? "sessionsView.discardWorkspaceDeleteConfirm"
        : params.action === "archive"
          ? "sessionsView.discardWorkspaceArchiveConfirm"
          : "sessionsView.continueOnGatewayConfirm",
      { session: params.label },
    ),
    confirmLabel: t(
      params.action === "delete"
        ? "sessionsView.discardWorkspaceDeleteAction"
        : params.action === "archive"
          ? "sessionsView.discardWorkspaceArchiveAction"
          : "sessionsView.continueOnGatewayAction",
    ),
    danger: true,
    signal: params.signal,
  });
}
