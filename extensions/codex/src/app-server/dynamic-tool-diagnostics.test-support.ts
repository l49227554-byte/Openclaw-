import { startDynamicToolDiagnosticExecution } from "./dynamic-tool-diagnostics.js";

export function emitDynamicToolStartedDiagnostic(
  params: Parameters<typeof startDynamicToolDiagnosticExecution>[0],
): void {
  startDynamicToolDiagnosticExecution(params, () => undefined);
}
