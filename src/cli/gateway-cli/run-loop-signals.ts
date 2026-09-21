import {
  registerGatewayInstallationReplacementHandler,
  type GatewayInstallationReplacement,
} from "../../gateway/stale-install.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { formatCliCommand } from "../command-format.js";

/** Install the run loop's process handlers as one owner after startup lock acquisition. */
export function installGatewayRunSignalHandlers(params: {
  onSigterm: () => void;
  onSigint: () => void;
  onRestartSignal: () => void;
  onInstallationReplacement: (fact: GatewayInstallationReplacement) => void;
  requestRestart: (reason: string) => void;
  supervised: boolean;
  logger: Pick<SubsystemLogger, "warn" | "error">;
}): () => void {
  const releaseInstallationObserver = registerGatewayInstallationReplacementHandler((fact) => {
    params.onInstallationReplacement(fact);
    params.logger.warn(fact.message);
    if (!params.supervised) {
      params.logger.error(
        `The foreground Gateway must stop after its installation was replaced. Restart it with: ${formatCliCommand("openclaw gateway run")}`,
      );
    }
    params.requestRestart(fact.reason);
  });
  process.on("SIGTERM", params.onSigterm);
  process.on("SIGINT", params.onSigint);
  // SIGUSR1 belongs to Node's on-demand inspector; never register a listener for it.
  process.on("SIGUSR2", params.onRestartSignal);
  return () => {
    releaseInstallationObserver();
    process.removeListener("SIGTERM", params.onSigterm);
    process.removeListener("SIGINT", params.onSigint);
    process.removeListener("SIGUSR2", params.onRestartSignal);
  };
}
