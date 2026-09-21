import { readErrorName } from "@openclaw/normalization-core/error-coercion";
import { asOptionalObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createConfiguredGatewayLocalProbe,
  normalizeGatewayHttpProbeHost,
  requestGatewayLocalHttpProbe,
} from "../../gateway/local-http-probe.js";
import {
  GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS,
  GatewayLockError,
  isGatewayLifecycleContentionError,
} from "../../infra/gateway-lock.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { sleep as sleepWithSignal } from "../../utils/sleep.js";

const SUPERVISED_GATEWAY_LOCK_RETRY_MS = 5000;
const SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS = 1000;
const EXIT_CONFIG_ERROR = 78;
type GatewayRunLogger = Pick<SubsystemLogger, "info" | "warn">;

export function isGatewayLockError(err: unknown): boolean {
  return err instanceof GatewayLockError || readErrorName(err) === "GatewayLockError";
}

function isGatewayRetryableLockError(err: unknown): boolean {
  if (!isGatewayLockError(err)) {
    return false;
  }
  const message = asOptionalObjectRecord(err)?.message;
  if (typeof message !== "string") {
    return false;
  }
  return (
    isGatewayLifecycleContentionError(err) ||
    message.includes("gateway already running") ||
    message.includes("another gateway instance is already listening")
  );
}

class SupervisedGatewayLockError extends GatewayLockError {
  constructor(
    message: string,
    cause: unknown,
    readonly exitCode: 1 | typeof EXIT_CONFIG_ERROR,
  ) {
    super(message, cause);
  }
}

export function resolveGatewayLockErrorExitCode(err: unknown): number {
  return err instanceof SupervisedGatewayLockError ? err.exitCode : 1;
}

export const normalizeGatewayHealthProbeHost = normalizeGatewayHttpProbeHost;

export function isGatewayHealthzResponse(statusCode: number | undefined, body: string): boolean {
  if (statusCode !== 200) {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(body);
    return isRecord(payload) && payload.ok === true && payload.status === "live";
  } catch {
    return false;
  }
}

export async function probeGatewayHealthz(params: {
  host: string;
  port: number;
  timeoutMs?: number;
  tlsFingerprint?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  const timeoutMs = params.timeoutMs ?? SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS;
  const result = await requestGatewayLocalHttpProbe({
    ...params,
    pathname: "/healthz",
    timeoutMs,
  });
  return isGatewayHealthzResponse(result?.statusCode, result?.body ?? "");
}

export function createConfiguredGatewayHealthProbe(cfg: OpenClawConfig) {
  const probe = createConfiguredGatewayLocalProbe(cfg);
  return async (params: { host: string; port: number; signal?: AbortSignal }): Promise<boolean> => {
    const result = await probe.requestHttp({
      ...params,
      pathname: "/healthz",
      timeoutMs: SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS,
    });
    return isGatewayHealthzResponse(result?.statusCode, result?.body ?? "");
  };
}

export async function runGatewayLoopWithSupervisedLockRecovery(params: {
  startLoop: (lifecycleDeadlineMs?: number) => Promise<void>;
  supervisor: RespawnSupervisor | null;
  port: number;
  healthHost: string;
  log: GatewayRunLogger;
  startupSignal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  probeHealth?: (params: { host: string; port: number; signal?: AbortSignal }) => Promise<boolean>;
  retryMs?: number;
  timeoutMs?: number;
}) {
  params.startupSignal?.throwIfAborted();
  const supervisor = params.supervisor;
  if (!supervisor) {
    await params.startLoop();
    return;
  }

  const now = params.now ?? performance.now.bind(performance);
  const sleep = params.sleep ?? sleepWithSignal;
  const probeHealth = params.probeHealth ?? ((probeParams) => probeGatewayHealthz(probeParams));
  const retryMs = params.retryMs ?? SUPERVISED_GATEWAY_LOCK_RETRY_MS;
  const timeoutMs = params.timeoutMs ?? GATEWAY_LIFECYCLE_LOCK_TIMEOUT_MS;
  const startedAt = now();

  for (;;) {
    params.startupSignal?.throwIfAborted();
    try {
      // Acquisition and supervised recovery spend the same monotonic budget.
      await params.startLoop(startedAt + timeoutMs);
      return;
    } catch (err) {
      if (!isGatewayRetryableLockError(err)) {
        throw err;
      }

      const lifecycleContention = isGatewayLifecycleContentionError(err);
      const healthy =
        !lifecycleContention &&
        (await probeHealth({
          host: params.healthHost,
          port: params.port,
          ...(params.startupSignal ? { signal: params.startupSignal } : {}),
        }));
      params.startupSignal?.throwIfAborted();
      if (healthy) {
        if (supervisor === "systemd") {
          throw new SupervisedGatewayLockError(
            "gateway already running under systemd; existing gateway is healthy, exiting with code 78 to prevent a systemd Restart=always loop",
            err,
            EXIT_CONFIG_ERROR,
          );
        }
        params.log.info(
          `gateway already running under ${supervisor}; existing gateway is healthy, leaving it in control`,
        );
        return;
      }

      const elapsedMs = now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        if (lifecycleContention) {
          throw err;
        }
        throw new SupervisedGatewayLockError(
          `gateway already running under ${supervisor}; existing gateway did not become healthy after ${timeoutMs}ms`,
          err,
          1,
        );
      }

      const waitMs = Math.min(retryMs, Math.max(0, timeoutMs - elapsedMs));
      params.log.warn(
        `${lifecycleContention ? "gateway-lifecycle ownership held by another OpenClaw process" : "gateway already running"} under ${supervisor}; waiting ${waitMs}ms before retrying startup`,
      );
      await sleep(waitMs, params.startupSignal);
    }
  }
}
