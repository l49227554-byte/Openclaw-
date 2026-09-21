export type ChatAbortRequestResult =
  | { ok: true; noActiveRun: boolean; warning?: string }
  | { ok: false; error: unknown };

/**
 * Only an explicit Gateway "nothing to abort" answer counts: chat.abort
 * reports `aborted: false`, sessions.abort reports `status: "no-active-run"`.
 */
export function readChatAbortResponse(
  response: unknown,
): Extract<ChatAbortRequestResult, { ok: true }> {
  if (!response || typeof response !== "object") {
    return { ok: true, noActiveRun: false };
  }
  const noActiveRun =
    ("aborted" in response && response.aborted === false) ||
    ("status" in response && response.status === "no-active-run");
  const warning = "warning" in response ? response.warning : undefined;
  return {
    ok: true,
    noActiveRun,
    ...(typeof warning === "string" && warning.trim() ? { warning } : {}),
  };
}
