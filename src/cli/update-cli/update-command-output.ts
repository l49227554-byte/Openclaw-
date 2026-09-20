import {
  createUpdateDoctorConfigWarningStep,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import { defaultRuntime } from "../../runtime.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";

export function logUpdateWarnings(
  warnings: readonly { message: string }[],
  jsonMode: boolean,
): void {
  for (const warning of warnings) {
    defaultRuntime[jsonMode ? "error" : "log"](warning.message);
  }
}

export function appendUpdateDoctorConfigWarning(
  root: string,
  changes: UpdateDoctorConfigChange[],
  steps: ReturnType<typeof createUpdateDoctorConfigWarningStep>[],
  progress: MutableUpdateExecutionParams["progress"],
): void {
  const warning = createUpdateDoctorConfigWarningStep(root, changes);
  steps.push(warning);
  progress?.onStepComplete?.({ ...warning, index: 0, total: 0 });
}
