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
export const DISPATCHED_REQUEST_OUTCOME_GUIDANCE =
  "The request was already sent to the gateway, so the operation may have been applied " +
  "even though no response arrived; its outcome is unknown. " +
  "Verify the current state (for example, re-run the equivalent read-only command) " +
  "before retrying, especially for write actions.";

/** Format the wrapper-deadline message, flagging dispatched requests whose outcome is unknown. */
export function formatGatewayTimeoutError(
  timeoutMs: number,
  connectionDetails: GatewayConnectionDetails,
  requestDispatched: boolean,
): string {
  const message = `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
  return requestDispatched ? `${message}\n\n${DISPATCHED_REQUEST_OUTCOME_GUIDANCE}` : message;
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
