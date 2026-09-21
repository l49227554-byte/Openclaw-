import type { ClawHubInstallErrorCode } from "./clawhub-error-codes.js";

export type ClawHubInstallFailure = {
  ok: false;
  error: string;
  code?: ClawHubInstallErrorCode;
  warning?: string;
  version?: string;
};

export function buildClawHubInstallFailure(
  error: string,
  code?: ClawHubInstallErrorCode,
  warning?: string,
  version?: string,
): ClawHubInstallFailure {
  return {
    ok: false,
    error,
    ...(code ? { code } : {}),
    ...(warning ? { warning } : {}),
    ...(version ? { version } : {}),
  };
}
