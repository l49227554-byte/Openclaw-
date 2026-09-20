import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayConnectionDetails } from "./connection-details.js";

export type GatewayTransportErrorKind = "closed" | "timeout";

export class GatewayTransportError extends Error {
  readonly kind: GatewayTransportErrorKind;
  readonly connectionDetails: GatewayConnectionDetails;
  readonly code?: number;
  readonly reason?: string;
  readonly timeoutMs?: number;

  constructor(params: {
    kind: GatewayTransportErrorKind;
    message: string;
    connectionDetails: GatewayConnectionDetails;
    code?: number;
    reason?: string;
    timeoutMs?: number;
  }) {
    super(params.message);
    this.name = "GatewayTransportError";
    this.kind = params.kind;
    this.connectionDetails = params.connectionDetails;
    if (params.code !== undefined) {
      this.code = params.code;
    }
    if (params.reason !== undefined) {
      this.reason = params.reason;
    }
    if (params.timeoutMs !== undefined) {
      this.timeoutMs = params.timeoutMs;
    }
  }
}

export function isGatewayTransportError(value: unknown): value is GatewayTransportError {
  if (value instanceof GatewayTransportError) {
    return true;
  }
  if (!(value instanceof Error) || value.name !== "GatewayTransportError") {
    return false;
  }
  return (
    "kind" in value &&
    (value.kind === "closed" || value.kind === "timeout") &&
    "connectionDetails" in value &&
    typeof value.connectionDetails === "object" &&
    value.connectionDetails !== null
  );
}

/**
 * Shared by every transport failure that interrupts an already-dispatched request,
 * so the deadline and close formatters cannot drift apart on the same uncertainty.
 */
const DISPATCHED_REQUEST_OUTCOME_GUIDANCE =
  "The request was already sent to the gateway, so the operation may have been applied " +
  "even though no response arrived; its outcome is unknown. " +
  "Verify the current state (for example, re-run the equivalent read-only command) " +
  "before retrying, especially for write actions.";

/** Format the wrapper-deadline message, flagging dispatched requests whose outcome is unknown. */
function formatGatewayTimeoutError(
  timeoutMs: number,
  connectionDetails: GatewayConnectionDetails,
  requestDispatched: boolean,
): string {
  const message = `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
  return requestDispatched ? `${message}\n\n${DISPATCHED_REQUEST_OUTCOME_GUIDANCE}` : message;
}

/** Format the close message, flagging dispatched requests whose outcome is unknown. */
function formatGatewayCloseError(
  code: number,
  reason: string,
  connectionDetails: GatewayConnectionDetails,
  requestDispatched: boolean,
): string {
  const reasonText = normalizeOptionalString(reason) || "no close reason";
  const hint =
    code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
  const suffix = hint ? ` ${hint}` : "";
  let message = `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
  if (code === 1006) {
    // Handshake-phase causes cannot explain a close that arrives after the request was
    // sent, and their bare retry advice is what a dispatched write must not be given
    // while its outcome is unknown.
    message += [
      "",
      "",
      "Possible causes:",
      requestDispatched
        ? "- Connection dropped without a close frame (check network and gateway load)"
        : "- Connection dropped without a close frame (retry; check network and gateway load)",
      ...(requestDispatched
        ? []
        : [
            "- Gateway not yet ready to accept connections (retry after a moment)",
            "- TLS mismatch (connecting with ws:// to a wss:// gateway, or vice versa)",
          ]),
      "- Gateway process stopped or became unreachable (confirm it is still running)",
      "Run `openclaw doctor` for diagnostics.",
    ].join("\n");
  }
  return requestDispatched ? `${message}\n\n${DISPATCHED_REQUEST_OUTCOME_GUIDANCE}` : message;
}

/** Raise a connection close, carrying whether the request had already been dispatched. */
export function createGatewayCloseTransportError(params: {
  code: number;
  reason: string;
  connectionDetails: GatewayConnectionDetails;
  requestDispatched: boolean;
}): GatewayTransportError {
  return new GatewayTransportError({
    kind: "closed",
    code: params.code,
    reason: normalizeOptionalString(params.reason) || "no close reason",
    connectionDetails: params.connectionDetails,
    message: formatGatewayCloseError(
      params.code,
      params.reason,
      params.connectionDetails,
      params.requestDispatched,
    ),
  });
}

/** Raise a wrapper deadline, carrying whether the request had already been dispatched. */
export function createGatewayTimeoutTransportError(params: {
  timeoutMs: number;
  connectionDetails: GatewayConnectionDetails;
  requestDispatched: boolean;
}): GatewayTransportError {
  const { timeoutMs, connectionDetails, requestDispatched } = params;
  return new GatewayTransportError({
    kind: "timeout",
    timeoutMs,
    connectionDetails,
    message: formatGatewayTimeoutError(timeoutMs, connectionDetails, requestDispatched),
  });
}

/** Transport uncertainty permits read recovery or an exclusively ownership-locked mutation. */
export function isGatewayRpcUnavailableError(error: unknown): boolean {
  if (isGatewayTransportError(error)) {
    return error.kind === "timeout" || [undefined, 1006, 1012].includes(error.code);
  }
  // Pending protocol requests still surface these exact transport failures as plain Errors.
  return (
    error instanceof Error &&
    error.name === "Error" &&
    (/^gateway closed \((?:1006|1012)\): [^\r\n]*$/u.test(error.message) ||
      /^gateway timeout after \d+ms(?:\n[\s\S]*)?$/u.test(error.message))
  );
}
