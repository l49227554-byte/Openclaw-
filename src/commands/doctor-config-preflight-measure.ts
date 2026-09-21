import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";

export async function measureDoctorConfigPreflightStep<T>(
  name: string,
  run: () => T | Promise<T>,
  measure?: ConfigSnapshotReadMeasure,
  metrics?: () => Readonly<Record<string, number>>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const tracedRun = () => measureGatewayBootstrapStep(`cli.bootstrap.${name}`, run, metrics);
  try {
    return measure
      ? await measure(`doctor.config-preflight.${name}`, tracedRun)
      : await tracedRun();
  } finally {
    signal?.throwIfAborted();
  }
}

export function createDoctorConfigPreflightMeasure(options: {
  measure?: ConfigSnapshotReadMeasure;
  signal?: AbortSignal;
}) {
  return <T>(name: string, run: () => T | Promise<T>) =>
    measureDoctorConfigPreflightStep(name, run, options.measure, undefined, options.signal);
}
